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
// the anchor currently driving layout for this device's session (see
// setFocus); currentAnchor mirrors it during a render pass so splitParents
// doesn't need activeAnchor threaded through every call.
let activeAnchor = null, currentAnchor = null;
let editCoParents = [];
const app = $("#app");
const P = id => people.get(id);
if(keyGet("ft-colorgender")!=="0") app.classList.add("color-gender");
let showAnchorMode = keyGet("ft-showanchor")==="1";
let showMiddleNames = keyGet("ft-showmiddle")==="1";

/* zoom only affects the coordinate-based pedigree grid (the "zoom" CSS
   property rescales its whole layout box, scrollable area included, so
   #app's native scrollbars stay correct at any zoom level - no coordinate
   math to redo, unlike the browser's own page zoom which scales everything
   including the header and dock). */
let zoom = Math.min(1.5, Math.max(0.4, Number(keyGet("ft-zoom")) || 1));
function applyZoom(){ document.documentElement.style.setProperty("--zoom", zoom); }
applyZoom();
$("#zoomIn").addEventListener("click", () => { zoom = Math.min(1.5, +(zoom+0.15).toFixed(2)); applyZoom(); keySet("ft-zoom", zoom); });
$("#zoomOut").addEventListener("click", () => { zoom = Math.max(0.4, +(zoom-0.15).toFixed(2)); applyZoom(); keySet("ft-zoom", zoom); });
$("#zoomReset").addEventListener("click", () => { zoom = 1; applyZoom(); keySet("ft-zoom", zoom); });

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
  activeAnchor = keyGet("ft-anchor-" + key) || null;
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
    notPartnerWith: (p.notPartnerWith||[]).slice(0,20), updated: Date.now()
  };
  if(p.placeholder && !data.name) data.placeholder = true;
  if(p.anchor) data.anchor = true;
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
/* Moves focus to `id`, and keeps the active anchor stable if `id` is
   still reachable from it (so clicking around inside the same family
   line never jumps the frame) - only switching anchors when the newly
   focused person's own lineage doesn't lead back to the one currently
   showing, e.g. clicking a parent whose side has a different anchor. */
