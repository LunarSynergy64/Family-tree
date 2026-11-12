import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, onSnapshot }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const fb = initializeApp(firebaseConfig);
const fs = getFirestore(fb);

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const keyGet = k => { try { return localStorage.getItem(k); } catch(e) { return null; } };
const keySet = (k,v) => { try { localStorage.setItem(k,v); } catch(e) {} };
const newId = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
const uniq = a => [...new Set(a)];
const byName = (a,b) => (a.name||"").localeCompare(b.name||"");
const dateKey = p => (p.born==null||p.born==="") ? Infinity : Number(p.born)*372 + (p.bornMonth||0)*31 + (p.bornDay||0);
const byBorn = (a,b) => dateKey(a)-dateKey(b) || byName(a,b);
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function formatDate(y,m,d){
  if(y==null || y==="") return null;
  if(m) return d ? `${d} ${MONTHS[m-1]} ${y}` : `${MONTHS[m-1]} ${y}`;
  return `${y}`;
}
// Once someone has died, a quick birth-death YEAR range reads better than
// a full birthday - shown even when full day/month is on record for
// either end, with "?" standing in for a birth year nobody's entered yet.
function deathCompact(p){
  if(p.died==null || p.died==="") return null;
  return `${(p.born!=null && p.born!=="") ? p.born : "?"} – ${p.died}`;
}
const birthKnown = p => (p.born!=null && p.born!=="") || (p.died!=null && p.died!=="");
function birthLabel(p){ return deathCompact(p) || formatDate(p.born,p.bornMonth,p.bornDay) || "Unknown date of Birth"; }
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(toast.t); toast.t=setTimeout(()=>t.hidden=true,3500); }

const fullName = (first, middle, last) => [first, middle, last].map(s=>(s||"").trim()).filter(Boolean).join(" ");
// what's shown on cards/bubbles - p.name itself (the full name, middle
// included) stays the canonical stored/searched/sorted value regardless;
// this only affects what the UI prints.
function displayName(p){
  if(!p) return "";
  if(showMiddleNames || !p.middleName) return p.name||"";
  if(p.firstName || p.lastName) return fullName(p.firstName, "", p.lastName);
  return p.name||"";
}
/* old entries only have a single `name` string - split it heuristically
   (first word = first name, last word = last name) so re-opening one for
   editing doesn't dump their whole name into a single blank field. */
function splitLegacyName(name){
  const w = (name||"").trim().split(/\s+/).filter(Boolean);
  if(!w.length) return {first:"", middle:"", last:""};
  if(w.length===1) return {first:w[0], middle:"", last:""};
  if(w.length===2) return {first:w[0], middle:"", last:w[1]};
  return {first:w[0], middle:w.slice(1,-1).join(" "), last:w[w.length-1]};
}

async function treeKey(name, pass){
  const norm = name.trim().toLowerCase().replace(/\s+/g," ");
  const bytes = new TextEncoder().encode(norm + "\u0000" + pass);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

/* saved trees on this device: [{key, name}] */
const savedTrees = () => { try { return JSON.parse(keyGet("ft-trees")||"[]"); } catch(e) { return []; } };
function saveTree(key, name){ const list = savedTrees().filter(t=>t.key!==key); list.unshift({key,name}); keySet("ft-trees", JSON.stringify(list)); }
function forgetTree(key){ keySet("ft-trees", JSON.stringify(savedTrees().filter(t=>t.key!==key))); }

/* ================= screens ================= */
let tree = null;            // {key, name, defaultFocus}
let unsub = null;
let people = new Map(), focusId = null, trail = [], view = "tree", loaded = false, query = "", offlineNote = "";
let sheetMode = null;
let editCoParents = [], editFormalSpouses = [];
const app = $("#app");
const P = id => people.get(id);
if(keyGet("ft-colorgender")!=="0") app.classList.add("color-gender");
let showMiddleNames = keyGet("ft-showmiddle")==="1";

/* zoom only affects the coordinate-based pedigree grid (the "zoom" CSS
   property rescales its whole layout box, scrollable area included, so
   #app's native scrollbars stay correct at any zoom level - no coordinate
   math to redo, unlike the browser's own page zoom which scales everything
   including the header and dock). */
let zoom = Math.min(1.5, Math.max(0.25, Number(keyGet("ft-zoom")) || 1));
function applyZoom(){ document.documentElement.style.setProperty("--zoom", zoom); }
applyZoom();
$("#zoomIn").addEventListener("click", () => { zoom = Math.min(1.5, +(zoom+0.15).toFixed(2)); applyZoom(); keySet("ft-zoom", zoom); render(); });
$("#zoomOut").addEventListener("click", () => { zoom = Math.max(0.25, +(zoom-0.15).toFixed(2)); applyZoom(); keySet("ft-zoom", zoom); render(); });
$("#zoomReset").addEventListener("click", () => { zoom = 1; applyZoom(); keySet("ft-zoom", zoom); render(); });

function showHome(){
  if(unsub){ unsub(); unsub = null; }
  tree = null; people = new Map(); focusId = null; trail = [];
  history.replaceState(null, "", location.pathname);
  $("#treeScreen").hidden = true; $("#home").hidden = false;
  const list = savedTrees();
  $("#savedWrap").hidden = !list.length;
  $("#savedList").innerHTML = list.map(t => `<button data-open="${esc(t.key)}">${esc(t.name)}<span>Open ›</span></button>`).join("");
  document.title = "Our Family Tree";
}

async function openTree(key, nameHint){
  let snap;
  try { snap = await getDoc(doc(fs, "trees", key)); }
  catch(e){ toast("Couldn't reach the family tree server. Check your connection."); return false; }
  if(!snap.exists()) return false;
  const data = snap.data();
  const name = data.name || nameHint || "Family Tree";
  tree = {key, name, defaultFocus: data.defaultFocus || null}; saveTree(key, name);
  history.replaceState(null, "", location.pathname + "#t=" + key);
  $("#home").hidden = true; $("#treeScreen").hidden = false;
  $("#treeTitle").textContent = name; document.title = name;
  loaded = false; offlineNote = ""; view = "tree"; trail = []; focusId = null;
  render();
  const timer = setTimeout(()=>{ if(!loaded){ offlineNote="Still loading. If this stays, check your connection."; render(); } }, 10000);
  unsub = onSnapshot(collection(fs, "trees", key, "people"), qs => {
    clearTimeout(timer); offlineNote = ""; loaded = true;
    people = new Map(qs.docs.map(d => { const v=d.data(); return [d.id, {id:d.id, ...v, parents:[...(v.parents||[])], spouses:[...(v.spouses||[])]}]; }));
    if(sheetMode && sheetMode.edit && !P(sheetMode.edit)) closeSheet();
    render();
  }, err => {
    clearTimeout(timer); loaded = true;
    offlineNote = "The tree couldn't load (" + err.code + "). Reload the page to try again.";
    render();
  });
  return true;
}

/* ---- home forms ---- */
function setHomeTab(join){
  $("#tabJoin").setAttribute("aria-selected", join); $("#tabCreate").setAttribute("aria-selected", !join);
  $("#joinForm").hidden = !join; $("#createForm").hidden = join;
}
$("#tabJoin").onclick = () => setHomeTab(true);
$("#tabCreate").onclick = () => setHomeTab(false);
$("#savedList").addEventListener("click", async e => {
  const b = e.target.closest("[data-open]"); if(!b) return;
  const ok = await openTree(b.dataset.open);
  if(ok === false && !tree){ toast("That tree no longer exists."); forgetTree(b.dataset.open); showHome(); }
});

$("#joinForm").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#joinErr"); err.hidden = true;
  const name = $("#j-name").value, pass = $("#j-pass").value;
  if(!name.trim() || !pass){ err.textContent="Enter the tree name and password."; err.hidden=false; return; }
  $("#joinBtn").disabled = true;
  const key = await treeKey(name, pass);
  const ok = await openTree(key, name.trim());
  $("#joinBtn").disabled = false;
  if(!ok && !tree){ err.textContent = "No tree matches that name and password. Check the spelling, or ask whoever made it."; err.hidden = false; }
  else $("#j-pass").value = "";
});

$("#createForm").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#createErr"); err.hidden = true;
  const name = $("#c-name").value.trim(), pass = $("#c-pass").value;
  if(!name){ err.textContent="Give the tree a name."; err.hidden=false; return; }
  if(pass.length < 6){ err.textContent="Use a password of at least 6 characters."; err.hidden=false; return; }
  if(pass !== $("#c-pass2").value){ err.textContent="The two passwords don't match."; err.hidden=false; return; }
  $("#createBtn").disabled = true;
  try {
    const key = await treeKey(name, pass);
    const ref = doc(fs, "trees", key);
    const existing = await getDoc(ref);
    if(existing.exists()){ err.textContent="A tree with this name and password already exists. Use Join instead."; err.hidden=false; return; }
    await setDoc(ref, {name, created: Date.now()});
    $("#c-pass").value = $("#c-pass2").value = "";
    await openTree(key, name);
    toast("Tree created. Tap ⋯ to invite family.");
  } catch(e2){
    err.textContent = "Couldn't create the tree (" + (e2.code||"error") + "). Check your connection and try again."; err.hidden=false;
  } finally { $("#createBtn").disabled = false; }
});

