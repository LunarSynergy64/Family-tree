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
// rootId: who the whole grid is positioned relative to - only changes
// when you tap an in-law (someone attached by marriage, not blood: see
// the "dim" nodes in bubbleHtml), since their own ancestry isn't drawn
// yet and needs a fresh grid to show it. focusId: who's actually
// selected right now (shown in the dock, highlighted, edited) - this
// changes on every tap, blood relative or not, since anyone blood-
// related to rootId is already on screen and just needs picking, not a
// whole new grid.
let people = new Map(), rootId = null, focusId = null, trail = [], view = "tree", loaded = false, query = "", offlineNote = "";
let sheetMode = null;
let editCoParents = [], editFormalSpouses = [];
// Manual layout editing: a toggleable mode where tapping a box selects it
// (tap again to deselect; tap several to build a group) and dragging a
// selected box moves every selected box together by the same amount - or,
// if nothing's selected yet, dragging a box just moves that one. Offsets
// and size overrides are saved per person (layoutDx/layoutDy/layoutScale),
// shared for everyone, same as everything else in the tree.
let editLayout = false;
let selectedIds = new Set();
function offsetOf(id){
  if(!id) return {dx:0, dy:0};
  // A couple's position is read from one deterministically-chosen member
  // of the group (whoever has the lexicographically smallest id) instead
  // of each person's own stored fields - so even if the two ever end up
  // with different layoutDx/Dy on disk (old data from before this box
  // existed, a bug, a half-applied write), they still always render
  // locked together, same box, same spot. groupAnchorId is defined further
  // down but hoists fine - it's a function declaration, same as this one.
  const anchor = groupAnchorId(id);
  const p = P(anchor);
  return {dx:(p&&p.layoutDx)||0, dy:(p&&p.layoutDy)||0};
}
const app = $("#app");
const P = id => people.get(id);
if(keyGet("ft-colorgender")!=="0") app.classList.add("color-gender");
let showMiddleNames = keyGet("ft-showmiddle")==="1";

/* zoom only affects the coordinate-based pedigree grid (the "zoom" CSS
   property rescales its whole layout box, scrollable area included, so
   #app's native scrollbars stay correct at any zoom level - no coordinate
   math to redo, unlike the browser's own page zoom which scales everything
   including the header and dock). */
// Wide, multiplicative range - ancestors and distant descendants can differ
// in on-screen size by a lot, and manual resizing (layoutScale) widens that
// further, so the zoom needs enough range (and the same % change at every
// level, not a fixed step) to bring any of it back into view.
const ZOOM_MIN = 0.02, ZOOM_MAX = 20, ZOOM_STEP = 1.4;
let zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(keyGet("ft-zoom")) || 1));
function applyZoom(){ document.documentElement.style.setProperty("--zoom", zoom); }
applyZoom();
// The "zoom" CSS property always scales from its own top-left corner, so
// changing it with no further adjustment visibly drags everything toward
// (or away from) that corner. Keep whatever's under the given screen
// point (the cursor for the wheel, the viewport's own center for the
// buttons) fixed in place instead, same idea as a map's own zoom control.
function zoomTo(newZoom, anchorClientX, anchorClientY){
  newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
  if(newZoom===zoom) return;
  const rect = app.getBoundingClientRect();
  const ax = anchorClientX!=null ? anchorClientX-rect.left : rect.width/2;
  const ay = anchorClientY!=null ? anchorClientY-rect.top : rect.height/2;
  const worldX = (app.scrollLeft+ax)/zoom, worldY = (app.scrollTop+ay)/zoom;
  zoom = newZoom;
  applyZoom(); keySet("ft-zoom", zoom); render();
  app.scrollLeft = worldX*zoom - ax;
  app.scrollTop = worldY*zoom - ay;
}
$("#zoomIn").addEventListener("click", () => zoomTo(+(zoom*ZOOM_STEP).toFixed(4)));
$("#zoomOut").addEventListener("click", () => zoomTo(+(zoom/ZOOM_STEP).toFixed(4)));
$("#zoomReset").addEventListener("click", () => zoomTo(1));