function setFocus(id){
  if(!P(id)) return;
  const reachable = reachableAnchors(id);
  activeAnchor = (activeAnchor && reachable.has(activeAnchor)) ? activeAnchor : (reachable.size ? firstReachableAnchor(id) : null);
  focusId = id;
  if(tree) keySet("ft-anchor-" + tree.key, activeAnchor || "");
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

/* A real family tree branches both ways going up, and fully expanding both
   parents at every single generation doubles the width each time - by a
   few generations it's an unreadable wall. So ancestors only expand up to
   the nearest "anchor point" - a person marked as a hard stop, either
   explicitly (their own Anchor point checkbox) or because they're the
   tree's shared starting point. Someone with two parents who each lead to
   a DIFFERENT anchor (one parent's line hits Grammy, the other hits a
   different ancestor entirely) has to pick one side to actively show -
   that choice is "the active anchor", tracked per device in localStorage
   and left alone as long as it still applies, so browsing around a family
   line doesn't make the frame jump every click (see setFocus below). The
   other side becomes a tap-to-explore dead end, exactly like a spouse -
   tapping it switches the active anchor to their own side instead. */
const isAnchor = p => !!p && (p.anchor===true || (tree && tree.defaultFocus===p.id));
function reachableAnchors(id, visited){
  visited = visited || new Set();
  const result = new Set();
  if(!id || visited.has(id)) return result;
  visited.add(id);
  const p = P(id); if(!p) return result;
  if(isAnchor(p)){ result.add(id); return result; }
  parentsOf(p).forEach(par => reachableAnchors(par.id, visited).forEach(a=>result.add(a)));
  return result;
}
function firstReachableAnchor(id, visited){
  visited = visited || new Set();
  if(!id || visited.has(id)) return null;
  visited.add(id);
  const p = P(id); if(!p) return null;
  if(isAnchor(p)) return id;
  for(const par of parentsOf(p)){
    const found = firstReachableAnchor(par.id, visited);
    if(found) return found;
  }
  return null;
}
// A couple's left/right order is always by gender (male left, female
// right, unknown gender in between) rather than by who happens to be the
// blood relative being traced through at the moment - otherwise the same
// couple flips sides depending on which side of the family is currently
// expanding (switching from Dad's anchor to Mom's makes HER the "pivot"
// instead of him, which used to swap which side each of them sat on).
const genderRank = p => !p ? 1 : p.gender==="m" ? 0 : p.gender==="f" ? 2 : 1;
const sortIdsByGender = ids => [...ids].sort((a,b)=>genderRank(P(a))-genderRank(P(b)));
const sortCoupleByGender = people => [...people].sort((a,b)=>genderRank(a)-genderRank(b));
function splitParents(parents){
  if(parents.length===2 && currentAnchor){
    // once one of the two parents IS the active anchor itself, the search
    // is over - expand both normally, so the anchor's own spouse is just
    // their spouse (via the usual attachment below), not a second,
    // duplicate "suppressed" placement of the same person.
    if(parents[0].id===currentAnchor || parents[1].id===currentAnchor){
      return {expand:sortCoupleByGender(parents), suppressed:null};
    }
    const leads = parents.map(par=>reachableAnchors(par.id).has(currentAnchor));
    if(leads[0] !== leads[1]){
      const idx = leads[0] ? 0 : 1;
      return {expand:[parents[idx]], suppressed:parents[1-idx]};
    }
  }
  return {expand: parents.length===2 ? sortCoupleByGender(parents) : parents, suppressed:null};
}

function ancWidth(id, excludeSpouseId, extraPartnerId){
  const p = P(id);
  const sibs = siblingsOf(p).map(s=>s.p);
  const folks = [p, ...sibs];
  const rowWidth = folks.reduce((sum,f)=> sum + 1 + partnersOf(f).filter(s=>!(f.id===p.id && s.id===excludeSpouseId)).length + ((f.id===p.id && extraPartnerId)?1:0), 0);
  // an anchor is a hard stop - never recurse past one into its own
  // parents, even if it happens to have some recorded.
  const {expand, suppressed} = isAnchor(p) ? {expand:[], suppressed:null} : splitParents(parentsOf(p));
  // a suppressed co-parent who IS already a registered spouse gets placed
  // by the expanding parent's own row, like any other partner - only a
  // suppressed co-parent with no spouse record of their own needs this
  // extra reserved unit, passed down so it lands right next to them.
  const upWidth = expand.length
    ? expand.reduce((sum,par,i)=>{
        const exclude = expand.length>1 ? expand[1-i].id : null;
        const extra = (expand.length===1 && suppressed && !(par.spouses||[]).includes(suppressed.id)) ? suppressed.id : null;
        return sum + ancWidth(par.id, exclude, extra);
      }, 0)
    : 0;
  return Math.max(rowWidth, upWidth, 1);
}
function descWidth(id){
  const p = P(id);
  const rowWidth = 1 + partnersOf(p).length;
  const kids = childrenOf(id);
  const downWidth = kids.length ? kids.reduce((sum,k)=>sum+descWidth(k.id),0) : 0;
  return Math.max(rowWidth, downWidth, 1);
}

function placeAncestor(placed, edges, id, excludeSpouseId, xLeft, width, gen, extraPartnerId){
  const p = P(id);
  const parents = parentsOf(p);
  const {expand, suppressed} = isAnchor(p) ? {expand:[], suppressed:null} : splitParents(parents);
  const parentPos = [];
  if(expand.length){
    // same reserved-extra-unit rule as ancWidth: only a suppressed
    // co-parent with no spouse record of their own needs to ride along
    // as an extra attachment on the expanding parent's own row - one
    // already recorded as a spouse gets placed by that row normally.
    const excludeFor = i => expand.length>1 ? expand[1-i].id : null;
    const extraFor = i => (expand.length===1 && suppressed && !(expand[i].spouses||[]).includes(suppressed.id)) ? suppressed.id : null;
    const widths = expand.map((par,i)=>ancWidth(par.id, excludeFor(i), extraFor(i)));
    const totalW = widths.reduce((a,b)=>a+b,0);
    let px = xLeft + (width-totalW)/2;
    expand.forEach((par,i)=>{
      parentPos.push(placeAncestor(placed, edges, par.id, excludeFor(i), px, widths[i], gen-1, extraFor(i)));
      px += widths[i];
    });
    // when both parents are each their own blood ancestor fork (both have
    // their own further ancestry, so neither is a plain dead-end spouse
    // attachment), they still need a tie line drawn here - sharing this
    // child assumes they're a couple for this diagram by default, unless
    // explicitly marked otherwise (notPartnerWith, set from the Edit sheet).
    if(expand.length===2 && !(expand[0].notPartnerWith||[]).includes(expand[1].id)){
      edges.push({tie:true, a:parentPos[0], b:parentPos[1]});
    }
    // a suppressed co-parent is otherwise placed by the expanding parent's
    // own row below (either normally, as a registered spouse, or via
    // extraPartnerId right above) - nothing left to do here.
  }
  const sibs = siblingsOf(p);
  const folks = [{person:p, half:false, isPivot:true}, ...sibs.map(s=>({person:s.p, half:s.half, isPivot:false}))]
    .sort((a,b)=>byBorn(a.person,b.person));
  const rowWidth = folks.reduce((sum,f)=> sum + 1 + partnersOf(f.person).filter(s=>!(f.isPivot && s.id===excludeSpouseId)).length + ((f.isPivot && extraPartnerId)?1:0), 0);
  // Centering this row purely within the space handed down from the child
  // below breaks once the pivot has many siblings: the pivot's own spot
  // inside that wide sibling row depends on sort order, not the row's
  // midpoint, so a single-child descendant centered on the row's midpoint
  // could land far from where the pivot actually ended up. Center on the
  // parents' own actual position instead (clamped to the space we were
  // given, so sibling forks still never overlap each other).
  let cursor;
  if(parentPos.length){
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
    const posOf = {};
    unitIds.forEach(uid => { posOf[uid] = cursor+0.5; cursor++; });

    const x = posOf[person.id];
    placed.push({id:person.id, x, gen, half:f.half, placeholder:!!person.placeholder, deadEnd:!f.isPivot});
    if(f.isPivot) pivotPos = {x, gen};

    const myParents = person.parents||[];
    const connected = parentPos.filter((pp,i)=> myParents.includes(expand[i].id)).map(pp=>({x:pp.x, gen:pp.gen}));
    // these two parents are each their own independently-placed ancestor
    // fork, so they may not sit next to each other - never collapse them
    // to a single midpoint trunk (adjacent:false forces a stub per parent).
    if(connected.length) edges.push({childX:x, childGen:gen, parents:connected, adjacent:false});

    partners.forEach(sp=>{
      const sx = posOf[sp.id];
      placed.push({id:sp.id, x:sx, gen, dim:true, placeholder:!!sp.placeholder, deadEnd:true});
      edges.push({tie:true, a:{x, gen}, b:{x:sx, gen}});
    });
    if(extra){
      const sx = posOf[extra.id];
      placed.push({id:extra.id, x:sx, gen, dim:true, placeholder:!!extra.placeholder, deadEnd:true});
      edges.push({tie:true, a:{x, gen}, b:{x:sx, gen}});
    }
  });
  return pivotPos;
}
function placeDescendant(placed, edges, id, xLeft, width, gen){
  const p = P(id);
  const partners = partnersOf(p);
  // The pivot + their spouse(s) only need (1 + partners.length) slots, but
  // `width` can be wider than that to make room for grandchildren below -
  // center that couple unit within the full width rather than centering
  // the pivot alone, otherwise a spouse can land right on the boundary
  // with the next sibling's own space when there's no extra room needed.
  const unitWidth = 1 + partners.length;
  const unitLeft = xLeft + (width-unitWidth)/2;
  const unitIds = sortIdsByGender([p.id, ...partners.map(s=>s.id)]);
  const posOf = {};
  unitIds.forEach((uid,i) => { posOf[uid] = unitLeft + i + 0.5; });
  const x = posOf[p.id];
  placed.push({id:p.id, x, gen, placeholder:!!p.placeholder});

  const spouseX = new Map();
  partners.forEach(sp=>{
    const sx = posOf[sp.id];
    placed.push({id:sp.id, x:sx, gen, dim:true, placeholder:!!sp.placeholder, deadEnd:true});
    edges.push({tie:true, a:{x, gen}, b:{x:sx, gen}});
    spouseX.set(sp.id, sx);
  });

  const kids = childrenOf(id).sort(byBorn);
  if(kids.length){
    const widths = kids.map(k=>descWidth(k.id));
    const totalW = widths.reduce((a,b)=>a+b,0);
    // center the children block on the full allocated width, not on the
    // pivot's own position - when the pivot has a spouse, their own x sits
    // left of that width's true center, which would shove a wide block of
    // grandchildren left too, overlapping whatever's allocated next door.
    let cx = (xLeft + width/2) - totalW/2;
    kids.forEach((k,i)=>{
      const kpos = placeDescendant(placed, edges, k.id, cx, widths[i], gen+1);
      const kp = P(k.id);
      const parentPts = [{x, gen}];
      (kp.parents||[]).forEach(pid=>{ if(spouseX.has(pid)) parentPts.push({x:spouseX.get(pid), gen}); });
      // the pivot's own attached spouse always sits right next to them, so
      // a single trunk from their shared midpoint always looks right here.
      edges.push({childX:kpos.x, childGen:kpos.gen, parents:parentPts, adjacent:true});
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
    if(e.tie){
      svg += `<line x1="${px(e.a.x).toFixed(1)}" y1="${py(e.a.gen).toFixed(1)}" x2="${px(e.b.x).toFixed(1)}" y2="${py(e.b.gen).toFixed(1)}" class="tie-line"/>`;
      return;
    }
    const key = e.parents.map(p=>p.x+","+p.gen).sort().join("|");
    if(!groups.has(key)) groups.set(key, {parents:e.parents, children:[], adjacent:e.adjacent});
    groups.get(key).children.push({x:e.childX, gen:e.childGen});
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
      svg += `<line x1="${childPx[i].toFixed(1)}" y1="${busY.toFixed(1)}" x2="${childPx[i].toFixed(1)}" y2="${py(c.gen).toFixed(1)}" class="fam-line"/>`;
    });
  });
  return svg;
}