/* ================= family relationships ================= */
const parentsOf = p => (p.parents||[]).map(P).filter(Boolean);
const partnersOf = p => (p.spouses||[]).map(P).filter(Boolean);
const childrenOf = id => [...people.values()].filter(c => (c.parents||[]).includes(id));
function siblingsOf(p){
  const mine = p.parents||[]; if(!mine.length) return [];
  return [...people.values()].filter(s => s.id!==p.id && (s.parents||[]).some(x=>mine.includes(x)))
    .map(s => ({p:s, half: !(mine.length===(s.parents||[]).length && mine.every(x=>s.parents.includes(x)))}));
}
function years(p){
  const compact = deathCompact(p);
  if(compact) return compact;
  const b = formatDate(p.born,p.bornMonth,p.bornDay);
  return b ? `b. ${b}` : "";
}
function surname(p){
  if(p.lastName) return p.lastName;
  const w = (p.name||"").trim().split(/\s+/);
  return w.length>1 ? w[w.length-1] : (w[0]||"Unnamed");
}
// A couple's recorded parents are sometimes only known for the couple as a
// whole, not for which spouse is the actual blood child - that uncertainty
// is stored on whichever one ended up holding the `parents` array
// (p.parentsUncertain). While it's unresolved, don't offer a second,
// separate +Parent for their partner too - the same uncertain pair already
// covers them, and setting a different pair there would just contradict it.
function openParentSlot(p){
  if((p.parents||[]).length>=2) return false;
  return !partnersOf(p).some(sp=>sp.parentsUncertain && (sp.parents||[]).length);
}

/* ================= saving ================= */
const toYear = v => { const n = parseInt(v,10); return Number.isFinite(n) ? n : null; };
const toSmall = (v,max) => { const n = parseInt(v,10); return (Number.isFinite(n) && n>=1 && n<=max) ? n : null; };
async function put(p){
  const data = {
    name: p.name||"",
    firstName: p.firstName||"", middleName: p.middleName||"", lastName: p.lastName||"",
    maidenName: p.maidenName||"", gender: p.gender||"",
    born: toYear(p.born), bornMonth: toSmall(p.bornMonth,12), bornDay: toSmall(p.bornDay,31),
    died: toYear(p.died), diedMonth: toSmall(p.diedMonth,12), diedDay: toSmall(p.diedDay,31),
    place: p.place||"", note: p.note||"",
    parents: (p.parents||[]).slice(0,2), spouses: (p.spouses||[]).slice(0,20),
    notPartnerWith: (p.notPartnerWith||[]).slice(0,20), divorced: (p.divorced||[]).slice(0,20), updated: Date.now()
  };
  if(p.placeholder && !data.name) data.placeholder = true;
  if(p.parentsUncertain) data.parentsUncertain = true;
  people.set(p.id, {id:p.id, ...data});
  try { await setDoc(doc(fs, "trees", tree.key, "people", p.id), data); return true; }
  catch(e){ toast("That change didn't save (" + (e.code||"error") + "). Try again."); return false; }
}
async function drop(id){
  people.delete(id);
  try { await deleteDoc(doc(fs, "trees", tree.key, "people", id)); }
  catch(e){ toast("Couldn't remove (" + (e.code||"error") + ")."); }
}
/* a shared placeholder parent lets two people be linked as siblings even when
   nobody knows who their actual parents were. Editing it in later replaces the
   "Unknown" bubble with a real person without having to relink anyone. */
async function ensureParentPlaceholder(id){
  const p = P(id);
  if(p.parents && p.parents.length) return p.parents[0];
  const ph = {id:newId(), name:"", born:null, died:null, place:"", note:"", parents:[], spouses:[], placeholder:true};
  await put(ph);
  await put({...p, parents:[ph.id]});
  return ph.id;
}
/* Two people becoming partners should run both ways, same as the existing
   "sharing a child assumes a couple" default: once they're linked, any
   existing child of either one with an open parent slot (fewer than 2
   recorded) is assumed to be theirs together too - otherwise a parent added
   via +Partner (rather than +Parent) only shows up sideways as a spouse,
   never upwards as that child's other parent. Never touches a slot that's
   already filled, so an unrelated half-sibling's real other parent is safe. */
async function linkAsPartners(aId, bId){
  for(const kid of childrenOf(aId)){
    if((kid.parents||[]).length<2 && !(kid.parents||[]).includes(bId))
      await put({...kid, parents: uniq([...(kid.parents||[]), bId]).slice(0,2)});
  }
  for(const kid of childrenOf(bId)){
    if((kid.parents||[]).length<2 && !(kid.parents||[]).includes(aId))
      await put({...kid, parents: uniq([...(kid.parents||[]), aId]).slice(0,2)});
  }
}
async function setDefaultFocus(id){
  try {
    await setDoc(doc(fs, "trees", tree.key), {defaultFocus: id}, {merge:true});
    tree.defaultFocus = id;
    return true;
  } catch(e){ toast("Couldn't set the starting point (" + (e.code||"error") + ")."); return false; }
}

/* ================= pedigree grid rendering =================
   One person is the focal point. Going UP from them is a full binary
   ancestor fan (both parents, each generation also showing that
   ancestor's own siblings). Going DOWN from them is every descendant,
   generation by generation. A spouse married in at any level, and a
   sibling's own line, are shown as a single dim "more" bubble — their
   own parents/children aren't expanded unless you tap them, which
   re-centres the whole grid on them. */
function pickFocus(){
  if(focusId && P(focusId)) return;
  if(tree.defaultFocus && P(tree.defaultFocus)){ setFocus(tree.defaultFocus); return; }
  const all = [...people.values()].filter(p=>!p.placeholder).sort(byName);
  if(all.length) setFocus(all[0].id);
}
/* Moves focus to `id` - the whole grid always re-roots on whoever's
   focused (see renderPedigree), so clicking any ancestor or descendant
   simply re-centers the view on them, with their own full lineage above
   and below. */
function setFocus(id){
  if(!P(id)) return;
  focusId = id;
}
function go(id, push=true){
  if(!P(id)) return;
  if(push && focusId && focusId!==id) trail.push(focusId);
  setFocus(id); view="tree"; render();
}

/* Generations are flat rows (a fixed height apart, never based on birth
   date - a spouse always sits at exactly the same height as their partner).
   Placement is computed as exact (x, generation) coordinates so the line
   from a clicked person up to their parents always points at that specific
   person, not just at the middle of whatever row they're sitting in - and
   every other relative (siblings, their spouses) gets their own line too,
   so the "whose parents are whose" is never ambiguous. */
const SLOT_W = 124, ROW_H = 148;
// A deep subtree's own width used to propagate all the way back up,
// forcing everyone near the focal person to spread out just to make room
// for generations they're barely related to. Each unit now shrinks the
// further its generation sits from the focal person (gen 0) - both the
// width it reserves and its own on-screen size (see bubbleHtml's --ns) -
// so a wide, distant branch takes less room instead of pushing the near
// generations apart to fit it.
function genScale(gen){
  if(gen>=0) return 1;
  const d = -gen;
  if(d<=2) return 1;
  if(d<=4) return 0.75;
  if(d<=6) return 0.55;
  return 0.4;
}
const isDivorced = (a, b) => !!(a && b && ((a.divorced||[]).includes(b.id) || (b.divorced||[]).includes(a.id)));
// A divorced couple sitting right next to each other reads fine with the
// X drawn over their connecting line - that's only confusing when another
// partner sits between them, since the line to a non-adjacent partner
// runs straight behind that in-between node. So: X on the line when
// adjacent, X on the ex-partner's own node otherwise.
// Takes the actual step distance a true adjacent pair would sit at, not a
// generation - descendant pairs can be packed tighter than genScale(gen)
// alone once a crowded branch is compressing itself to fit (see
// branchScale), so callers pass whatever step they actually placed with.
const adjacentX = (ax, bx, expectedStep) => Math.abs(Math.abs(ax-bx)-expectedStep)<0.01;
// A couple's left/right order is always by gender (male left, female
// right, unknown gender in between) rather than by who happens to be the
// blood relative being traced through at the moment.
const genderRank = p => !p ? 1 : p.gender==="m" ? 0 : p.gender==="f" ? 2 : 1;
const sortIdsByGender = ids => [...ids].sort((a,b)=>genderRank(P(a))-genderRank(P(b)));
const sortCoupleByGender = people => [...people].sort((a,b)=>genderRank(a)-genderRank(b));
// Both parents always expand, every generation, all the way back as far
// as anyone's actually entered - there's no anchor/stop point any more to
// pick a side at.
function splitParents(parents){
  return {expand: parents.length===2 ? sortCoupleByGender(parents) : parents, suppressed:null};
}