function showHome(){
  if(unsub){ unsub(); unsub = null; }
  tree = null; people = new Map(); rootId = null; focusId = null; trail = [];
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
  loaded = false; offlineNote = ""; view = "tree"; trail = []; rootId = null; focusId = null;
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
// Everyone reachable by following spouses links from id, however many
// hops - not just id's own direct partners. A remarriage (id's two
// spouses, not married to each other) is still one connected group this
// way, so moving or collapsing any one of the three - not only id
// itself - carries the whole group, matching how they're always drawn
// adjacent to one another regardless of which of them you start from.
function partnerGroupOf(id){
  const group = new Set([id]), queue = [id];
  while(queue.length){
    const p = P(queue.pop());
    ((p && p.spouses) || []).forEach(spId => { if(!group.has(spId)){ group.add(spId); queue.push(spId); } });
  }
  group.delete(id);
  return [...group].map(P).filter(Boolean);
}
// The one id every member of a partner group defers to for shared state
// (right now, position) - picked by sorting, not by any role, so it's
// the same answer no matter which member you ask from.
function groupAnchorId(id){
  return [id, ...partnerGroupOf(id).map(p=>p.id)].sort()[0];
}
const childrenOf = id => [...people.values()].filter(c => (c.parents||[]).includes(id));
// Kids belong to whichever specific member(s) fathered/mothered them, not
// the group as a whole - a remarriage's two partners can easily have no
// children together at all - so this is the union of each member's own
// children, never-manually-dragged ones only (see offsetOf's own note on
// why that, not how the auto layout happens to look, is what "placed"
// actually means).
function unplacedChildrenOf(memberIds){
  return [...new Map(memberIds.flatMap(id=>childrenOf(id)).map(k=>[k.id,k])).values()]
    .filter(k => k.layoutDx==null && k.layoutDy==null);
}
// What the layout actually draws below someone - never anyone collapsed
// away (their own box stands in for the whole branch), and, on top of
// that, never a child who hasn't actually been placed yet (added fresh,
// or revealed by un-collapsing - either way nothing to show until they
// show up in the couple panel's "not yet placed" list and get placed
// from there, or get dragged once they are showing). Only descendants
// work this way - a blood person's own spouse still renders alongside
// them regardless, same as always, and ancestors above the root aren't
// touched by this at all. Everywhere else - the "X children" count,
// deleting someone, linking partners - still needs the true list
// regardless of collapsed/placed state, so this is only for
// placement/width math, never a replacement for childrenOf itself.
const visibleChildren = id => {
  const p = P(id);
  if(p && p.collapsed) return [];
  return childrenOf(id).filter(c => c.layoutDx!=null || c.layoutDy!=null);
};
// Everyone connected to id purely by blood - id's own ancestor chain,
// however far back, plus everyone descended from any of them (so
// siblings, cousins, the lot, same as the pedigree itself shows). Two
// strictly separate passes, not one mixed walk: going up only ever
// follows id's own recorded parents, and going down from there only
// ever follows childrenOf, never back up through a discovered child's
// OTHER parent - that other parent is exactly where an in-law's own,
// separate blood family would start (they can easily be a real blood
// parent of a shared child without being blood to id at all), so a bulk
// action scoped this way never reaches into it.
function bloodFamilyOf(id){
  const ancestors = new Set([id]);
  let queue = [id];
  while(queue.length){
    const cur = queue.pop();
    const p = P(cur); if(!p) continue;
    (p.parents||[]).forEach(pid => { if(!ancestors.has(pid)){ ancestors.add(pid); queue.push(pid); } });
  }
  const visited = new Set(ancestors);
  queue = [...ancestors];
  while(queue.length){
    const cur = queue.pop();
    childrenOf(cur).forEach(k => { if(!visited.has(k.id)){ visited.add(k.id); queue.push(k.id); } });
  }
  return [...visited];
}
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
  if(p.collapsed) data.collapsed = true;
  // Explicitly-set zero is a real, meaningful value here (see placeChild:
  // "manually placed, right where the grid already had them" is exactly
  // dx/dy 0) - only actually missing (null/undefined, the caller clearing
  // it on purpose) should leave the field out of what gets saved.
  if(p.layoutDx!=null) data.layoutDx = p.layoutDx;
  if(p.layoutDy!=null) data.layoutDy = p.layoutDy;
  if(p.layoutScale!=null) data.layoutScale = p.layoutScale;
  people.set(p.id, {id:p.id, ...data});
  try { await setDoc(doc(fs, "trees", tree.key, "people", p.id), data); return true; }
  catch(e){ toast("That change didn't save (" + (e.code||"error") + "). Try again."); return false; }
}
// A plain Promise.all over many people at once (reset, declutter) can
// have a handful quietly fail under real-world load - put() already
// toasts each one, but the op as a whole would otherwise just leave
// those few stuck as they were, looking like the button needs pressing
// again. Retries only the ones that actually failed, a few times with a
// short pause between, and returns whoever still hasn't saved after that.
async function putAll(list, fields){
  let remaining = list;
  for(let attempt=0; attempt<4 && remaining.length; attempt++){
    if(attempt>0) await new Promise(r=>setTimeout(r, 500));
    const results = await Promise.all(remaining.map(p => put({...p, ...fields})));
    remaining = remaining.filter((p,i) => !results[i]);
  }
  return remaining;
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
   One person is the root the whole grid is positioned relative to.
   Going UP from them is a full binary ancestor fan (both parents, each
   generation also showing that ancestor's own siblings). Going DOWN
   from them is every descendant, generation by generation - so every
   blood relative of the root (ancestors, descendants, siblings,
   cousins, aunts/uncles, nieces/nephews) is already on screen at once,
   and tapping one of them just selects them (see select()) rather than
   moving anything. A spouse married in at any level - an in-law, shown
   dim - is the one case that isn't already drawn past their own tie
   line, so tapping one of those re-roots the grid on them instead (see
   go()), bringing their own ancestry and descendants into view. */
function pickFocus(){
  if(rootId && P(rootId)) return;
  if(tree.defaultFocus && P(tree.defaultFocus)){ setRoot(tree.defaultFocus); return; }
  const all = [...people.values()].filter(p=>!p.placeholder).sort(byName);
  if(all.length) setRoot(all[0].id);
}
// Re-roots the grid on `id` and selects them - the only two things that
// ever move the frame (see go()).
function setRoot(id){
  if(!P(id)) return;
  rootId = id; focusId = id;
}
// Selects `id` for the dock/highlight/editing without touching the
// grid's root - safe for anyone already on screen as a blood relative.
function select(id){
  if(!P(id)) return;
  focusId = id; render();
}
function go(id, push=true){
  if(!P(id)) return;
  if(push && rootId && rootId!==id) trail.push(rootId);
  setRoot(id); view="tree"; render();
}

/* Generations are flat rows (a fixed height apart, never based on birth
   date - a spouse always sits at exactly the same height as their partner).
   Placement is computed as exact (x, generation) coordinates so the line
   from a clicked person up to their parents always points at that specific
   person, not just at the middle of whatever row they're sitting in - and
   every other relative (siblings, their spouses) gets their own line too,
   so the "whose parents are whose" is never ambiguous. */
const SLOT_W = 160, ROW_H = 180;
// Everyone renders at the same size regardless of generation or how
// crowded their branch is - nothing shrinks on its own any more. Sizing
// anyone differently is now purely a manual choice (Edit Layout's
// resize), never something the tree decides for you just because you
// clicked a different focus or a branch happens to be wide.
function genScale(gen){ return 1; }
const isDivorced = (a, b) => !!(a && b && ((a.divorced||[]).includes(b.id) || (b.divorced||[]).includes(a.id)));
// A divorced couple sitting right next to each other reads fine with the
// X drawn over their connecting line - that's only confusing when another
// partner sits between them, since the line to a non-adjacent partner
// runs straight behind that in-between node. So: X on the line when
// adjacent, X on the ex-partner's own node otherwise.
// Takes the actual step distance a true adjacent pair would sit at, not a
// flat assumption, so callers pass whatever step they actually placed with.
const adjacentX = (ax, bx, expectedStep) => Math.abs(Math.abs(ax-bx)-expectedStep)<0.01;
// A couple's left/right order is always by gender (male left, female
// right, unknown gender in between) rather than by who happens to be the
// blood relative being traced through at the moment.
const genderRank = p => !p ? 1 : p.gender==="m" ? 0 : p.gender==="f" ? 2 : 1;
const sortIdsByGender = ids => [...ids].sort((a,b)=>genderRank(P(a))-genderRank(P(b)));
const sortCoupleByGender = people => [...people].sort((a,b)=>genderRank(a)-genderRank(b));
// Two or more partners sorted purely by gender can easily push the actual
// blood pivot to one end of the row instead of between them, reading as
// if a spouse were the center of the family rather than the person
// who's actually related by blood. With more than one partner, the pivot
// always sits in the middle - current partner(s) toward one side, anyone
// divorced from the pivot toward the other - so a remarriage reads
// left-to-right as "ex - them - current" instead of an arbitrary
// gender-based shuffle. A single partner has no "middle" to protect, so
// that case is unchanged.
function unitOrder(pivotId, partnerIds){
  if(partnerIds.length < 2) return sortIdsByGender([pivotId, ...partnerIds]);
  const pivot = P(pivotId);
  const exes = partnerIds.filter(pid => isDivorced(pivot, P(pid)));
  const current = partnerIds.filter(pid => !isDivorced(pivot, P(pid)));
  return [...sortIdsByGender(current), pivotId, ...sortIdsByGender(exes)];
}
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
  // A sibling (never the pivot - their own kids are the direct bloodline,
  // placed separately) needs room for their OWN kids too now that cousins
  // always show, judged purely on that sibling's own subtree.
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
let lastPadX = null, lastPadY = null, pendingPadDelta = null;
// ownScale/nextScale no longer differ in practice (nothing reduces either
// one any more - see genScale), but the parameters stay since every
// caller already threads them through; collapsing them away is a bigger,
// riskier change than this needs.
function descWidth(id, gen, ownScale, nextScale){
  ownScale = ownScale==null ? 1 : ownScale;
  nextScale = nextScale==null ? ownScale : nextScale;
  const p = P(id);
  const step = ownScale*genScale(gen);
  const rowWidth = step*(1 + partnersOf(p).length);
  const kids = visibleChildren(id);
  if(!kids.length) return Math.max(rowWidth, step);
  const downWidth = kids.reduce((sum,k)=>sum+descWidth(k.id, gen+1, nextScale, nextScale),0);
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
      edges.push({tie:true, a:parentPos[0], b:parentPos[1], aId:expand[0].id, bId:expand[1].id, divorced: divorced && adj, scale:genScale(gen-1)});
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
    const unitIds = unitOrder(person.id, [...partners.map(s=>s.id), ...(extra?[extra.id]:[])]);
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
    const connected = parentPos
      .map((pp,i)=>({pp, parId:expand[i].id}))
      .filter(({parId})=> myParents.includes(parId))
      .map(({pp,parId})=>({x:pp.x, gen:pp.gen, id:parId}));
    // A node with recorded parents that aren't being drawn here (simply
    // never expanded past this dead end) is easy to mistake for "nothing
    // more was ever entered" - a short grayed stub reaching up into the
    // empty gap above says otherwise.
    if(!person.placeholder && myParents.length && !connected.length) edges.push({stub:true, x, gen, id:person.id, scale:genScale(gen)});
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
      // Always a real id, even here - a couple's manual offset is one
      // shared value now (see groupAnchorId), so reading it through
      // person.id or their partner's gives the identical answer. Using
      // null used to mean "nobody's drag ever moves this line," which
      // is exactly the bug: the couple relocates, the line doesn't.
      const childId = person.id;
      edges.push({childX, childGen:gen, childId, parents:connected, adjacent:false, uncertain});
    }

    const spouseXMap = new Map();
    partners.forEach(sp=>{
      const sx = posOf[sp.id];
      const divorced = isDivorced(person, sp), adj = adjacentX(x, sx, genScale(gen));
      placed.push({id:sp.id, x:sx, gen, dim:true, placeholder:!!sp.placeholder, deadEnd:true, divorced: divorced && !adj});
      edges.push({tie:true, a:{x, gen}, b:{x:sx, gen}, aId:person.id, bId:sp.id, divorced: divorced && adj, scale:genScale(gen)});
      spouseXMap.set(sp.id, sx);
      // a dim attached partner never expands further themselves, so their
      // own recorded parents (if any) would otherwise vanish with no trace.
      if(!sp.placeholder && (sp.parents||[]).length) edges.push({stub:true, x:sx, gen, id:sp.id, scale:genScale(gen)});
    });
    if(extra){
      const sx = posOf[extra.id];
      const divorced = isDivorced(person, extra), adj = adjacentX(x, sx, genScale(gen));
      placed.push({id:extra.id, x:sx, gen, dim:true, placeholder:!!extra.placeholder, deadEnd:true, divorced: divorced && !adj});
      edges.push({tie:true, a:{x, gen}, b:{x:sx, gen}, aId:person.id, bId:extra.id, divorced: divorced && adj, scale:genScale(gen)});
      if(!extra.placeholder && (extra.parents||[]).length) edges.push({stub:true, x:sx, gen, id:extra.id, scale:genScale(gen)});
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
  const step = ownScale*genScale(gen);
  const partners = partnersOf(p);
  // The pivot + their spouse(s) only need (1 + partners.length) slots, but
  // `width` can be wider than that to make room for grandchildren below -
  // center that couple unit within the full width rather than centering
  // the pivot alone, otherwise a spouse can land right on the boundary
  // with the next sibling's own space when there's no extra room needed.
  const unitWidth = step*(1 + partners.length);
  const unitLeft = xLeft + (width-unitWidth)/2;
  const unitIds = unitOrder(p.id, partners.map(s=>s.id));
  const posOf = {};
  unitIds.forEach((uid,i) => { posOf[uid] = unitLeft + step*i + step/2; });
  const x = posOf[p.id];
  placed.push({id:p.id, x, gen, placeholder:!!p.placeholder, scale:step});

  const spouseX = new Map();
  partners.forEach(sp=>{
    const sx = posOf[sp.id];
    const divorced = isDivorced(p, sp), adj = adjacentX(x, sx, step);
    placed.push({id:sp.id, x:sx, gen, dim:true, placeholder:!!sp.placeholder, deadEnd:true, divorced: divorced && !adj, scale:step});
    edges.push({tie:true, a:{x, gen}, b:{x:sx, gen}, aId:p.id, bId:sp.id, divorced: divorced && adj, scale:step});
    spouseX.set(sp.id, sx);
    // A spouse married in on the way down never gets their own ancestry
    // expanded (same as the ancestor-direction dim attachment) - without
    // this, their recorded parents just silently vanish with no trace.
    if(!sp.placeholder && (sp.parents||[]).length) edges.push({stub:true, x:sx, gen, id:sp.id, scale:step});
  });

  const kids = visibleChildren(id).sort(byBorn);
  if(kids.length){
    const widths = kids.map(k=>descWidth(k.id, gen+1, nextScale, nextScale));
    const totalW = widths.reduce((a,b)=>a+b,0);
    // center the children block on the full allocated width, not on the
    // pivot's own position - when the pivot has a spouse, their own x sits
    // left of that width's true center, which would shove a wide block of
    // grandchildren left too, overlapping whatever's allocated next door.
    let cx = (xLeft + width/2) - totalW/2;
    kids.forEach((k,i)=>{
      const kpos = placeDescendant(placed, edges, k.id, cx, widths[i], gen+1, nextScale, nextScale);
      const kp = P(k.id);
      const parentPts = [{x, gen, id:p.id}];
      (kp.parents||[]).forEach(pid=>{ if(spouseX.has(pid)) parentPts.push({x:spouseX.get(pid), gen, id:pid}); });
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
      // See the ancestor-direction note above - a real id always, so the
      // line actually follows wherever this couple's shared offset puts
      // them, uncertain or not.
      const childId = k.id;
      edges.push({childX, childGen:kpos.gen, childId, parents:parentPts, adjacent, uncertain});
      cx += widths[i];
    });
  }
  return {x, gen};
}
/* Connector lines are grouped by family unit (the exact set of parents a
   child belongs to), so a couple - or a single known parent - gets one
   shared trunk down to one bus line, with each child hanging off it by a
   short stub, rather than a separate line to every parent individually. */
function renderEdges(edges, px, py, pxAdj, pyAdj){
  let svg = "";
  const groups = new Map();
  edges.forEach(e=>{
    if(e.stub){
      // A short, muted line reaching up into the empty gap above a node -
      // signals "more is recorded here, just not drawn" (blocked by an
      // anchor, collapsed, or a dead end that never expands) without
      // claiming to show an actual connection to anyone specific. Sized
      // to the node it's attached to, same as the divorce X below, or it
      // reads as oversized against a manually shrunk node. Follows the
      // node's own manual drag offset (if any), same as everything else
      // here.
      const x1 = pxAdj(e.id, e.x), yTop = pyAdj(e.id, e.gen), sc = e.scale!=null ? e.scale : 1;
      svg += `<line x1="${x1.toFixed(1)}" y1="${(yTop-30*sc).toFixed(1)}" x2="${x1.toFixed(1)}" y2="${(yTop-58*sc).toFixed(1)}" class="stub-line"/>`;
      return;
    }
    if(e.tie){
      const x1=pxAdj(e.aId,e.a.x), y1=pyAdj(e.aId,e.a.gen), x2=pxAdj(e.bId,e.b.x), y2=pyAdj(e.bId,e.b.gen);
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
    groups.get(key).children.push({x:e.childX, gen:e.childGen, id:e.childId, uncertain:e.uncertain});
  });
  groups.forEach(g=>{
    // Row heights stay structural (based on the un-dragged, computed
    // positions) so the shared bus line never tilts just because one
    // relative got manually moved - but every actual line endpoint below
    // follows that specific person's own position, dragged or not, so a
    // moved box never looks disconnected from its own line.
    const baseParentY = py(g.parents[0].gen), baseChildY = py(g.children[0].gen);
    const busY = baseParentY + (baseChildY-baseParentY)*0.6;
    const parentPtsAdj = g.parents.map(p=>({x:pxAdj(p.id,p.x), y:pyAdj(p.id,p.gen)}));
    // A couple that's always placed right next to each other (an attached
    // spouse, or any case marked adjacent) reads better as one clean trunk
    // from their shared midpoint. Two parents who are each their own
    // independently-placed ancestor fork (adjacent:false) might not be
    // anywhere near each other, so the midpoint could land on an unrelated
    // person sitting between them - give those a stub per parent instead.
    const uniqueXs = [...new Set(parentPtsAdj.map(pt=>pt.x))];
    const trunkPts = (g.adjacent && uniqueXs.length>1)
      ? [{x: uniqueXs.reduce((a,b)=>a+b,0)/uniqueXs.length, y: parentPtsAdj.reduce((s,pt)=>s+pt.y,0)/parentPtsAdj.length}]
      : parentPtsAdj.filter((pt,i)=>uniqueXs.indexOf(pt.x)===i);
    const childPtsAdj = g.children.map(c=>({x:pxAdj(c.id,c.x), y:pyAdj(c.id,c.gen), uncertain:c.uncertain}));
    const allX = [...trunkPts.map(p=>p.x), ...childPtsAdj.map(p=>p.x)];
    const minX = Math.min(...allX), maxX = Math.max(...allX);
    trunkPts.forEach(pt => {
      svg += `<line x1="${pt.x.toFixed(1)}" y1="${pt.y.toFixed(1)}" x2="${pt.x.toFixed(1)}" y2="${busY.toFixed(1)}" class="fam-line"/>`;
    });
    if(maxX>minX) svg += `<line x1="${minX.toFixed(1)}" y1="${busY.toFixed(1)}" x2="${maxX.toFixed(1)}" y2="${busY.toFixed(1)}" class="fam-line"/>`;
    childPtsAdj.forEach(c=>{
      const cls = c.uncertain ? "fam-line uncertain" : "fam-line";
      svg += `<line x1="${c.x.toFixed(1)}" y1="${busY.toFixed(1)}" x2="${c.x.toFixed(1)}" y2="${c.y.toFixed(1)}" class="${cls}"/>`;
      // a dashed line alone reads as "incomplete data" rather than "unsure
      // whose child" - the "?" is what actually says that.
      if(c.uncertain) svg += `<text x="${c.x.toFixed(1)}" y="${((busY+c.y)/2+4).toFixed(1)}" class="uncertain-q" text-anchor="middle">?</text>`;
    });
  });
  return svg;
}

function bubbleHtml(n, x, y){
  const p = P(n.id); if(!p) return "";
  // Everyone renders full size by default, however far from the focal
  // point - a manual resize (set while in Edit Layout mode) is the only
  // thing that ever makes a box bigger or smaller than that.
  const autoScale = n.id===focusId ? 1 : (n.scale!=null ? n.scale : genScale(n.gen));
  const scale = p.layoutScale!=null ? p.layoutScale : autoScale;
  const scaleStyle = `--ns:${scale.toFixed(3)};`;
  const selected = editLayout && selectedIds.has(n.id);
  const selCls = selected ? " selected" : "";
  // Only a selected box gets a resize handle, and only in Edit Layout mode
  // - otherwise it'd just be a stray dot cluttering every normal view.
  const handle = selected ? `<span class="resizeHandle" data-resize="${esc(n.id)}"></span>` : "";
  if(p.placeholder) return `<button class="node ph${selCls}" style="left:${x}px;top:${y}px;${scaleStyle}" data-go="${esc(n.id)}" data-scale="${scale.toFixed(3)}">Unknown${handle}</button>`;
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
  // Collapsing hides a crowded branch behind the one box at its top,
  // movable as a single unit in Edit Layout - their kids are never
  // placed at all while collapsed (see visibleChildren), not just
  // visually hidden, so nothing below has to be squeezed in anywhere.
  // Shown on a dim in-law too (toggling still collapses the couple
  // together, see toggleCollapse) even though their own line isn't
  // expanded here regardless - any recorded kids of theirs are still
  // real, just not the ones currently drawn from this particular pivot.
  const kidCount = childrenOf(p.id).length;
  const collapseBadge = (kidCount>0)
    ? ` <span class="collapseBadge" data-collapse="${esc(p.id)}" title="${p.collapsed ? `Show ${kidCount===1?"their child":kidCount+" children"} again` : `Hide ${kidCount===1?"their child":kidCount+" children"} for now`}">${p.collapsed ? "+"+kidCount : "−"}</span>`
    : "";
  // A partnered person's unplaced kids get a badge on their shared
  // couple frame instead (see framesHtml) - this is only for someone
  // with no recorded partner at all, who'd otherwise have no way to
  // even discover those kids exist, let alone open the panel that
  // places them, since there's no frame to click for them.
  const soloUnplacedBadge = (!n.dim && !partnerGroupOf(p.id).length && unplacedChildrenOf([p.id]).length>0)
    ? ` <span class="unplacedBadge" data-couple="${esc(p.id)}" title="Has children not yet placed"></span>`
    : "";
  return `<button class="node${n.dim?" dim":""}${n.id===focusId?" me":""}${more?" more":""}${p.collapsed?" collapsed":""}${genderCls}${selCls}" style="left:${x}px;top:${y}px;${scaleStyle}" data-go="${esc(n.id)}" data-scale="${scale.toFixed(3)}">
    <span class="nm">${esc(displayName(p)||"Unnamed")}${n.divorced?` <span class="divorcedBadge" title="Divorced">✕</span>`:""}${uncertainBadge}${collapseBadge}${soloUnplacedBadge}</span>
    ${p.maidenName?`<span class="maiden">(${esc(p.maidenName)})</span>`:""}
    <span class="yrs${birthKnown(p)?"":" unk"}">${esc(birthLabel(p))}</span>
    ${n.half?`<span class="chip">half</span>`:""}
    ${handle}
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
// the only ones that did).
function placeKidsBelow(placed, edges, parentId, parentX, parentGen, spouseXMap, baseScale){
  baseScale = baseScale==null ? 1 : baseScale;
  const kids = visibleChildren(parentId).sort(byBorn);
  if(!kids.length) return;
  const widths = kids.map(k=>descWidth(k.id, parentGen+1, baseScale, baseScale));
  const totalW = widths.reduce((a,b)=>a+b,0);
  const spouseXs = [...spouseXMap.values()];
  const coupleCenter = spouseXs.length ? [parentX, ...spouseXs].reduce((a,b)=>a+b,0)/(spouseXs.length+1) : parentX;
  let cx = coupleCenter - totalW/2;
  kids.forEach((k,i)=>{
    const kpos = placeDescendant(placed, edges, k.id, cx, widths[i], parentGen+1, baseScale, baseScale);
    const kp = P(k.id);
    const parentPts = [{x:parentX, gen:parentGen, id:parentId}];
    (kp.parents||[]).forEach(pid=>{ if(spouseXMap.has(pid)) parentPts.push({x:spouseXMap.get(pid), gen:parentGen, id:pid}); });
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
    // See the ancestor-direction note above - a real id always.
    const childId = k.id;
    edges.push({childX, childGen:kpos.gen, childId, parents:parentPts, adjacent, uncertain});
    cx += widths[i];
  });
}
function renderPedigree(){
  if(!people.size){
    return `<div class="empty"><h2>Start your tree</h2><p>Add yourself or the oldest relative you know. Then add their parents, partners and children from their card.</p><button class="primary" data-add="root">Add the first person</button></div>`;
  }
  pickFocus();
  // The grid roots on rootId - their entire recorded lineage both up and
  // down - which only moves when you tap an in-law (see go()). A blood
  // relative tap just moves the selection (focusId), already on screen.
  const root = P(rootId);
  if(!root) return `<p class="hint">Nobody to show.</p>`;

  const placed = [], edges = [];
  const focalPos = placeAncestor(placed, edges, root.id, null, 0, ancWidth(root.id, null, null, 0), 0);
  const focalSpouseX = new Map();
  partnersOf(root).forEach(sp=>{ const n = placed.find(x=>x.id===sp.id); if(n) focalSpouseX.set(sp.id, n.x); });

  placeKidsBelow(placed, edges, root.id, focalPos.x, 0, focalSpouseX);

  const xs = placed.map(n=>n.x), gens = placed.map(n=>n.gen);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minGen = Math.min(...gens), maxGen = Math.max(...gens);
  // A manual drag carries the whole blood-descendant line with it, same
  // as if every one of them had been selected and dragged together -
  // otherwise expanding a collapsed branch that's been moved elsewhere
  // puts its kids back at their old, un-moved spot, nowhere near the box
  // that supposedly represents them now. Each person's OWN layoutDx/Dy
  // (see offsetOf) is still just their own personal nudge on top of
  // that, for fine-tuning within the group it's now riding along with -
  // dragging never writes anything other than that personal nudge (see
  // onLayoutDragEnd), only rendering adds the parent's share back in.
  const placedIds = new Set(placed.map(n=>n.id));
  const cumCache = new Map();
  function cumOffsetOf(id){
    if(cumCache.has(id)) return cumCache.get(id);
    const own = offsetOf(id);
    cumCache.set(id, own); // placeholder breaks any accidental cycle
    const p = P(id);
    const parentId = p && (p.parents||[]).find(pid=>placedIds.has(pid));
    const result = parentId ? {dx: own.dx+cumOffsetOf(parentId).dx, dy: own.dy+cumOffsetOf(parentId).dy} : own;
    cumCache.set(id, result);
    return result;
  }
  // Generous padding on every side, not just enough to fit the content -
  // gives real room to grab the background and pan around (especially
  // above the topmost row, which used to sit flush against the edge with
  // nowhere to drag to) and keeps zooming out from feeling cramped. Manual
  // drags in Edit Layout mode need room that keeps growing, not a fixed
  // cap - so it's recomputed from committed layoutDx/layoutDy only (never
  // from the in-flight drag itself, which only ever touches the live
  // --dragx/--dragy transform on the node being moved): growing it off the
  // live drag would recenter the box out from under the very mouse moving
  // it, racing or lagging the drag. Growing from committed data only means
  // the resize happens once, on the render right after a drag ends, with
  // a buffer past the farthest current drag so there's room to keep going.
  const BASE_ROOM = 400, DRAG_BUFFER = 400;
  let maxOffX = 0, maxOffY = 0;
  placed.forEach(n=>{ const o = cumOffsetOf(n.id); maxOffX = Math.max(maxOffX, Math.abs(o.dx)); maxOffY = Math.max(maxOffY, Math.abs(o.dy)); });
  const PAD_X = 220 + Math.max(BASE_ROOM, maxOffX + DRAG_BUFFER);
  const PAD_Y = 220 + Math.max(BASE_ROOM, maxOffY + DRAG_BUFFER);
  pendingPadDelta = lastPadX!=null ? {dx: PAD_X-lastPadX, dy: PAD_Y-lastPadY} : null;
  lastPadX = PAD_X; lastPadY = PAD_Y;
  const px = x => (x-minX)*SLOT_W + PAD_X;
  // Rows are a flat ROW_H apart by default - nothing shrinks or grows on
  // its own any more - except when a manual resize (layoutScale) makes a
  // box in that row taller than that, which needs the row gap itself to
  // grow or the box would reach up into the row above regardless of how
  // much horizontal room it has. A box only ever gets bigger because the
  // person using Edit Layout chose that, so the row growing to fit is a
  // direct consequence of their own choice, not an automatic shrink.
  const rowMaxScale = new Map();
  placed.forEach(n=>{ const p=P(n.id); const s=(p&&p.layoutScale!=null)?p.layoutScale:1; rowMaxScale.set(n.gen, Math.max(rowMaxScale.get(n.gen)||1, s)); });
  const gensSorted = [...new Set(gens)].sort((a,b)=>a-b);
  const rowY = new Map();
  rowY.set(gensSorted[0], 0);
  for(let i=1;i<gensSorted.length;i++){
    const g0=gensSorted[i-1], g1=gensSorted[i];
    const s0 = rowMaxScale.get(g0)||1, s1 = rowMaxScale.get(g1)||1;
    rowY.set(g1, rowY.get(g0) + ROW_H*((s0+s1)/2)*(g1-g0));
  }
  const py = g => (rowY.get(g)||0) + PAD_Y;
  const pxRaw = (id, x) => px(x) + cumOffsetOf(id).dx;
  const pyAdj = (id, gen) => py(gen) + cumOffsetOf(id).dy;
  // Hard guarantee against two boxes ever rendering on top of each
  // other, regardless of any upstream width-reservation edge case or a
  // manual resize that makes one box wider than its own reserved slot -
  // after everyone's "natural" position is set, nudge rightward (never
  // together) anyone whose actual rendered box, manual scale included,
  // would still overlap their nearest left neighbor in the same row.
  // Only ever pushes things further apart, so it's a true no-op whenever
  // positions are already fine, which is the overwhelming majority of
  // the time.
  const MIN_GAP = 16;
  const halfWidthOf = id => { const p = P(id); return 54*((p && p.layoutScale!=null) ? p.layoutScale : 1); };
  const estHalfHeight = id => { const p = P(id); return 50*((p && p.layoutScale!=null) ? p.layoutScale : 1); };
  // Provably correct, not a heuristic: process every box left to right by
  // raw X, and for each one, look at every box already placed (to its
  // left) whose actual Y-range genuinely overlaps its own (real
  // half-heights, not a generation number or a guessed band) - push right
  // only as far as the worst of those demands. Since later boxes are only
  // ever compared against already-finalized earlier ones, nothing placed
  // this way can end up too close to anything already placed, by
  // induction - no threshold to tune, no pass count to guess at, and a
  // manual drag landing anywhere near another row is caught exactly the
  // same as a same-generation neighbor.
  // Couples (or a remarriage's trio) nudge as one rigid block, never
  // individually - otherwise a collision that only really concerns one
  // of them (some unrelated box elsewhere at the same height) shoves
  // that one person away while their own partner(s) stay put, which
  // reads exactly like someone dragged them apart by hand.
  const nodeNudgeX = new Map();
  const unitClaimed = new Set();
  const units = placed.map(n=>{
    if(unitClaimed.has(n.id)) return null;
    const mates = partnerGroupOf(n.id).filter(sp => placed.some(pn=>pn.id===sp.id && pn.gen===n.gen));
    const members = [n, ...mates.map(sp=>placed.find(pn=>pn.id===sp.id && pn.gen===n.gen))].filter(Boolean);
    members.forEach(m=>unitClaimed.add(m.id));
    return members;
  }).filter(Boolean);
  const sortedUnits = units.sort((a,b)=>
    Math.min(...a.map(m=>pxRaw(m.id,m.x))) - Math.min(...b.map(m=>pxRaw(m.id,m.x))));
  const placedSoFar = [];
  sortedUnits.forEach(unit=>{
    const spans = unit.map(m=>({
      id:m.id, half:halfWidthOf(m.id), halfH:estHalfHeight(m.id),
      y:pyAdj(m.id, m.gen), x:pxRaw(m.id, m.x)
    }));
    let shift = 0;
    spans.forEach(s=>{
      placedSoFar.forEach(o=>{
        if(Math.abs(s.y-o.y) < s.halfH+o.halfH){
          const needed = o.x + o.half + MIN_GAP + s.half - s.x;
          if(needed > shift) shift = needed;
        }
      });
    });
    spans.forEach(s=>{
      if(shift>0.01) nodeNudgeX.set(s.id, shift);
      placedSoFar.push({x:s.x+shift, half:s.half, y:s.y, halfH:s.halfH});
    });
  });
  const pxAdj = (id, x) => pxRaw(id, x) + (nodeNudgeX.get(id)||0);
  const width = (maxX-minX)*SLOT_W + PAD_X*2;
  const height = (rowY.get(maxGen)||0) + PAD_Y*2 + 170;

  const linesHtml = renderEdges(edges, px, py, pxAdj, pyAdj);
  const nodesHtml = placed.map(n => bubbleHtml(n, pxAdj(n.id,n.x), pyAdj(n.id,n.gen))).join("");
  // A clickable frame drawn once around each couple (or a remarriage's
  // three) actually on screen together - behind the individual boxes in
  // the DOM, so clicking one of them still hits that box first, and only
  // the surrounding gap/background inside the frame opens the couple's
  // own options (see openCoupleSheet). partnerGroupOf, filtered to
  // whoever's actually placed at this same generation, is the group;
  // whichever member is reached first in placed claims it, so it's
  // rendered exactly once, not once per person in it.
  const frameClaimed = new Set();
  const framesHtml = placed.map(n=>{
    if(frameClaimed.has(n.id) || n.dim) return "";
    const partners = partnerGroupOf(n.id).filter(sp => placed.some(pn=>pn.id===sp.id && pn.gen===n.gen));
    if(!partners.length) return "";
    const members = [n, ...partners.map(sp=>placed.find(pn=>pn.id===sp.id && pn.gen===n.gen))];
    members.forEach(m=>frameClaimed.add(m.id));
    const FRAME_PAD = 14;
    const edges2 = members.map(m=>{ const cx = pxAdj(m.id,m.x); const half = halfWidthOf(m.id); return [cx-half, cx+half]; });
    const left = Math.min(...edges2.map(e=>e[0])) - FRAME_PAD, right = Math.max(...edges2.map(e=>e[1])) + FRAME_PAD;
    // Same as the X bound above - each member's own Y, not just n's,
    // since the group's shared offset still leaves room for a vertical
    // mismatch (each partner can carry their own separate ancestor
    // cascade - see cumOffsetOf) that would otherwise clip a box right
    // out of its own frame.
    const vEdges = members.map(m=>{ const cy = pyAdj(m.id,m.gen); const half = estHalfHeight(m.id); return [cy-half, cy+half]; });
    const top = Math.min(...vEdges.map(e=>e[0])) - FRAME_PAD, bottom = Math.max(...vEdges.map(e=>e[1])) + FRAME_PAD;
    const frameHeight = bottom - top;
    // The one and only place "unplaced" shows up on the board itself -
    // a flag on the couple, not a look on the child's own box (which
    // otherwise reads as "placed" the moment auto layout spaces it out
    // reasonably, whether or not anyone actually dragged it there).
    const hasUnplacedKids = unplacedChildrenOf(members.map(m=>m.id)).length>0;
    const badge = hasUnplacedKids ? `<span class="unplacedBadge" title="Has children not yet placed"></span>` : "";
    return `<div class="coupleFrame" data-couple="${esc(members.map(m=>m.id).join(","))}" style="left:${left}px;top:${top}px;width:${(right-left)}px;height:${frameHeight}px">${badge}</div>`;
  }).join("");

  const selected = P(focusId);
  return `<div class="pedigree" style="width:${width}px;height:${height}px">
    <svg class="lines" width="${width}" height="${height}">${linesHtml}</svg>
    ${framesHtml}
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
    } else if(pendingPadDelta){
      // Same focus as last render, but the canvas grew (someone's drag
      // pushed PAD_X/PAD_Y out) - every coordinate shifted by that same
      // amount, so without this the whole tree would appear to jump even
      // though nothing the viewer cares about actually moved.
      app.scrollLeft += pendingPadDelta.dx*zoom;
      app.scrollTop += pendingPadDelta.dy*zoom;
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

function toggleCollapse(id){
  const p = P(id); if(!p) return;
  // Collapsing/expanding can change PAD_X/Y (a whole branch's width
  // reappearing or vanishing) and the render()-level pendingPadDelta
  // compensation doesn't always land pixel-perfect on its own - so
  // measure the actual toggled box's own screen position before and
  // after, and correct the scroll by whatever's left over, same idea as
  // zoomTo's anchor-preservation. Anchoring on the box you just tapped
  // (not the current selection) keeps your actual point of reference on
  // screen even if it isn't the selected person.
  const before = $(`.node[data-go="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  // A couple collapses and expands together, same as moving one takes
  // the rest with it (see startLayoutDrag, partnerGroupOf) - whichever
  // of them actually ends up as the blood pivot in some other view,
  // their own collapsed flag already matches instead of the group
  // quietly falling out of sync. Not awaited - put()'s own local update
  // lands synchronously before this call returns (it only awaits the
  // network write after that), so rendering right away gives instant
  // feedback instead of waiting on a round trip for what's otherwise a
  // purely visual toggle.
  const next = !p.collapsed;
  [p, ...partnerGroupOf(id)].forEach(person => put({...person, collapsed: next}));
  render();
  const afterEl = $(`.node[data-go="${CSS.escape(id)}"]`);
  if(before && afterEl){
    const after = afterEl.getBoundingClientRect();
    app.scrollLeft += after.left-before.left;
    app.scrollTop += after.top-before.top;
  }
}

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
    render();
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
    render();
  }
});

let coupleIds = [];
function openCoupleSheet(ids){
  const members = ids.map(P).filter(Boolean); if(!members.length) return;
  coupleIds = members.map(m=>m.id);
  const el = $(`.node[data-go="${CSS.escape(coupleIds[0])}"]`);
  $("#coupleSize").value = el ? (parseFloat(el.dataset.scale)||1).toFixed(2) : "1.00";
  const uncertain = members.find(m=>m.parentsUncertain);
  $("#coupleResolveBtn").hidden = !uncertain;
  $("#coupleResolveBtn").dataset.for = uncertain ? uncertain.id : "";

  // "Divorced" here just reflects the existing per-pair field, same one
  // the tie-line's X on the board already reads - this is only a second,
  // plainer-language place to see it, not a new source of truth.
  const divorcedPair = members.length>1 && isDivorced(members[0], members[1]) ? [members[0], members[1]]
    : members.length>2 && isDivorced(members[0], members[2]) ? [members[0], members[2]] : null;
  const infoLines = [];
  if(divorcedPair) infoLines.push(`${displayName(divorcedPair[0])||"They"} and ${displayName(divorcedPair[1])||"their partner"} are marked divorced.`);
  if(uncertain) infoLines.push(`Not sure yet whose parents these are - ${displayName(uncertain)||"one of them"}'s or their partner's.`);
  $("#coupleInfo").innerHTML = infoLines.length ? infoLines.map(esc).join("<br>") : "";

  const kids = unplacedChildrenOf(members.map(m=>m.id));
  $("#coupleKidsWrap").hidden = !kids.length;
  $("#coupleKidsList").innerHTML = kids.map(k =>
    `<button type="button" class="ghost" data-placechild="${esc(k.id)}">${esc(displayName(k)||"Unnamed")}</button>`
  ).join("");

  $("#coupleOptions").hidden = false;
}
async function placeChild(id){
  const p = P(id); if(!p) return;
  // Their spot right now already IS right below the parents - the grid
  // puts every child there by default - so "place" just locks that
  // default in as a real, manual position (0,0: no added offset) instead
  // of making the person drag a box that was never actually moving.
  // Still an ordinary placed box afterward, draggable like any other.
  const ok = await put({...p, layoutDx:0, layoutDy:0});
  if(!ok) return; // put() already toasted why it didn't save
  // A parent left collapsed (very likely right after a declutter, or
  // just never re-opened) hides ALL their kids outright, regardless of
  // placed status - visibleChildren checks that first and stops right
  // there. The couple panel's own "not yet placed" list never touches
  // that flag, so placing a kid here needs to clear it on whichever
  // parent(s) still have it set, or the write succeeds but the board
  // keeps looking exactly as if nothing happened.
  const collapsedParents = (p.parents||[]).map(P).filter(parent => parent && parent.collapsed);
  const toUncollapse = uniq(collapsedParents.flatMap(parent => [parent.id, ...partnerGroupOf(parent.id).map(sp=>sp.id)]));
  await Promise.all(toUncollapse.map(pid => { const person = P(pid); return person ? put({...person, collapsed:false}) : null; }));
  render();
  // Scrolled into view, not just toasted about - on a big tree a brand
  // new box can easily land somewhere off the current scroll position,
  // and "it said it worked" isn't the same as actually seeing it appear.
  const node = $(`.node[data-go="${CSS.escape(id)}"]`);
  if(node) node.scrollIntoView({block:"center", inline:"center"});
  toast(`${displayName(p)||"They"} are placed below their parents - drag anytime to move them.`);
}
$("#coupleResolveBtn").addEventListener("click", () => {
  const id = $("#coupleResolveBtn").dataset.for; if(!id) return;
  $("#coupleOptions").hidden = true;
  openResolveSheet(id);
});
$("#coupleSize").addEventListener("change", async () => {
  const scale = clampScale(parseFloat($("#coupleSize").value)||1);
  $("#coupleSize").value = scale.toFixed(2);
  for(const id of coupleIds){
    const p = P(id); if(!p) continue;
    await put({...p, layoutScale: scale});
  }
  render();
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
        setRoot(person.id);
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
  if(next) setRoot(next.id); else { rootId = null; focusId = null; }
  render(); toast("Removed.");
});

/* ================= tree options menu ================= */
$("#menuBtn").addEventListener("click", () => {
  $("#inviteLink").value = location.origin + location.pathname + "#t=" + tree.key;
  $("#inviteName").textContent = `Or they can tap "Join a tree" and type the name "${tree.name}" with the password.`;
  $("#forgetBtn").textContent = "Remove this tree from this device";
  $("#forgetBtn").dataset.armed = "";
  $("#resetLayoutBtn").textContent = "Reset everyone's manual position and size";
  $("#resetLayoutBtn").dataset.armed = "";
  $("#declutterBtn").textContent = "Start this family over: hide everyone but the oldest generation";
  $("#declutterBtn").dataset.armed = "";
  const f = P(rootId);
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
  const f = P(rootId); if(!f) return;
  const ok = await setDefaultFocus(f.id);
  if(ok){ render(); toast(`${displayName(f)||"This person"} is now everyone's starting point.`); }
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
// A manual drag now carries its whole branch along (see cumOffsetOf in
// renderPedigree), so anyone whose own positions were set before that -
// every one of their ancestors' own separate nudges now stacking on top
// of theirs too - can end up scattered far from where they actually
// meant to put them. This clears every manual position and resize back
// to the plain auto-layout, all at once, to start over from a clean
// slate rather than untangling that by hand person by person. Collapsed
// branches are left exactly as they are - this is about position and
// size only, same as the button says.
$("#resetLayoutBtn").addEventListener("click", async e => {
  const b = e.currentTarget;
  if(!b.dataset.armed){ b.dataset.armed = "1"; b.textContent = "Tap again to reset everyone to their default spot and size."; return; }
  $("#menu").hidden = true;
  const toReset = [...people.values()].filter(p => p.layoutDx!=null || p.layoutDy!=null || p.layoutScale!=null);
  toast("Resetting everyone's position…");
  const failed = await putAll(toReset, {layoutDx:null, layoutDy:null, layoutScale:null});
  render();
  const done = toReset.length - failed.length;
  toast(failed.length
    ? `${done} of ${toReset.length} reset - ${failed.length} didn't save, tap Reset again for those.`
    : `${toReset.length} ${toReset.length===1?"person is":"people are"} back to their default position and size.`);
});
// Scoped to rootId's own blood family (see bloodFamilyOf) - never an
// in-law's, even though their boxes sit right there on the same board,
// since they're a different family's own tree once you re-root on them.
// Collapsing EVERYONE in that family, oldest generation included, is
// what actually leaves just the top row on screen - a person's own
// collapsed flag only ever hides their OWN kids, never themselves (what
// hides a box is its parent's flag), so whoever has no recorded parents
// stays visible no matter what their own flag says, same as always. The
// one catch: the CURRENT root's own parents are always drawn in full
// going up, collapsed or not (placeAncestor never gates on it - only a
// descendant's placeKidsBelow/placeDescendant does), so collapsing
// everyone wouldn't actually hide anything below the root unless the
// root itself is also the oldest generation. Re-rooting onto whoever's
// directly above the current root (not just anyone pulled into the
// family through a shared descendant) after collapsing is what actually
// puts that mechanism to work. Tapping one of them back open reveals
// only their own kids (still collapsed themselves, from this same
// pass), so the rest comes back one generation at a time instead of all
// at once, each one placed by hand as it appears. Position/size resets
// too, same as resetLayoutBtn, so what reappears doesn't carry forward
// whatever mess it had before.
$("#declutterBtn").addEventListener("click", async e => {
  const b = e.currentTarget;
  if(!b.dataset.armed){ b.dataset.armed = "1"; b.textContent = "Tap again to hide everyone in this family except the oldest generation."; return; }
  $("#menu").hidden = true;
  const familyIds = bloodFamilyOf(rootId);
  // An in-law married into this family isn't blood, so bloodFamilyOf
  // correctly leaves their own parents/siblings/other-family untouched -
  // but their OWN position, specifically as attached to this family, was
  // never being cleared either, since they're not in familyIds at all.
  // That left every blood member's spouse permanently stuck whenever they
  // happened to have an old manual position from before this workflow
  // existed, with no obvious way to tell why they wouldn't budge.
  const inLawIds = uniq(familyIds.flatMap(id => partnerGroupOf(id).map(sp=>sp.id))).filter(id => !familyIds.includes(id));
  const topCount = familyIds.filter(id => { const p=P(id); return !p || !(p.parents||[]).length; }).length;
  // Walking up through parents[0] alone was the actual bug behind
  // "some people are stuck on the board no matter how many resets" -
  // placeAncestor draws a root's FULL recorded parents unconditionally,
  // never gated by collapsed/placed (that's only ever a thing for
  // descendants), so landing "oldest" on someone who still has a valid,
  // simply-never-walked parents[1] (the ordinary case of one side of a
  // couple having a deeper recorded line than the other) left that
  // entire other side permanently showing, immune to every reset - not
  // because anything was wrong with their data, but because the walk
  // itself stopped one step too early. Only a person with NO valid
  // parent in EITHER slot actually has nothing left for placeAncestor
  // to draw above them.
  let oldest = rootId;
  while(true){
    const validParents = (P(oldest)?.parents||[]).filter(pid=>P(pid));
    if(!validParents.length) break;
    oldest = validParents[0];
  }
  toast("Tidying up this family…");
  const toClear = [...familyIds, ...inLawIds].map(P).filter(Boolean);
  const failed = await putAll(toClear, {collapsed:true, layoutDx:null, layoutDy:null, layoutScale:null});
  go(oldest);
  // Re-rooting here only changes this session's in-memory view - without
  // this, reloading the page snaps straight back to whatever starting
  // point was saved before (often someone deep in the tree), making its
  // own full, un-gated ancestor fan reappear every single time no matter
  // how thoroughly this just tidied things up.
  await setDefaultFocus(oldest);
  toast(failed.length
    ? `Down to ${topCount} at the top - ${failed.length} didn't fully tidy, tap this again if they still show.`
    : `Down to ${topCount} at the top - tap one to bring their kids back.`);
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

/* ================= Edit Layout: drag empty space to box-select many =====
   Viewport (client) coordinates throughout, for both the drawn box and the
   hit test against each node's own getBoundingClientRect() - sidesteps any
   zoom/scroll math since both sides of the comparison are in the same
   space already. */
let marqueeState = null;
function startMarquee(e){
  marqueeState = {x0:e.clientX, y0:e.clientY, el:null, additive: e.shiftKey||e.ctrlKey||e.metaKey};
  document.addEventListener("mousemove", onMarqueeMove);
  document.addEventListener("mouseup", onMarqueeEnd);
}
function onMarqueeMove(e){
  if(!marqueeState) return;
  const dx = e.clientX-marqueeState.x0, dy = e.clientY-marqueeState.y0;
  if(!marqueeState.el){
    if(Math.abs(dx)<4 && Math.abs(dy)<4) return;
    marqueeState.el = document.createElement("div");
    marqueeState.el.className = "marquee";
    document.body.appendChild(marqueeState.el);
  }
  Object.assign(marqueeState.el.style, {
    left: Math.min(e.clientX, marqueeState.x0)+"px", top: Math.min(e.clientY, marqueeState.y0)+"px",
    width: Math.abs(dx)+"px", height: Math.abs(dy)+"px"
  });
}
function onMarqueeEnd(){
  document.removeEventListener("mousemove", onMarqueeMove);
  document.removeEventListener("mouseup", onMarqueeEnd);
  const ms = marqueeState; marqueeState = null;
  if(!ms || !ms.el) return; // a plain click, with nothing dragged - background click-to-clear runs instead
  dragged = true;
  const rect = ms.el.getBoundingClientRect();
  ms.el.remove();
  if(!ms.additive) selectedIds.clear();
  document.querySelectorAll(".node").forEach(el=>{
    const r = el.getBoundingClientRect();
    if(r.left<rect.right && r.right>rect.left && r.top<rect.bottom && r.bottom>rect.top) selectedIds.add(el.dataset.go);
  });
  render();
}

/* ================= Edit Layout: drag to move, drag the dot to resize =====
   Only active while editLayout is on. Dragging a node moves it (and every
   other currently-selected node, by the same amount) - the move is applied
   live via a CSS transform on the actual DOM nodes (no re-render mid-drag,
   so it stays smooth), then persisted to Firestore once the drag ends.
   Connector lines re-snap onto the new position on that final render. */
let layoutDrag = null;
function startLayoutDrag(e, id, forceGroup=false){
  // Outside an explicit multi-select (which already says exactly who
  // should move), dragging someone always takes their whole connected
  // partner group with them (see partnerGroupOf) - a couple, or a
  // remarriage's three, is already drawn right next to each other, so
  // moving one without the rest would only ever pull them apart, never
  // somewhere that read as intentional. Grabbing the couple's own frame
  // (forceGroup) always means the whole group regardless of whatever a
  // stray earlier tap left selected - a single leftover selected id would
  // otherwise read as an explicit "just move this one" multi-select.
  const ids = (!forceGroup && selectedIds.has(id)) ? [...selectedIds] : [id, ...partnerGroupOf(id).map(sp=>sp.id)];
  const startOffsets = new Map(ids.map(i=>{ const o=offsetOf(i); return [i, {dx:o.dx, dy:o.dy}]; }));
  layoutDrag = {ids, startX:e.clientX, startY:e.clientY, startOffsets, moved:false};
  document.addEventListener("mousemove", onLayoutDragMove);
  document.addEventListener("mouseup", onLayoutDragEnd);
}
function onLayoutDragMove(e){
  if(!layoutDrag) return;
  const dx = (e.clientX-layoutDrag.startX)/zoom, dy = (e.clientY-layoutDrag.startY)/zoom;
  if(!layoutDrag.moved && (Math.abs(dx)>3 || Math.abs(dy)>3)) layoutDrag.moved = true;
  if(!layoutDrag.moved) return;
  layoutDrag.ids.forEach(id=>{
    const el = $(`.node[data-go="${id}"]`); if(!el) return;
    el.style.setProperty("--dragx", dx+"px");
    el.style.setProperty("--dragy", dy+"px");
  });
}
async function onLayoutDragEnd(e){
  document.removeEventListener("mousemove", onLayoutDragMove);
  document.removeEventListener("mouseup", onLayoutDragEnd);
  const ld = layoutDrag; layoutDrag = null;
  if(!ld) return;
  if(!ld.moved) return; // a plain click - the click handler's select/deselect runs instead
  dragged = true; // swallow the click that follows this mouseup, same as background panning does
  const dx = (e.clientX-ld.startX)/zoom, dy = (e.clientY-ld.startY)/zoom;
  for(const id of ld.ids){
    const p = P(id); if(!p) continue;
    const base = ld.startOffsets.get(id);
    await put({...p, layoutDx: Math.round(base.dx+dx), layoutDy: Math.round(base.dy+dy)});
  }
  render();
}
let resizeDrag = null;
function startResize(e, id){
  e.preventDefault(); e.stopPropagation();
  const ids = selectedIds.has(id) ? [...selectedIds] : [id];
  const startScale = new Map(ids.map(i=>{
    const el = $(`.node[data-go="${i}"]`);
    return [i, el ? parseFloat(el.dataset.scale)||1 : 1];
  }));
  resizeDrag = {ids, startY:e.clientY, startScale};
  document.addEventListener("mousemove", onResizeMove);
  document.addEventListener("mouseup", onResizeEnd);
}
// Takes startY explicitly rather than reading it off the shared resizeDrag -
// onResizeEnd already has to null that out before its own await, so reading
// it back through here instead of its own captured copy would crash.
function resizeRatio(e, startY){
  const dy = (e.clientY-startY)/zoom;
  return Math.max(0.3, Math.min(2.5, 1 + dy/80));
}
// Absolute floor/ceiling on the result, not just on each drag's own ratio -
// repeated shrink drags each starting from the last saved (already small)
// scale would otherwise compound toward zero with no way back except
// zooming in past whatever the page zoom's own max happens to be.
const SCALE_MIN = 0.2, SCALE_MAX = 4;
function clampScale(s){ return Math.max(SCALE_MIN, Math.min(SCALE_MAX, s)); }
function onResizeMove(e){
  if(!resizeDrag) return;
  const ratio = resizeRatio(e, resizeDrag.startY);
  resizeDrag.ids.forEach(id=>{
    const el = $(`.node[data-go="${id}"]`); if(!el) return;
    el.style.setProperty("--ns", clampScale(resizeDrag.startScale.get(id)*ratio).toFixed(3));
  });
}
async function onResizeEnd(e){
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeEnd);
  const rd = resizeDrag; resizeDrag = null;
  if(!rd) return;
  dragged = true;
  const ratio = resizeRatio(e, rd.startY);
  for(const id of rd.ids){
    const p = P(id); if(!p) continue;
    await put({...p, layoutScale: +clampScale(rd.startScale.get(id)*ratio).toFixed(3)});
  }
  render();
}
$("#editLayoutBtn").addEventListener("click", () => {
  editLayout = !editLayout;
  selectedIds.clear();
  $("#editLayoutBtn").setAttribute("aria-pressed", String(editLayout));
  app.classList.toggle("editingLayout", editLayout);
  if(editLayout) toast("Tap boxes to select, or drag empty space to box-select many. Drag a box to move the selection, the dot to resize. Tap ✎ again when done.");
  render();
});

app.addEventListener("mousedown", e => {
  if(view!=="tree" || e.button!==0) return;
  const handle = e.target.closest("[data-resize]");
  if(editLayout && handle) return startResize(e, handle.dataset.resize);
  if(e.target.closest("[data-collapse]")) return; // let the click handler toggle it, not start a drag
  const nodeEl = e.target.closest(".node");
  if(editLayout && nodeEl){ e.preventDefault(); return startLayoutDrag(e, nodeEl.dataset.go); }
  const frameEl = e.target.closest("[data-couple]");
  // Grabbing the frame itself (not a person inside it) drags the whole
  // couple together, same as grabbing either person does - a plain click
  // with no movement still opens the options sheet, since startLayoutDrag
  // only flips `dragged` once the mouse actually moves.
  if(editLayout && frameEl){ e.preventDefault(); return startLayoutDrag(e, frameEl.dataset.couple.split(",")[0], true); }
  if(e.target.closest(".node") || e.target.closest(".dock")) return;
  if(editLayout) return startMarquee(e);
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
  const factor = e.deltaY<0 ? 1.08 : 1/1.08;
  zoomTo(+(zoom*factor).toFixed(4), e.clientX, e.clientY);
}, {passive:false});

/* ================= events ================= */
document.addEventListener("click", e => {
  if(dragged){ dragged = false; e.stopPropagation(); e.preventDefault(); return; }
  // Checked before the editLayout branch below (which otherwise treats
  // any tap inside a .node as a select/deselect) so collapsing still
  // works while arranging boxes by hand, not just in normal browsing.
  const cb = e.target.closest("[data-collapse]");
  if(cb) return toggleCollapse(cb.dataset.collapse);
  // Frames sit behind the individual node buttons in the DOM, so a click
  // only ever reaches one here when it landed on the frame's own margin,
  // not on a person inside it - no need to check editLayout first.
  const cf = e.target.closest("[data-couple]");
  if(cf) return openCoupleSheet(cf.dataset.couple.split(","));
  // The couple sheet's own close controls need the same early exemption -
  // otherwise closing it while editLayout is on falls into the "clear
  // selection" branch below instead, leaving the sheet stuck open.
  if(e.target.closest("[data-closecouple]")){ $("#coupleOptions").hidden = true; return; }
  const pc = e.target.closest("[data-placechild]");
  if(pc){ $("#coupleOptions").hidden = true; return placeChild(pc.dataset.placechild); }
  if(editLayout){
    if(e.target.closest("[data-resize]")) return;
    const node = e.target.closest(".node");
    if(node){
      const id = node.dataset.go;
      if(selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
      return render();
    }
    if(!e.target.closest(".dock") && !e.target.closest(".zoomCtl")){
      if(selectedIds.size){ selectedIds.clear(); render(); }
      return;
    }
  }
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
    // A blood relative of rootId is already drawn in the current grid
    // (any tree-view .node that isn't a dim in-law) - just select them
    // in place. Anything else - an in-law node, or a card tapped from
    // the flat Everyone list, which isn't part of the current grid at
    // all - needs the grid itself to move (go()).
    if(g.classList.contains("node") && !g.classList.contains("dim")) return select(id);
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