function bubbleHtml(n, x, y){
  const p = P(n.id); if(!p) return "";
  if(p.placeholder) return `<button class="node ph" style="left:${x}px;top:${y}px" data-go="${esc(n.id)}">Unknown</button>`;
  const more = n.deadEnd && (parentsOf(p).length || childrenOf(p.id).length);
  const genderCls = p.gender==="m" ? " g-m" : p.gender==="f" ? " g-f" : "";
  return `<button class="node${n.dim?" dim":""}${n.id===focusId?" me":""}${more?" more":""}${genderCls}" style="left:${x}px;top:${y}px" data-go="${esc(n.id)}">
    <span class="nm">${esc(displayName(p)||"Unnamed")}${isAnchor(p)?` <span class="anchorBadge" title="Anchor point">⚓</span>`:""}</span>
    ${p.maidenName?`<span class="maiden">(${esc(p.maidenName)})</span>`:""}
    <span class="yrs${birthKnown(p)?"":" unk"}">${esc(birthLabel(p))}</span>
    ${n.half?`<span class="chip">half</span>`:""}
  </button>`;
}
function dockHtml(f, otherAnchors){
  if(!f || f.placeholder) return "";
  const hint = otherAnchors && otherAnchors.length
    ? `<p class="anchorHint">Also connected through ${otherAnchors.map(id=>esc(displayName(P(id))||"another line")).join(", ")} — tap a parent above to switch sides.</p>` : "";
  return `<div class="dock">
    <div class="dockInfo"><strong>${esc(displayName(f)||"Unnamed")}</strong>${isAnchor(f)?` <span class="anchorBadge" title="Anchor point">⚓</span>`:""}${years(f)?` <span class="yrs">${esc(years(f))}</span>`:""}${f.maidenName?`<div class="maiden">(${esc(f.maidenName)})</div>`:""}${f.place?`<div class="place">${esc(f.place)}</div>`:""}${hint}</div>
    <div class="dockBtns">
      ${(f.parents||[]).length<2?`<button class="dbtn" data-add="parent">+ Parent</button>`:""}
      <button class="dbtn" data-add="partner">+ Partner</button>
      <button class="dbtn" data-add="child">+ Child</button>
      <button class="dbtn" data-add="sibling">+ Sibling</button>
      ${showAnchorMode?`<button class="dbtn" data-options="${esc(f.id)}">⋯</button>`:""}
      <button class="dbtn edit" data-edit="${esc(f.id)}">Edit</button>
    </div>
  </div>`;
}
function renderPedigree(){
  if(!people.size){
    return `<div class="empty"><h2>Start your tree</h2><p>Add yourself or the oldest relative you know. Then add their parents, partners and children from their card.</p><button class="primary" data-add="root">Add the first person</button></div>`;
  }
  pickFocus();
  // the grid is always laid out from the active anchor downward (so
  // clicking around inside the same family line never moves anyone who
  // was already on screen) - the clicked person (focusId) just gets the
  // "me" highlight and drives the dock, wherever they land in that grid.
  const rootId = (activeAnchor && P(activeAnchor)) ? activeAnchor : focusId;
  const root = P(rootId);
  if(!root) return `<p class="hint">Nobody to show.</p>`;
  currentAnchor = activeAnchor;

  const placed = [], edges = [];
  const focalPos = placeAncestor(placed, edges, root.id, null, 0, ancWidth(root.id, null), 0);
  const focalSpouseX = new Map();
  partnersOf(root).forEach(sp=>{ const n = placed.find(x=>x.id===sp.id); if(n) focalSpouseX.set(sp.id, n.x); });

  const kids = childrenOf(root.id).sort(byBorn);
  if(kids.length){
    const widths = kids.map(k=>descWidth(k.id));
    const totalW = widths.reduce((a,b)=>a+b,0);
    // center on the root+spouse couple's own midpoint, same as inside
    // placeDescendant, so a spouse doesn't pull the whole fan off-center.
    const spouseXs = [...focalSpouseX.values()];
    const coupleCenter = spouseXs.length ? [focalPos.x, ...spouseXs].reduce((a,b)=>a+b,0)/(spouseXs.length+1) : focalPos.x;
    let cx = coupleCenter - totalW/2;
    kids.forEach((k,i)=>{
      const kpos = placeDescendant(placed, edges, k.id, cx, widths[i], 1);
      const kp = P(k.id);
      const parentPts = [{x:focalPos.x, gen:0}];
      (kp.parents||[]).forEach(pid=>{ if(focalSpouseX.has(pid)) parentPts.push({x:focalSpouseX.get(pid), gen:0}); });
      edges.push({childX:kpos.x, childGen:kpos.gen, parents:parentPts, adjacent:true});
      cx += widths[i];
    });
  }

  const xs = placed.map(n=>n.x), gens = placed.map(n=>n.gen);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minGen = Math.min(...gens), maxGen = Math.max(...gens);
  const PAD_X = 70, PAD_Y = 60;
  const px = x => (x-minX)*SLOT_W + PAD_X;
  const py = g => (g-minGen)*ROW_H + PAD_Y;
  const width = (maxX-minX)*SLOT_W + PAD_X*2;
  const height = (maxGen-minGen)*ROW_H + PAD_Y*2 + 170;

  const linesHtml = renderEdges(edges, px, py);
  const nodesHtml = placed.map(n => bubbleHtml(n, px(n.x), py(n.gen))).join("");

  const selected = P(focusId);
  const otherAnchors = selected ? [...reachableAnchors(selected.id)].filter(a=>a!==activeAnchor) : [];
  return `<div class="pedigree" style="width:${width}px;height:${height}px">
    <svg class="lines" width="${width}" height="${height}">${linesHtml}</svg>
    ${nodesHtml}
  </div>${dockHtml(selected, otherAnchors)}`;
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
  return `<button class="card${genderCls}" data-go="${esc(p.id)}"><span class="nm">${esc(displayName(p)||"Unnamed")}${isAnchor(p)?` <span class="anchorBadge" title="Anchor point">⚓</span>`:""}</span>${p.maidenName?`<span class="maiden">(${esc(p.maidenName)})</span>`:""}${y?`<span class="yrs">${esc(y)}</span>`:""}${kids?`<span class="meta"><span class="chip">${kids} ${kids===1?"child":"children"}</span></span>`:""}</button>`;
}