function ancWidth(id, excludeSpouseId, extraPartnerId, gen){
  const p = P(id);
  const step = genScale(gen);
  const sibs = siblingsOf(p).map(s=>s.p);
  const folks = [p, ...sibs];
  // Every slot at this generation is `step` wide, not a flat 1, so a
  // distant row's own width shrinks right along with its on-screen size.
  // A sibling (never the pivot - their own kids are the direct bloodline,
  // placed separately) needs room for their OWN kids too now that cousins
  // always show - same compression rules as any other branch, judged
  // purely on that sibling's own subtree.
  const rowWidth = folks.reduce((sum,f)=> {
    const own = step*(1 + partnersOf(f).filter(s=>!(f.id===p.id && s.id===excludeSpouseId)).length + ((f.id===p.id && extraPartnerId)?1:0));
    if(f.id===p.id) return sum+own;
    return sum + Math.max(own, descWidth(f.id, gen, step, step));
  }, 0);
  const {expand, suppressed} = splitParents(parentsOf(p));
  // a suppressed co-parent who IS already a registered spouse gets placed
  // by the expanding parent's own row, like any other partner - only a
  // suppressed co-parent with no spouse record of their own needs this
  // extra reserved unit, passed down so it lands right next to them.
  const upWidth = expand.length
    ? expand.reduce((sum,par,i)=>{
        const exclude = expand.length>1 ? expand[1-i].id : null;
        const extra = (expand.length===1 && suppressed && !(par.spouses||[]).includes(suppressed.id)) ? suppressed.id : null;
        return sum + ancWidth(par.id, exclude, extra, gen-1);
      }, 0)
    : 0;
  return Math.max(rowWidth, upWidth, step);
}
// The true width a subtree would need with nobody shrinking at all (step
// pinned at 1 throughout, no genScale, no compression) - this is "how
// crowded is this branch, really", used once per person below to decide
// how hard that specific branch's grandkids need to compress (see
// descWidth/placeDescendant). Collapsed still counts as 1 - a folded box
// takes exactly one slot same as it does everywhere else.
let natWidthCache = new Map();
function natDescWidth(id){
  if(natWidthCache.has(id)) return natWidthCache.get(id);
  const p = P(id);
  const rowWidth = 1 + partnersOf(p).length;
  const kids = childrenOf(id);
  const downWidth = kids.length ? kids.reduce((sum,k)=>sum+natDescWidth(k.id),0) : 0;
  const result = Math.max(rowWidth, downWidth, 1);
  natWidthCache.set(id, result);
  return result;
}
// Siblings are always the same size as each other, full stop - no matter
// how big any one of their own families turns out to be. What actually
// compresses to keep a crowded sibling's whole brood from pushing the
// OTHER siblings further apart is everything from that sibling's own
// GRANDKIDS down - judged purely on that sibling's own subtree, never
// pooled with their siblings, so an uncrowded sibling is never punished
// for a crowded one, and the compression only starts two generations
// below wherever it was decided, not at the kids themselves. A typical
// family easily has a few kids who each have a couple of kids of their
// own - BRANCH_BUDGET is how much natural width that's allowed to take
// before anything shrinks at all, so an ordinary-sized family is never
// touched; only a branch that genuinely dwarfs that starts compressing,
// and even then only down past the budget, not all the way to 1. A floor
// keeps any single generation from vanishing to nothing in one jump -
// deep, wide branches still shrink further through repeated cascading,
// same as before, with the collapse feature as the real escape valve
// once that gets absurd.
const BRANCH_BUDGET = 4;
const MIN_BRANCH_RATIO = 0.15;
// The scale kidId's OWN children should use, judged purely on kidId's own
// subtree (never pooled with kidId's siblings - that's what let one
// crowded sibling drag every other sibling's kids down with it).
function kidGrandkidScale(nextScale, kidId){
  const nat = natDescWidth(kidId);
  const ratio = nat>BRANCH_BUDGET ? Math.max(BRANCH_BUDGET/nat, MIN_BRANCH_RATIO) : 1;
  return nextScale*ratio;
}
// ownScale: the size id itself (and its own siblings) render at - never
// reduced by id's own crowding. nextScale: the size id's OWN kids render
// at, inherited from whoever decided ownScale (defaults to the same,
// i.e. unreduced, until someone's own crowding first calls for less).
// Unlike ancestors, descendants never shrink just for being many
// generations down (see genScale) - an isolated branch with nothing
// crowding it stays full size no matter how deep it goes, since there's
// nothing here that actually needs the room back.
function descWidth(id, gen, ownScale, nextScale){
  ownScale = ownScale==null ? 1 : ownScale;
  nextScale = nextScale==null ? ownScale : nextScale;
  const p = P(id);
  const step = ownScale;
  const rowWidth = step*(1 + partnersOf(p).length);
  const kids = childrenOf(id);
  if(!kids.length) return Math.max(rowWidth, step);
  // Each kid's own crowding (never pooled with its siblings) decides how
  // much THAT kid's own children compress - a kid with nothing crowding
  // it stays full size regardless of what its siblings are dealing with.
  const downWidth = kids.reduce((sum,k)=>sum+descWidth(k.id, gen+1, nextScale, kidGrandkidScale(nextScale, k.id)),0);
  return Math.max(rowWidth, downWidth, step);
}