// Which (focusId, activeAnchor) pair we last auto-scrolled to - re-scroll
// only when either actually changes (real navigation), never on a plain
// re-render triggered by someone else's edit syncing in elsewhere in the
// tree, which would otherwise yank the view out from under you.
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
    const key = focusId + "|" + activeAnchor;
    if(key !== lastScrollKey){
      lastScrollKey = key;
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
  $("#coParentWrap").hidden = true; editCoParents = [];
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
    const coParents = uniq(childrenOf(p.id).flatMap(k => (k.parents||[]).filter(id=>id!==p.id))).map(P).filter(Boolean);
    if(coParents.length && !p.placeholder){
      editCoParents = coParents.map(cp=>cp.id);
      $("#coParentWrap").hidden = false;
      $("#coParentList").innerHTML = coParents.map(cp =>
        `<label class="check"><input type="checkbox" data-coparent="${esc(cp.id)}" ${(p.notPartnerWith||[]).includes(cp.id)?"":"checked"}> ${esc(displayName(cp)||"Unnamed")}</label>`
      ).join("");
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
    }
  }
  $("#sheet").hidden = false;
  setTimeout(()=>$("#f-first").focus(), 50);
}
function closeSheet(){ $("#sheet").hidden = true; sheetMode = null; }

let optionsPersonId = null;
function openPersonOptions(id){
  const p = P(id); if(!p) return;
  optionsPersonId = id;
  $("#personOptionsTitle").textContent = `Options for ${displayName(p)||"this person"}`;
  const isDefault = tree.defaultFocus === p.id;
  $("#optAnchor").checked = isDefault || !!p.anchor;
  $("#optAnchor").disabled = isDefault;
  $("#optAnchorHint").textContent = isDefault
    ? "This is the tree's starting point, so it's always an anchor."
    : "Ancestors stop expanding automatically once they reach an anchor — tap it to explore further back instead.";
  $("#personOptions").hidden = false;
}
$("#optAnchor").addEventListener("change", async e => {
  const p = P(optionsPersonId); if(!p) return;
  const ok = await put({...p, anchor: e.target.checked});
  if(ok){
    toast(e.target.checked ? `${displayName(p)||"This person"} is now an anchor point.` : `${displayName(p)||"This person"} is no longer an anchor point.`);
    setFocus(focusId); render();
  }
});