function placeAncestor(placed, edges, id, excludeSpouseId, xLeft, width, gen, extraPartnerId, pinSide){
  const p = P(id);
  const parents = parentsOf(p);
  const {expand, suppressed} = splitParents(parents);
  const parentPos = [];
  if(expand.length){
    // same reserved-extra-unit rule as ancWidth: only a suppressed
    // co-parent with no spouse record of their own needs to ride along
    // as an extra attachment on the expanding parent's own row - one
    // already recorded as a spouse gets placed by that row normally.
    const excludeFor = i => expand.length>1 ? expand[1-i].id : null;
    const extraFor = i => (expand.length===1 && suppressed && !(expand[i].spouses||[]).includes(suppressed.id)) ? suppressed.id : null;
    const widths = expand.map((par,i)=>ancWidth(par.id, excludeFor(i), extraFor(i), gen-1));
    const totalW = widths.reduce((a,b)=>a+b,0);
    // When THIS row is itself pinned to an edge (to stay adjacent to its
    // own co-parent - see below), center these grandparents in the full
    // allotted width would leave a growing gap between them and wherever
    // this row actually ends up, stretching their connecting line further
    // with every extra generation of width above. Hug the same edge
    // instead, so the whole chain stays compact and only the sibling side
    // (the overflow) spreads out as far as it actually needs to.
    let px = pinSide==="right" ? xLeft+width-totalW : pinSide==="left" ? xLeft : xLeft + (width-totalW)/2;
    // When both parents each get their own independent ancestor fork, that
    // parent's own siblings share its block - without pinning, the sibling
    // sort (by birth) can freely land a sibling between the two parents,
    // who are supposed to be a couple. Pin each parent to the block edge
    // that faces the other, so siblings only ever fan out away from them.
    expand.forEach((par,i)=>{
      const pin = expand.length===2 ? (i===0 ? "right" : "left") : null;
      parentPos.push(placeAncestor(placed, edges, par.id, excludeFor(i), px, widths[i], gen-1, extraFor(i), pin));
      px += widths[i];
    });
    // when both parents are each their own blood ancestor fork (both have
    // their own further ancestry, so neither is a plain dead-end spouse
    // attachment), they still need a tie line drawn here - sharing this
    // child assumes they're a couple for this diagram by default, unless
    // explicitly marked otherwise (notPartnerWith, set from the Edit sheet).
    if(expand.length===2 && !(expand[0].notPartnerWith||[]).includes(expand[1].id)){
      const divorced = isDivorced(expand[0], expand[1]);
      const adj = adjacentX(parentPos[0].x, parentPos[1].x, genScale(gen-1));
      edges.push({tie:true, a:parentPos[0], b:parentPos[1], divorced: divorced && adj, scale:genScale(gen-1)});
      // each parent here is the pivot of their own, possibly-wide ancestor
      // fork (siblings, an attached spouse of their own) - when they're
      // not sitting right next to each other, that line runs straight
      // behind whatever's filling the gap, so mark both of them directly
      // instead (found by id since they were placed inside the recursive
      // calls above, not pushed here).
      if(divorced && !adj){
        [expand[0].id, expand[1].id].forEach(id=>{
          const n = placed.find(n=>n.id===id && n.gen===gen-1);
          if(n) n.divorced = true;
        });
      }
    }
    // a suppressed co-parent is otherwise placed by the expanding parent's
    // own row below (either normally, as a registered spouse, or via
    // extraPartnerId right above) - nothing left to do here.
  }
  const sibs = siblingsOf(p);
  let folks = [{person:p, half:false, isPivot:true}, ...sibs.map(s=>({person:s.p, half:s.half, isPivot:false}))]
    .sort((a,b)=>byBorn(a.person,b.person));
  if(pinSide){
    const pivotFolk = folks.find(f=>f.isPivot);
    const others = folks.filter(f=>!f.isPivot);
    folks = pinSide==="right" ? [...others, pivotFolk] : [pivotFolk, ...others];
  }
  const step = genScale(gen);
  const rowWidth = folks.reduce((sum,f)=> {
    const own = step*(1 + partnersOf(f.person).filter(s=>!(f.isPivot && s.id===excludeSpouseId)).length + ((f.isPivot && extraPartnerId)?1:0));
    if(f.isPivot) return sum+own;
    return sum + Math.max(own, descWidth(f.person.id, gen, step, step));
  }, 0);
  // Centering this row purely within the space handed down from the child
  // below breaks once the pivot has many siblings: the pivot's own spot
  // inside that wide sibling row depends on sort order, not the row's
  // midpoint, so a single-child descendant centered on the row's midpoint
  // could land far from where the pivot actually ended up. Center on the
  // parents' own actual position instead (clamped to the space we were
  // given, so sibling forks still never overlap each other).
  let cursor;
  if(pinSide){
    // Pinned to the edge facing an independently-forking co-parent (see
    // above) - hug that edge exactly, rather than centering on this
    // pivot's own further-up ancestors, so the couple stays adjacent even
    // when one side's upward fan is wider than its own sibling row.
    cursor = pinSide==="right" ? xLeft+width-rowWidth : xLeft;
  } else if(parentPos.length){
    const parentCenter = parentPos.reduce((s,pp)=>s+pp.x,0)/parentPos.length;
    cursor = Math.max(xLeft, Math.min(xLeft+width-rowWidth, parentCenter-rowWidth/2));
  } else {
    cursor = xLeft + (width-rowWidth)/2;
  }

  let pivotPos = null;
  folks.forEach(f=>{
    const person = f.person;
    const partners = partnersOf(person).filter(s=>!(f.isPivot && s.id===excludeSpouseId));
    const extra = (f.isPivot && extraPartnerId) ? P(extraPartnerId) : null;
    const unitIds = sortIdsByGender([person.id, ...partners.map(s=>s.id), ...(extra?[extra.id]:[])]);
    // A sibling with their own crowded cousin-fan below needs that much
    // room reserved HERE too, in the row itself, or the fan spills into
    // whoever's slotted in next to them - same width ancWidth already
    // promised this row would have (the pivot's own kids aren't placed
    // in this row at all, so they never need the extra).
    const unitWidth = step*unitIds.length;
    const descW = f.isPivot ? 0 : descWidth(person.id, gen, step, step);
    const neededWidth = Math.max(unitWidth, descW);
    const unitLeft = cursor + (neededWidth-unitWidth)/2;
    const posOf = {};
    unitIds.forEach((uid,i) => { posOf[uid] = unitLeft + step*i + step/2; });
    cursor += neededWidth;

    const x = posOf[person.id];
    placed.push({id:person.id, x, gen, half:f.half, placeholder:!!person.placeholder, deadEnd:!f.isPivot});
    if(f.isPivot) pivotPos = {x, gen};

    const myParents = person.parents||[];
    const connected = parentPos.filter((pp,i)=> myParents.includes(expand[i].id)).map(pp=>({x:pp.x, gen:pp.gen}));
    // A node with recorded parents that aren't being drawn here (simply
    // never expanded past this dead end) is easy to mistake for "nothing
    // more was ever entered" - a short grayed stub reaching up into the
    // empty gap above says otherwise.
    if(!person.placeholder && myParents.length && !connected.length) edges.push({stub:true, x, gen, scale:genScale(gen)});
    // these two parents are each their own independently-placed ancestor
    // fork, so they may not sit next to each other - never collapse them
    // to a single midpoint trunk (adjacent:false forces a stub per parent).
    if(connected.length){
      // When it's not clear whether `person` or their partner is the one
      // actually descended from these parents, land the connector between
      // the two of them instead of squarely on `person` - the line
      // shouldn't claim more certainty than is actually known.
      const uncertain = !!person.parentsUncertain;
      const childX = uncertain && partners.length ? [x, ...partners.map(sp=>posOf[sp.id])].reduce((a,b)=>a+b,0)/(partners.length+1) : x;
      edges.push({childX, childGen:gen, parents:connected, adjacent:false, uncertain});
    }

    const spouseXMap = new Map();
    partners.forEach(sp=>{
      const sx = posOf[sp.id];
      const divorced = isDivorced(person, sp), adj = adjacentX(x, sx, genScale(gen));
      placed.push({id:sp.id, x:sx, gen, dim:true, placeholder:!!sp.placeholder, deadEnd:true, divorced: divorced && !adj});
      edges.push({tie:true, a:{x, gen}, b:{x:sx, gen}, divorced: divorced && adj, scale:genScale(gen)});
      spouseXMap.set(sp.id, sx);
      // a dim attached partner never expands further themselves, so their
      // own recorded parents (if any) would otherwise vanish with no trace.
      if(!sp.placeholder && (sp.parents||[]).length) edges.push({stub:true, x:sx, gen, scale:genScale(gen)});
    });
    if(extra){
      const sx = posOf[extra.id];
      const divorced = isDivorced(person, extra), adj = adjacentX(x, sx, genScale(gen));
      placed.push({id:extra.id, x:sx, gen, dim:true, placeholder:!!extra.placeholder, deadEnd:true, divorced: divorced && !adj});
      edges.push({tie:true, a:{x, gen}, b:{x:sx, gen}, divorced: divorced && adj, scale:genScale(gen)});
      if(!extra.placeholder && (extra.parents||[]).length) edges.push({stub:true, x:sx, gen, scale:genScale(gen)});
    }
    // A sibling (never the pivot - their kids are the direct bloodline,
    // traced separately via parentPos/connected above) is now a pivot in
    // their own right one generation down: their kids are your cousins,
    // and they always show, the same way anyone else's descendants do.
    if(!f.isPivot) placeKidsBelow(placed, edges, person.id, x, gen, spouseXMap, step);
  });
  return pivotPos;
}
function placeDescendant(placed, edges, id, xLeft, width, gen, ownScale, nextScale){
  ownScale = ownScale==null ? 1 : ownScale;
  nextScale = nextScale==null ? ownScale : nextScale;
  const p = P(id);
  const step = ownScale;
  const partners = partnersOf(p);
  // The pivot + their spouse(s) only need (1 + partners.length) slots, but
  // `width` can be wider than that to make room for grandchildren below -
  // center that couple unit within the full width rather than centering
  // the pivot alone, otherwise a spouse can land right on the boundary
  // with the next sibling's own space when there's no extra room needed.
  const unitWidth = step*(1 + partners.length);
  const unitLeft = xLeft + (width-unitWidth)/2;
  const unitIds = sortIdsByGender([p.id, ...partners.map(s=>s.id)]);
  const posOf = {};
  unitIds.forEach((uid,i) => { posOf[uid] = unitLeft + step*i + step/2; });
  const x = posOf[p.id];
  placed.push({id:p.id, x, gen, placeholder:!!p.placeholder, scale:step});

  const spouseX = new Map();
  partners.forEach(sp=>{
    const sx = posOf[sp.id];
    const divorced = isDivorced(p, sp), adj = adjacentX(x, sx, step);
    placed.push({id:sp.id, x:sx, gen, dim:true, placeholder:!!sp.placeholder, deadEnd:true, divorced: divorced && !adj, scale:step});
    edges.push({tie:true, a:{x, gen}, b:{x:sx, gen}, divorced: divorced && adj, scale:step});
    spouseX.set(sp.id, sx);
    // A spouse married in on the way down never gets their own ancestry
    // expanded (same as the ancestor-direction dim attachment) - without
    // this, their recorded parents just silently vanish with no trace.
    if(!sp.placeholder && (sp.parents||[]).length) edges.push({stub:true, x:sx, gen, scale:step});
  });

  const kids = childrenOf(id).sort(byBorn);
  if(kids.length){
    // Each kid's own crowding (never pooled with its siblings) decides
    // how much THAT kid's own children compress - p's own kids all still
    // render at nextScale, the same size any childless sibling's kids
    // would, regardless of which of them this is about.
    const kidScales = kids.map(k=>kidGrandkidScale(nextScale, k.id));
    const widths = kids.map((k,i)=>descWidth(k.id, gen+1, nextScale, kidScales[i]));
    const totalW = widths.reduce((a,b)=>a+b,0);
    // center the children block on the full allocated width, not on the
    // pivot's own position - when the pivot has a spouse, their own x sits
    // left of that width's true center, which would shove a wide block of
    // grandchildren left too, overlapping whatever's allocated next door.
    let cx = (xLeft + width/2) - totalW/2;
    kids.forEach((k,i)=>{
      const kpos = placeDescendant(placed, edges, k.id, cx, widths[i], gen+1, nextScale, kidScales[i]);
      const kp = P(k.id);
      const parentPts = [{x, gen}];
      (kp.parents||[]).forEach(pid=>{ if(spouseX.has(pid)) parentPts.push({x:spouseX.get(pid), gen}); });
      // a single midpoint trunk only looks right when the two parents are
      // actually sitting next to each other - with more than one partner
      // in the row, the matched one might be further off, and averaging
      // the two positions can land the trunk on whoever happens to sit
      // between them (looking like a third parent), so fall back to a
      // stub per parent in that case, same as independently-forked ones.
      const adjacent = parentPts.length<2 || adjacentX(parentPts[0].x, parentPts[1].x, step);
      // Same "don't overclaim" rule as the ancestor direction: when it's
      // unclear whether this child or their own spouse is the actual blood
      // descendant, land the connector between the two of them.
      const uncertain = !!kp.parentsUncertain;
      let childX = kpos.x;
      if(uncertain){
        const partnerXs = partnersOf(kp).map(sp=>{ const n = placed.find(pn=>pn.id===sp.id && pn.gen===kpos.gen); return n ? n.x : null; }).filter(v=>v!=null);
        if(partnerXs.length) childX = [kpos.x, ...partnerXs].reduce((a,b)=>a+b,0)/(partnerXs.length+1);
      }
      edges.push({childX, childGen:kpos.gen, parents:parentPts, adjacent, uncertain});
      cx += widths[i];
    });
  }
  return {x, gen};
}
/* Connector lines are grouped by family unit (the exact set of parents a
   child belongs to), so a couple - or a single known parent - gets one
   shared trunk down to one bus line, with each child hanging off it by a
   short stub, rather than a separate line to every parent individually. */