$("#f-existing").addEventListener("change", e => $("#sheetForm").classList.toggle("picking", !!e.target.value));
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
      await put({...p, ...fields, notPartnerWith});
      for(const cpId of editCoParents){
        const cp = P(cpId); if(!cp) continue;
        const cur = new Set(cp.notPartnerWith||[]);
        if(partnered.has(cpId)) cur.delete(p.id); else cur.add(p.id);
        await put({...cp, notPartnerWith:[...cur]});
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
        } else await put(person);
        await put({...f, parents: uniq([...(f.parents||[]), person.id]).slice(0,2)});
      }
      else if(rel==="partner"){
        person.spouses = uniq([...person.spouses, f.id]);
        await put(person);
        await put({...f, spouses: uniq([...(f.spouses||[]), person.id])});
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
  if(next) setFocus(next.id); else { focusId = null; activeAnchor = null; }
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
  $("#showAnchorToggle").checked = showAnchorMode;
  $("#menu").hidden = false;
});
$("#showMiddleToggle").addEventListener("change", e => {
  showMiddleNames = e.target.checked;
  keySet("ft-showmiddle", e.target.checked ? "1" : "0");
  render();
});
$("#showAnchorToggle").addEventListener("change", e => {
  showAnchorMode = e.target.checked;
  keySet("ft-showanchor", e.target.checked ? "1" : "0");
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

/* ================= events ================= */
document.addEventListener("click", e => {
  if(dragged){ dragged = false; e.stopPropagation(); e.preventDefault(); return; }
  const g = e.target.closest("[data-go]");
  if(g){
    const id = g.dataset.go, p = P(id);
    if(p && p.placeholder) return openSheet({edit:id});
    if(id === focusId) return openSheet({edit:id});
    // someone with no recorded parents AND no recorded children (e.g. a
    // spouse who was never actually added as a parent on their kids, just
    // linked as a partner) has nothing to navigate to - tapping them to
    // "explore" would just collapse the view down to them alone with
    // nobody else on screen, so open them for editing instead.
    if(p && !parentsOf(p).length && !childrenOf(p.id).length) return openSheet({edit:id});
    return go(id);
  }
  const a = e.target.closest("[data-add]"); if(a) return openSheet({rel:a.dataset.add});
  const ed = e.target.closest("[data-edit]"); if(ed) return openSheet({edit:ed.dataset.edit});
  const op = e.target.closest("[data-options]"); if(op) return openPersonOptions(op.dataset.options);
  if(e.target.closest("[data-close]")) return closeSheet();
  if(e.target.closest("[data-closemenu]")) $("#menu").hidden = true;
  if(e.target.closest("[data-closeoptions]")) $("#personOptions").hidden = true;
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