function renderEdges(edges, px, py){
  let svg = "";
  const groups = new Map();
  edges.forEach(e=>{
    if(e.stub){
      // A short, muted line reaching up into the empty gap above a node -
      // signals "more is recorded here, just not drawn" (blocked by an
      // anchor, collapsed, or a dead end that never expands) without
      // claiming to show an actual connection to anyone specific. Sized
      // to the node it's attached to, same as the divorce X below, or it
      // reads as oversized - and could even reach past a heavily
      // compressed row's own shrunk gap above it.
      const x1 = px(e.x), yTop = py(e.gen), sc = e.scale!=null ? e.scale : 1;
      svg += `<line x1="${x1.toFixed(1)}" y1="${(yTop-30*sc).toFixed(1)}" x2="${x1.toFixed(1)}" y2="${(yTop-58*sc).toFixed(1)}" class="stub-line"/>`;
      return;
    }
    if(e.tie){
      const x1=px(e.a.x), y1=py(e.a.gen), x2=px(e.b.x), y2=py(e.b.gen);
      svg += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="tie-line"/>`;
      if(e.divorced){
        const mx=(x1+x2)/2, my=(y1+y2)/2, s=6*(e.scale!=null ? e.scale : 1);
        svg += `<line x1="${(mx-s).toFixed(1)}" y1="${(my-s).toFixed(1)}" x2="${(mx+s).toFixed(1)}" y2="${(my+s).toFixed(1)}" class="divorce-x"/>`;
        svg += `<line x1="${(mx-s).toFixed(1)}" y1="${(my+s).toFixed(1)}" x2="${(mx+s).toFixed(1)}" y2="${(my-s).toFixed(1)}" class="divorce-x"/>`;
      }
      return;
    }
    const key = e.parents.map(p=>p.x+","+p.gen).sort().join("|");
    if(!groups.has(key)) groups.set(key, {parents:e.parents, children:[], adjacent:e.adjacent});
    groups.get(key).children.push({x:e.childX, gen:e.childGen, uncertain:e.uncertain});
  });
  groups.forEach(g=>{
    const parentY = py(g.parents[0].gen);
    // A couple that's always placed right next to each other (an attached
    // spouse, or any case marked adjacent) reads better as one clean trunk
    // from their shared midpoint. Two parents who are each their own
    // independently-placed ancestor fork (adjacent:false) might not be
    // anywhere near each other, so the midpoint could land on an unrelated
    // person sitting between them - give those a stub per parent instead.
    const uniqueXs = [...new Set(g.parents.map(p=>px(p.x)))];
    const parentPx = (g.adjacent && uniqueXs.length>1)
      ? [uniqueXs.reduce((a,b)=>a+b,0)/uniqueXs.length]
      : uniqueXs;
    const childY = py(g.children[0].gen);
    const busY = parentY + (childY-parentY)*0.6;
    const childPx = g.children.map(c=>px(c.x));
    const allX = [...parentPx, ...childPx];
    const minX = Math.min(...allX), maxX = Math.max(...allX);
    parentPx.forEach(x1 => {
      svg += `<line x1="${x1.toFixed(1)}" y1="${parentY.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${busY.toFixed(1)}" class="fam-line"/>`;
    });
    if(maxX>minX) svg += `<line x1="${minX.toFixed(1)}" y1="${busY.toFixed(1)}" x2="${maxX.toFixed(1)}" y2="${busY.toFixed(1)}" class="fam-line"/>`;
    g.children.forEach((c,i)=>{
      const cls = c.uncertain ? "fam-line uncertain" : "fam-line";
      const cy = py(c.gen);
      svg += `<line x1="${childPx[i].toFixed(1)}" y1="${busY.toFixed(1)}" x2="${childPx[i].toFixed(1)}" y2="${cy.toFixed(1)}" class="${cls}"/>`;
      // a dashed line alone reads as "incomplete data" rather than "unsure
      // whose child" - the "?" is what actually says that.
      if(c.uncertain) svg += `<text x="${childPx[i].toFixed(1)}" y="${((busY+cy)/2+4).toFixed(1)}" class="uncertain-q" text-anchor="middle">?</text>`;
    });
  });
  return svg;
}

function bubbleHtml(n, x, y){
  const p = P(n.id); if(!p) return "";
  // The person you actually selected stays full-size regardless of how
  // far they are from the root - everyone else shrinks the further their
  // own generation sits from the focal point. Descendants carry their own
  // precomputed scale (branch crowding folded in, see descWidth) -
  // ancestors don't have that yet, so they still fall back to the plain
  // per-generation curve.
  const scale = n.id===focusId ? 1 : (n.scale!=null ? n.scale : genScale(n.gen));
  const scaleStyle = scale<1 ? `--ns:${scale.toFixed(2)};` : "";
  if(p.placeholder) return `<button class="node ph" style="left:${x}px;top:${y}px;${scaleStyle}" data-go="${esc(n.id)}">Unknown</button>`;
  // A sibling or dead-end spouse never expands further themselves - this
  // just signals there's recorded family beyond this dead end, tappable
  // (re-centering the grid on them) to actually see it.
  const more = n.deadEnd && (parentsOf(p).length || childrenOf(p.id).length);
  const genderCls = p.gender==="m" ? " g-m" : p.gender==="f" ? " g-f" : "";
  // Naming both of them specifically (rather than a generic "their
  // partner") is what actually answers the question on hover, without
  // needing to tap anything first.
  const uncertainPartner = p.parentsUncertain ? partnersOf(p)[0] : null;
  const uncertainBadge = (p.parentsUncertain && uncertainPartner)
    ? ` <span class="uncertainBadge" data-resolve="${esc(p.id)}" title="${esc(`Not sure if these are ${displayName(p)||"their"}'s parents or ${displayName(uncertainPartner)||"their partner"}'s - tap to say for sure`)}">?</span>`
    : "";
  return `<button class="node${n.dim?" dim":""}${n.id===focusId?" me":""}${more?" more":""}${genderCls}" style="left:${x}px;top:${y}px;${scaleStyle}" data-go="${esc(n.id)}">
    <span class="nm">${esc(displayName(p)||"Unnamed")}${n.divorced?` <span class="divorcedBadge" title="Divorced">✕</span>`:""}${uncertainBadge}</span>
    ${p.maidenName?`<span class="maiden">(${esc(p.maidenName)})</span>`:""}
    <span class="yrs${birthKnown(p)?"":" unk"}">${esc(birthLabel(p))}</span>
    ${n.half?`<span class="chip">half</span>`:""}
  </button>`;
}
function dockHtml(f){
  if(!f || f.placeholder) return "";
  return `<div class="dock">
    <div class="dockInfo"><strong>${esc(displayName(f)||"Unnamed")}</strong>${years(f)?` <span class="yrs">${esc(years(f))}</span>`:""}${f.maidenName?`<div class="maiden">(${esc(f.maidenName)})</div>`:""}${f.place?`<div class="place">${esc(f.place)}</div>`:""}</div>
    <div class="dockBtns">
      ${openParentSlot(f)?`<button class="dbtn" data-add="parent">+ Parent</button>`:""}
      <button class="dbtn" data-add="partner">+ Partner</button>
      <button class="dbtn" data-add="child">+ Child</button>
      <button class="dbtn" data-add="sibling">+ Sibling</button>
      <button class="dbtn edit" data-edit="${esc(f.id)}">Edit</button>
    </div>
  </div>`;
}
// Places parentId's own kids one generation below parentGen, centered on
// parentId's own x (and spouse(s), via spouseXMap) - shared by the current
// root's own kids and every ancestor-direction sibling's kids (cousins
// now always show, the same way an anchor's own descendants used to be
// the only ones that did). Each kid renders full size as a sibling of
// their own siblings; it's purely their OWN crowding (see descWidth) that
// decides how much THEIR kids compress, never pooled with parentId's
// other kids.
function placeKidsBelow(placed, edges, parentId, parentX, parentGen, spouseXMap, baseScale){
  baseScale = baseScale==null ? 1 : baseScale;
  const kids = childrenOf(parentId).sort(byBorn);
  if(!kids.length) return;
  const widths = kids.map(k=>descWidth(k.id, parentGen+1, baseScale, baseScale));
  const totalW = widths.reduce((a,b)=>a+b,0);
  const spouseXs = [...spouseXMap.values()];
  const coupleCenter = spouseXs.length ? [parentX, ...spouseXs].reduce((a,b)=>a+b,0)/(spouseXs.length+1) : parentX;
  let cx = coupleCenter - totalW/2;
  kids.forEach((k,i)=>{
    const kpos = placeDescendant(placed, edges, k.id, cx, widths[i], parentGen+1, baseScale, baseScale);
    const kp = P(k.id);
    const parentPts = [{x:parentX, gen:parentGen}];
    (kp.parents||[]).forEach(pid=>{ if(spouseXMap.has(pid)) parentPts.push({x:spouseXMap.get(pid), gen:parentGen}); });
    // a single midpoint trunk only looks right when the two parents are
    // actually sitting next to each other - same step they were placed
    // with, unrelated to baseScale (that's about the kids, not them).
    const adjacent = parentPts.length<2 || adjacentX(parentPts[0].x, parentPts[1].x, genScale(parentGen));
    // don't overclaim whether this child or their own spouse is the
    // actual blood descendant when that's on record as uncertain.
    const uncertain = !!kp.parentsUncertain;
    let childX = kpos.x;
    if(uncertain){
      const partnerXs = partnersOf(kp).map(sp=>{ const n = placed.find(pn=>pn.id===sp.id && pn.gen===kpos.gen); return n ? n.x : null; }).filter(v=>v!=null);
      if(partnerXs.length) childX = [kpos.x, ...partnerXs].reduce((a,b)=>a+b,0)/(partnerXs.length+1);
    }
    edges.push({childX, childGen:kpos.gen, parents:parentPts, adjacent, uncertain});
    cx += widths[i];
  });
}
function renderPedigree(){
  if(!people.size){
    return `<div class="empty"><h2>Start your tree</h2><p>Add yourself or the oldest relative you know. Then add their parents, partners and children from their card.</p><button class="primary" data-add="root">Add the first person</button></div>`;
  }
  pickFocus();
  // The grid always roots on whoever's currently focused - their entire
  // recorded lineage both up and down, re-centering completely whenever
  // you tap someone new.
  const root = P(focusId);
  if(!root) return `<p class="hint">Nobody to show.</p>`;
  // Stale from whatever was focused last render - every person's natural
  // width can shift as soon as focus moves.
  natWidthCache = new Map();

  const placed = [], edges = [];
  const focalPos = placeAncestor(placed, edges, root.id, null, 0, ancWidth(root.id, null, null, 0), 0);
  const focalSpouseX = new Map();
  partnersOf(root).forEach(sp=>{ const n = placed.find(x=>x.id===sp.id); if(n) focalSpouseX.set(sp.id, n.x); });

  placeKidsBelow(placed, edges, root.id, focalPos.x, 0, focalSpouseX);

  const xs = placed.map(n=>n.x), gens = placed.map(n=>n.gen);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minGen = Math.min(...gens), maxGen = Math.max(...gens);
  // Generous padding on every side, not just enough to fit the content -
  // gives real room to grab the background and pan around (especially
  // above the topmost row, which used to sit flush against the edge with
  // nowhere to drag to) and keeps zooming out from feeling cramped.
  const PAD_X = 220, PAD_Y = 220;
  const px = x => (x-minX)*SLOT_W + PAD_X;
  // A shrunk row sitting a full, un-shrunk ROW_H away from its parent
  // reads as "freakishly far away" rather than small - the gap between
  // two rows needs to shrink right along with whatever's actually in
  // them, same as the width already does. Each row's own height is based
  // on the largest scale present in it (a row that's a mix of sizes still
  // needs room for its biggest box), floored so no row ever collapses
  // away entirely.
  const scaleOf = n => n.id===focusId ? 1 : (n.scale!=null ? n.scale : genScale(n.gen));
  const rowMaxScale = new Map();
  placed.forEach(n=>{ const s=scaleOf(n); rowMaxScale.set(n.gen, Math.max(rowMaxScale.get(n.gen)||0, s)); });
  const MIN_ROW_SCALE = 0.35;
  const gensSorted = [...new Set(gens)].sort((a,b)=>a-b);
  const rowY = new Map();
  rowY.set(gensSorted[0], 0);
  for(let i=1;i<gensSorted.length;i++){
    const g0=gensSorted[i-1], g1=gensSorted[i];
    const s0 = Math.max(rowMaxScale.get(g0)||1, MIN_ROW_SCALE), s1 = Math.max(rowMaxScale.get(g1)||1, MIN_ROW_SCALE);
    rowY.set(g1, rowY.get(g0) + ROW_H*((s0+s1)/2)*(g1-g0));
  }
  const py = g => (rowY.get(g)||0) + PAD_Y;
  const width = (maxX-minX)*SLOT_W + PAD_X*2;
  const height = (rowY.get(maxGen)||0) + PAD_Y*2 + 170;

  const linesHtml = renderEdges(edges, px, py);
  const nodesHtml = placed.map(n => bubbleHtml(n, px(n.x), py(n.gen))).join("");

  const selected = P(focusId);
  return `<div class="pedigree" style="width:${width}px;height:${height}px">
    <svg class="lines" width="${width}" height="${height}">${linesHtml}</svg>
    ${nodesHtml}
  </div>${dockHtml(selected)}`;
}

function renderAll(){
  const q = query.trim().toLowerCase();
  const list = [...people.values()].filter(p => !p.placeholder && (!q || (p.name||"").toLowerCase().includes(q) || (p.place||"").toLowerCase().includes(q)));
  const groups = {};
  list.forEach(p => (groups[surname(p)] ||= []).push(p));
  const names = Object.keys(groups).sort();
  let h = `<input class="search" id="q" type="search" placeholder="Search names or places" value="${esc(query)}">`;
  if(!people.size) h += `<p class="hint">Nobody added yet.</p>`;
  else if(!names.length) h += `<p class="hint">No one matches “${esc(query)}”.</p>`;
  names.forEach(n => {
    h += `<section class="line"><h3>${esc(n)} <small>${groups[n].length}</small></h3><div class="row">${groups[n].sort(byName).map(p=>card(p)).join("")}</div></section>`;
  });
  return h;
}
function card(p){
  const kids = childrenOf(p.id).length, y = years(p);
  const genderCls = p.gender==="m" ? " g-m" : p.gender==="f" ? " g-f" : "";
  return `<button class="card${genderCls}" data-go="${esc(p.id)}"><span class="nm">${esc(displayName(p)||"Unnamed")}</span>${p.maidenName?`<span class="maiden">(${esc(p.maidenName)})</span>`:""}${y?`<span class="yrs">${esc(y)}</span>`:""}${kids?`<span class="meta"><span class="chip">${kids} ${kids===1?"child":"children"}</span></span>`:""}</button>`;
}

// Which focusId we last auto-scrolled to - re-scroll only when it actually
// changes (real navigation), never on a plain re-render triggered by
// someone else's edit syncing in elsewhere in the tree, which would
// otherwise yank the view out from under you.
let lastScrollKey = null;
function render(){
  if(!tree) return;
  $("#tabTree").setAttribute("aria-pressed", view==="tree");
  $("#tabAll").setAttribute("aria-pressed", view==="all");
  $("#backBtn").hidden = !(view==="tree" && trail.length);
  $("#zoomCtl").hidden = !(view==="tree" && loaded && people.size);
  if(!loaded){ app.innerHTML = `<p class="hint">${esc(offlineNote || "Opening the tree…")}</p>`; return; }
  const hadFocus = document.activeElement && document.activeElement.id==="q";
  app.innerHTML = (offlineNote?`<p class="note">${esc(offlineNote)}</p>`:"") + (view==="tree" ? renderPedigree() : renderAll());
  if(hadFocus){ const q=$("#q"); q.focus(); q.setSelectionRange(q.value.length,q.value.length); }
  if(view==="tree"){
    if(focusId !== lastScrollKey){
      lastScrollKey = focusId;
      const me = $(".node.me");
      if(me) me.scrollIntoView({block:"center", inline:"center"});
    }
  }
}

/* ================= add / edit sheet ================= */
const relWords = {root:"Add the first person", parent:"Add a parent", partner:"Add a partner", child:"Add a child", sibling:"Add a brother or sister"};
function setGender(g){
  $("#f-gender").value = g;
  $$("#genderToggle button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.gender===g)));
  $("#maidenWrap").hidden = g!=="f";
}
function openSheet(mode){
  sheetMode = mode;
  const f = P(focusId), form = $("#sheetForm");
  form.reset(); form.classList.remove("picking");
  setGender("");
  $("#delZone").hidden = true; $("#delConfirm").hidden = true; $("#delBtn").hidden = false;
  $("#otherWrap").hidden = true; $("#linkWrap").hidden = true; $("#pickWrap").hidden = true;
  $("#uncertainWrap").hidden = true;
  $("#coParentWrap").hidden = true; editCoParents = []; editFormalSpouses = [];
  if(mode.edit){
    const p = P(mode.edit);
    $("#sheetTitle").textContent = p.placeholder ? "Who was this?" : "Edit details";
    if(p.firstName || p.middleName || p.lastName){
      $("#f-first").value=p.firstName||""; $("#f-middle").value=p.middleName||""; $("#f-last").value=p.lastName||"";
    } else {
      const sp = splitLegacyName(p.name);
      $("#f-first").value=sp.first; $("#f-middle").value=sp.middle; $("#f-last").value=sp.last;
    }
    $("#f-maiden").value=p.maidenName||"";
    setGender(p.gender||"");
    $("#f-born-y").value=p.born??""; $("#f-born-m").value=p.bornMonth??""; $("#f-born-d").value=p.bornDay??"";
    $("#f-died-y").value=p.died??""; $("#f-died-m").value=p.diedMonth??""; $("#f-died-d").value=p.diedDay??"";
    $("#f-place").value=p.place||""; $("#f-note").value=p.note||"";
    $("#delZone").hidden = false;
    // Whether these really are p's own parents (vs their partner's) can
    // come into question after the fact too - not just while adding them -
    // so the toggle stays editable here as long as a partner with their own
    // open parent slot still exists to be ambiguous with.
    const uncertainPartner = (p.parents||[]).length ? partnersOf(p).find(sp=>!sp.placeholder && (sp.parents||[]).length<2) : null;
    if(uncertainPartner){
      $("#uncertainWrap").hidden = false;
      $("#uncertainText").textContent = `Not sure if these are ${displayName(p)||"their"}'s parents or ${displayName(uncertainPartner)||"their partner"}'s`;
      $("#f-uncertain").checked = !!p.parentsUncertain;
    }
    // Registered partners (added via +Partner, or "link as partner" when
    // adding a parent) are a couple regardless of any shared child, so
    // divorce applies to them directly - no "assumed by default" toggle,
    // since nothing here is being assumed. Someone who's only a co-parent
    // because they share a child (no formal partner link) still gets the
    // original assumed-married/notPartnerWith toggle alongside it.
    const formalSpouses = partnersOf(p).filter(s=>!s.placeholder);
    const sharedKid = uniq(childrenOf(p.id).flatMap(k => (k.parents||[]).filter(id=>id!==p.id))).map(P).filter(Boolean);
    const assumedOnly = sharedKid.filter(cp => !formalSpouses.some(fs=>fs.id===cp.id));
    if((formalSpouses.length || assumedOnly.length) && !p.placeholder){
      editCoParents = assumedOnly.map(cp=>cp.id);
      editFormalSpouses = formalSpouses.map(sp=>sp.id);
      $("#coParentWrap").hidden = false;
      const spouseRows = formalSpouses.map(sp => `<div class="coParentRow">
          <span class="nm">${esc(displayName(sp)||"Unnamed")}</span>
          <label class="check sub"><input type="checkbox" data-divorced="${esc(sp.id)}" ${isDivorced(p,sp)?"checked":""}> Divorced</label>
        </div>`).join("");
      const coParentRows = assumedOnly.map(cp => {
        const partnered = !(p.notPartnerWith||[]).includes(cp.id);
        return `<div class="coParentRow">
          <label class="check"><input type="checkbox" data-coparent="${esc(cp.id)}" ${partnered?"checked":""}> ${esc(displayName(cp)||"Unnamed")}</label>
          <label class="check sub" data-divorcedwrap="${esc(cp.id)}" ${partnered?"":"hidden"}><input type="checkbox" data-divorced="${esc(cp.id)}" ${isDivorced(p,cp)?"checked":""}> Divorced</label>
        </div>`;
      }).join("");
      $("#coParentList").innerHTML = spouseRows + coParentRows;
    }
  } else {
    const fname = f ? (f.name||"this person").split(/\s+/)[0] : "";
    $("#sheetTitle").textContent = relWords[mode.rel] + (f && mode.rel!=="root" ? ` for ${fname}` : "");
    if(mode.rel!=="root"){
      const blocked = new Set([f.id, ...(f.parents||[]), ...(f.spouses||[]), ...childrenOf(f.id).map(c=>c.id)]);
      const others = [...people.values()].filter(p=>!p.placeholder && !blocked.has(p.id)).sort(byName);
      if(others.length){
        $("#pickWrap").hidden = false;
        $("#f-existing").innerHTML = `<option value="">Someone new</option>` + others.map(p=>`<option value="${esc(p.id)}">${esc(displayName(p))}${years(p)?" ("+esc(years(p))+")":""}</option>`).join("");
      }
    }
    if(mode.rel==="child"){
      $("#otherWrap").hidden = false;
      const otherIds = uniq([...(f.spouses||[]), ...childrenOf(f.id).flatMap(k=>(k.parents||[]).filter(id=>id!==f.id))]);
      const otherCandidates = otherIds.map(P).filter(Boolean);
      $("#f-other").innerHTML = otherCandidates.map(p=>`<option value="${esc(p.id)}">${esc(displayName(p))}</option>`).join("") + `<option value="">Not listed / unknown</option>`;
    }
    if(mode.rel==="parent"){
      const existing = parentsOf(f)[0];
      if(existing && !(existing.spouses||[]).length){
        $("#linkWrap").hidden = false;
        $("#linkText").textContent = `Partner of ${displayName(existing)}`;
      }
      // Not every physical record makes it clear which spouse is the blood
      // child and which married in - offer the "not sure which" option
      // whenever f has a partner who could equally be the one these belong
      // to, instead of silently assuming it's f.
      const uncertainPartner = partnersOf(f).find(sp=>!sp.placeholder && (sp.parents||[]).length<2);
      if(uncertainPartner){
        $("#uncertainWrap").hidden = false;
        $("#uncertainText").textContent = `Not sure if these are ${displayName(f)||"their"}'s parents or ${displayName(uncertainPartner)||"their partner"}'s`;
        $("#f-uncertain").checked = !!f.parentsUncertain;
      }
    }
  }
  $("#sheet").hidden = false;
  setTimeout(()=>$("#f-first").focus(), 50);
}
function closeSheet(){ $("#sheet").hidden = true; sheetMode = null; }

let resolvePersonId = null;
function openResolveSheet(id){
  const p = P(id); if(!p || !p.parentsUncertain) return;
  const partner = partnersOf(p)[0]; if(!partner) return;
  resolvePersonId = id;
  $("#resolveA").textContent = `${displayName(p)||"This person"}'s parents`;
  $("#resolveB").textContent = `${displayName(partner)||"Their partner"}'s parents`;
  $("#resolveParents").hidden = false;
}
$("#resolveA").addEventListener("click", async () => {
  const p = P(resolvePersonId); if(!p) return;
  const ok = await put({...p, parentsUncertain:false});
  if(ok){
    $("#resolveParents").hidden = true;
    toast(`Confirmed - ${displayName(p)||"their"}'s parents.`);
    setFocus(focusId); render();
  }
});
$("#resolveB").addEventListener("click", async () => {
  const p = P(resolvePersonId); if(!p) return;
  const partner = partnersOf(p)[0]; if(!partner) return;
  const parents = (p.parents||[]).slice(0,2);
  // The pair moves to the partner entirely - leaving it on both would
  // make them look like blood siblings married to each other instead of
  // spouses, which is exactly the mix-up marking it uncertain was meant
  // to avoid.
  const ok1 = await put({...partner, parents, parentsUncertain:false});
  const ok2 = await put({...p, parents:[], parentsUncertain:false});
  if(ok1 && ok2){
    $("#resolveParents").hidden = true;
    toast(`Confirmed - ${displayName(partner)||"their partner"}'s parents.`);
    setFocus(focusId); render();
  }
});

$("#f-existing").addEventListener("change", e => $("#sheetForm").classList.toggle("picking", !!e.target.value));
$("#coParentList").addEventListener("change", e => {
  const cb = e.target.closest("input[data-coparent]"); if(!cb) return;
  const wrap = $(`[data-divorcedwrap="${cb.dataset.coparent}"]`);
  if(wrap){ wrap.hidden = !cb.checked; if(!cb.checked) wrap.querySelector("input").checked = false; }
});
$$("#genderToggle button").forEach(b => b.addEventListener("click", () => setGender(b.dataset.gender)));

$("#sheetForm").addEventListener("submit", async e => {
  e.preventDefault();
  if(!sheetMode) return;
  const pickedId = !$("#pickWrap").hidden ? $("#f-existing").value : "";
  const firstName = $("#f-first").value.trim(), middleName = $("#f-middle").value.trim(), lastName = $("#f-last").value.trim();
  const gender = $("#f-gender").value;
  const fields = {
    name: fullName(firstName, middleName, lastName),
    firstName, middleName, lastName, gender,
    maidenName: gender==="f" ? $("#f-maiden").value.trim() : "",
    born: $("#f-born-y").value.trim(), bornMonth: $("#f-born-m").value, bornDay: $("#f-born-d").value.trim(),
    died: $("#f-died-y").value.trim(), diedMonth: $("#f-died-m").value, diedDay: $("#f-died-d").value.trim(),
    place: $("#f-place").value.trim(), note: $("#f-note").value.trim()
  };
  if(!pickedId && !fields.name){ toast("Add a name first."); $("#f-first").focus(); return; }
  $("#saveBtn").disabled = true;
  try {
    if(sheetMode.edit){
      const p = P(sheetMode.edit);
      const partnered = new Set([...document.querySelectorAll('#coParentList input[data-coparent]:checked')].map(el=>el.dataset.coparent));
      const notPartnerWith = editCoParents.filter(id=>!partnered.has(id));
      const divorcedSet = new Set([...document.querySelectorAll('#coParentList input[data-divorced]:checked')].map(el=>el.dataset.divorced));
      const divorced = uniq([...editCoParents, ...editFormalSpouses]).filter(id=>divorcedSet.has(id));
      const parentsUncertain = $("#uncertainWrap").hidden ? !!p.parentsUncertain : $("#f-uncertain").checked;
      await put({...p, ...fields, notPartnerWith, divorced, parentsUncertain});
      for(const cpId of editCoParents){
        const cp = P(cpId); if(!cp) continue;
        const cur = new Set(cp.notPartnerWith||[]);
        if(partnered.has(cpId)) cur.delete(p.id); else cur.add(p.id);
        const curDivorced = new Set(cp.divorced||[]);
        if(divorcedSet.has(cpId)) curDivorced.add(p.id); else curDivorced.delete(p.id);
        await put({...cp, notPartnerWith:[...cur], divorced:[...curDivorced]});
      }
      for(const spId of editFormalSpouses){
        const sp = P(spId); if(!sp) continue;
        const curDivorced = new Set(sp.divorced||[]);
        if(divorcedSet.has(spId)) curDivorced.add(p.id); else curDivorced.delete(p.id);
        await put({...sp, divorced:[...curDivorced]});
      }
    } else {
      const rel = sheetMode.rel, f = P(focusId);
      const person = pickedId ? {...P(pickedId)} : {id:newId(), ...fields, parents:[], spouses:[]};
      person.parents=[...(person.parents||[])]; person.spouses=[...(person.spouses||[])];
      if(rel==="root"){
        await put(person);
        await setDefaultFocus(person.id);
        setFocus(person.id);
      }
      else if(rel==="parent"){
        const other = parentsOf(f)[0];
        if(other && !$("#linkWrap").hidden && $("#f-link").checked){
          person.spouses = uniq([...person.spouses, other.id]);
          await put(person);
          await put({...other, spouses: uniq([...(other.spouses||[]), person.id])});
          await linkAsPartners(other.id, person.id);
        } else await put(person);
        const parentsUncertain = $("#uncertainWrap").hidden ? !!f.parentsUncertain : $("#f-uncertain").checked;
        await put({...f, parents: uniq([...(f.parents||[]), person.id]).slice(0,2), parentsUncertain});
      }
      else if(rel==="partner"){
        person.spouses = uniq([...person.spouses, f.id]);
        await put(person);
        await put({...f, spouses: uniq([...(f.spouses||[]), person.id])});
        await linkAsPartners(f.id, person.id);
      }
      else if(rel==="child"){
        const other = $("#f-other").value;
        person.parents = (pickedId ? uniq([...person.parents, f.id]) : [f.id, other].filter(Boolean)).slice(0,2);
        await put(person);
      }
      else if(rel==="sibling"){
        if(!person.parents.length){
          let shared = f.parents||[];
          if(!shared.length) shared = [await ensureParentPlaceholder(f.id)];
          person.parents = [...shared];
        } else if(pickedId) toast(`${displayName(person)} already has parents listed, so they weren't changed.`);
        await put(person);
      }
    }
    closeSheet(); render();
  } finally { $("#saveBtn").disabled = false; }
});

$("#delBtn").addEventListener("click", () => {
  const p = P(sheetMode.edit);
  $("#delText").textContent = `Remove ${displayName(p)||"this person"} from the tree for everyone? Their relatives stay.`;
  $("#delConfirm").hidden = false; $("#delBtn").hidden = true;
});
$("#delNo").addEventListener("click", () => { $("#delConfirm").hidden = true; $("#delBtn").hidden = false; });
$("#delYes").addEventListener("click", async () => {
  const id = sheetMode.edit;
  closeSheet();
  const p = P(id);
  const next = p ? (parentsOf(p)[0] || partnersOf(p)[0] || childrenOf(id)[0]) : null;
  for(const o of [...people.values()]){
    if(o.id!==id && ((o.parents||[]).includes(id) || (o.spouses||[]).includes(id))){
      await put({...o, parents:(o.parents||[]).filter(x=>x!==id), spouses:(o.spouses||[]).filter(x=>x!==id)});
    }
  }
  await drop(id);
  trail = trail.filter(x=>x!==id);
  if(next) setFocus(next.id); else { focusId = null; }
  render(); toast("Removed.");
});

/* ================= tree options menu ================= */
$("#menuBtn").addEventListener("click", () => {
  $("#inviteLink").value = location.origin + location.pathname + "#t=" + tree.key;
  $("#inviteName").textContent = `Or they can tap "Join a tree" and type the name "${tree.name}" with the password.`;
  $("#forgetBtn").textContent = "Remove this tree from this device";
  $("#forgetBtn").dataset.armed = "";
  const f = P(focusId);
  $("#setDefaultBtn").hidden = !f || f.placeholder || tree.defaultFocus===f.id;
  $("#setDefaultBtn").textContent = f ? `Set ${displayName(f)||"this person"} as everyone's starting point` : "Set as everyone's starting point";
  $("#colorGenderToggle").checked = app.classList.contains("color-gender");
  $("#showMiddleToggle").checked = showMiddleNames;
  $("#menu").hidden = false;
});
$("#showMiddleToggle").addEventListener("change", e => {
  showMiddleNames = e.target.checked;
  keySet("ft-showmiddle", e.target.checked ? "1" : "0");
  render();
});
$("#colorGenderToggle").addEventListener("change", e => {
  app.classList.toggle("color-gender", e.target.checked);
  keySet("ft-colorgender", e.target.checked ? "1" : "0");
});
$("#setDefaultBtn").addEventListener("click", async () => {
  const f = P(focusId); if(!f) return;
  const ok = await setDefaultFocus(f.id);
  if(ok){ setFocus(f.id); render(); toast(`${displayName(f)||"This person"} is now everyone's starting point.`); }
  $("#menu").hidden = true;
});
$("#copyBtn").addEventListener("click", async () => {
  const inp = $("#inviteLink");
  try { await navigator.clipboard.writeText(inp.value); toast("Invite link copied."); }
  catch(e){ inp.select(); toast("Select the link and copy it."); }
});
$("#switchBtn").addEventListener("click", () => { $("#menu").hidden = true; showHome(); });
$("#forgetBtn").addEventListener("click", e => {
  const b = e.currentTarget;
  if(!b.dataset.armed){ b.dataset.armed = "1"; b.textContent = "Tap again to remove. The tree stays online for everyone else."; return; }
  forgetTree(tree.key); $("#menu").hidden = true; showHome();
});

/* ================= pan the grid by dragging the background =================
   Plain mouse events rather than Pointer Events - touch users already get
   native scrolling from #app's overflow, this is specifically for desktop
   mice where the scrollbar can be easy to miss. */
let panState = null, dragged = false;
function onPanMove(e){
  if(!panState) return;
  const dx = e.clientX-panState.x, dy = e.clientY-panState.y;
  if(!dragged && (Math.abs(dx)>4 || Math.abs(dy)>4)){ dragged = true; app.classList.add("panning"); }
  if(dragged){ app.scrollLeft = panState.left - dx; app.scrollTop = panState.top - dy; }
}
function onPanEnd(){
  panState = null; app.classList.remove("panning");
  document.removeEventListener("mousemove", onPanMove);
  document.removeEventListener("mouseup", onPanEnd);
}
app.addEventListener("mousedown", e => {
  if(view!=="tree" || e.button!==0) return;
  if(e.target.closest(".node") || e.target.closest(".dock")) return;
  panState = {x:e.clientX, y:e.clientY, left:app.scrollLeft, top:app.scrollTop};
  dragged = false;
  document.addEventListener("mousemove", onPanMove);
  document.addEventListener("mouseup", onPanEnd);
});
// Scrolling the wheel (or a trackpad's vertical swipe) zooms instead of
// panning the page - panning already has the click-drag gesture above
// plus native touch-scroll, so the wheel is free to repurpose, same as
// most map-style canvases.
app.addEventListener("wheel", e => {
  if(view!=="tree" || e.target.closest(".dock")) return;
  e.preventDefault();
  zoom = Math.min(1.5, Math.max(0.25, +(zoom + (e.deltaY<0?0.08:-0.08)).toFixed(2)));
  applyZoom(); keySet("ft-zoom", zoom); render();
}, {passive:false});

/* ================= events ================= */
document.addEventListener("click", e => {
  if(dragged){ dragged = false; e.stopPropagation(); e.preventDefault(); return; }
  // The uncertain-parents "?" sits inside a [data-go] node button, so it
  // has to be checked first - otherwise tapping it would also fire the
  // node's own navigate behavior underneath it.
  const rv = e.target.closest("[data-resolve]");
  if(rv) return openResolveSheet(rv.dataset.resolve);
  const g = e.target.closest("[data-go]");
  if(g){
    const id = g.dataset.go, p = P(id);
    if(p && p.placeholder) return openSheet({edit:id});
    if(id === focusId) return openSheet({edit:id});
    return go(id);
  }
  const a = e.target.closest("[data-add]"); if(a) return openSheet({rel:a.dataset.add});
  const ed = e.target.closest("[data-edit]"); if(ed) return openSheet({edit:ed.dataset.edit});
  if(e.target.closest("[data-close]")) return closeSheet();
  if(e.target.closest("[data-closemenu]")) $("#menu").hidden = true;
  if(e.target.closest("[data-closeresolve]")) $("#resolveParents").hidden = true;
});
document.addEventListener("keydown", e => { if(e.key==="Escape"){ closeSheet(); $("#menu").hidden = true; } });
app.addEventListener("input", e => { if(e.target.id==="q"){ query=e.target.value; render(); } });
$("#tabTree").addEventListener("click", () => { view="tree"; render(); });
$("#tabAll").addEventListener("click", () => { view="all"; render(); });
$("#backBtn").addEventListener("click", () => { const id = trail.pop(); if(id && P(id)) go(id,false); else render(); });

/* ================= start ================= */
(async () => {
  if(firebaseConfig.apiKey === "PASTE_ME"){
    document.body.innerHTML = `<p style="padding:24px;font-family:sans-serif">This site isn't connected to its database yet. Add the Firebase settings to firebase-config.js.</p>`;
    return;
  }
  const m = location.hash.match(/t=([0-9a-f]{64})/);
  if(m){
    const ok = await openTree(m[1]);
    if(!ok){ showHome(); toast("That invite link doesn't match a tree."); }
    return;
  }
  const saved = savedTrees();
  if(saved.length === 1){ if(await openTree(saved[0].key)) return; }
  showHome();
})();
