import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, onSnapshot }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const fb = initializeApp(firebaseConfig);
const fs = getFirestore(fb);

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
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
const birthKnown = p => p.born!=null && p.born!=="";
function birthLabel(p){ return formatDate(p.born,p.bornMonth,p.bornDay) || "Unknown date of Birth"; }
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(toast.t); toast.t=setTimeout(()=>t.hidden=true,3500); }

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
const app = $("#app");
const P = id => people.get(id);

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
  const b = formatDate(p.born,p.bornMonth,p.bornDay), d = formatDate(p.died,p.diedMonth,p.diedDay);
  if(b && d) return `${b} – ${d}`;
  if(b) return `b. ${b}`;
  if(d) return `d. ${d}`;
  return "";
}
const surname = p => { const w=(p.name||"").trim().split(/\s+/); return w.length>1 ? w[w.length-1] : (w[0]||"Unnamed"); };

/* ================= saving ================= */
const toYear = v => { const n = parseInt(v,10); return Number.isFinite(n) ? n : null; };
const toSmall = (v,max) => { const n = parseInt(v,10); return (Number.isFinite(n) && n>=1 && n<=max) ? n : null; };
async function put(p){
  const data = {
    name: p.name||"",
    born: toYear(p.born), bornMonth: toSmall(p.bornMonth,12), bornDay: toSmall(p.bornDay,31),
    died: toYear(p.died), diedMonth: toSmall(p.diedMonth,12), diedDay: toSmall(p.diedDay,31),
    place: p.place||"", note: p.note||"",
    parents: (p.parents||[]).slice(0,2), spouses: (p.spouses||[]).slice(0,20), updated: Date.now()
  };
  if(p.placeholder && !data.name) data.placeholder = true;
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
  if(tree.defaultFocus && P(tree.defaultFocus)){ focusId = tree.defaultFocus; return; }
  const all = [...people.values()].filter(p=>!p.placeholder).sort(byName);
  focusId = all.length ? all[0].id : null;
}
function go(id, push=true){
  if(!P(id)) return;
  if(push && focusId && focusId!==id) trail.push(focusId);
  focusId=id; view="tree"; render(); window.scrollTo({top:0});
}

/* Generations are flat rows (a fixed height apart, never based on birth
   date - a spouse always sits at exactly the same height as their partner).
   Placement is computed as exact (x, generation) coordinates so the line
   from a clicked person up to their parents always points at that specific
   person, not just at the middle of whatever row they're sitting in - and
   every other relative (siblings, their spouses) gets their own line too,
   so the "whose parents are whose" is never ambiguous. */
const SLOT_W = 124, ROW_H = 148;

function ancWidth(id, excludeSpouseId){
  const p = P(id);
  const sibs = siblingsOf(p).map(s=>s.p);
  const folks = [p, ...sibs];
  const rowWidth = folks.reduce((sum,f)=> sum + 1 + partnersOf(f).filter(s=>!(f.id===p.id && s.id===excludeSpouseId)).length, 0);
  const parents = parentsOf(p);
  const upWidth = parents.length ? parents.reduce((sum,par,i)=>sum+ancWidth(par.id, parents.length>1?parents[1-i].id:null),0) : 0;
  return Math.max(rowWidth, upWidth, 1);
}
function descWidth(id){
  const p = P(id);
  const rowWidth = 1 + partnersOf(p).length;
  const kids = childrenOf(id);
  const downWidth = kids.length ? kids.reduce((sum,k)=>sum+descWidth(k.id),0) : 0;
  return Math.max(rowWidth, downWidth, 1);
}

function placeAncestor(placed, edges, id, excludeSpouseId, xLeft, width, gen){
  const p = P(id);
  const parents = parentsOf(p);
  const parentPos = [];
  if(parents.length){
    const widths = parents.map((par,i)=>ancWidth(par.id, parents.length>1?parents[1-i].id:null));
    const totalW = widths.reduce((a,b)=>a+b,0);
    let px = xLeft + (width-totalW)/2;
    parents.forEach((par,i)=>{
      parentPos.push(placeAncestor(placed, edges, par.id, parents.length>1?parents[1-i].id:null, px, widths[i], gen-1));
      px += widths[i];
    });
  }
  const sibs = siblingsOf(p);
  const folks = [{person:p, half:false, isPivot:true}, ...sibs.map(s=>({person:s.p, half:s.half, isPivot:false}))]
    .sort((a,b)=>byBorn(a.person,b.person));
  const rowWidth = folks.reduce((sum,f)=> sum + 1 + partnersOf(f.person).filter(s=>!(f.isPivot && s.id===excludeSpouseId)).length, 0);
  let cursor = xLeft + (width-rowWidth)/2;

  let pivotPos = null;
  folks.forEach(f=>{
    const person = f.person;
    const x = cursor + 0.5; cursor += 1;
    placed.push({id:person.id, x, gen, half:f.half, placeholder:!!person.placeholder, deadEnd:!f.isPivot});
    if(f.isPivot) pivotPos = {x, gen};

    const myParents = person.parents||[];
    const connected = parentPos.filter((pp,i)=> myParents.includes(parents[i].id)).map(pp=>({x:pp.x, gen:pp.gen}));
    if(connected.length) edges.push({childX:x, childGen:gen, parents:connected});

    partnersOf(person).filter(s=>!(f.isPivot && s.id===excludeSpouseId)).forEach(sp=>{
      const sx = cursor+0.5; cursor++;
      placed.push({id:sp.id, x:sx, gen, dim:true, placeholder:!!sp.placeholder, deadEnd:true});
      edges.push({tie:true, a:{x, gen}, b:{x:sx, gen}});
    });
  });
  return pivotPos;
}
function placeDescendant(placed, edges, id, xLeft, width, gen){
  const p = P(id);
  const x = xLeft + width/2;
  placed.push({id:p.id, x, gen, placeholder:!!p.placeholder});

  let cursor = x+0.5;
  const spouseX = new Map();
  partnersOf(p).forEach(sp=>{
    const sx = cursor; cursor++;
    placed.push({id:sp.id, x:sx, gen, dim:true, placeholder:!!sp.placeholder, deadEnd:true});
    edges.push({tie:true, a:{x, gen}, b:{x:sx, gen}});
    spouseX.set(sp.id, sx);
  });

  const kids = childrenOf(id).sort(byBorn);
  if(kids.length){
    const widths = kids.map(k=>descWidth(k.id));
    const totalW = widths.reduce((a,b)=>a+b,0);
    let cx = x - totalW/2;
    kids.forEach((k,i)=>{
      const kpos = placeDescendant(placed, edges, k.id, cx, widths[i], gen+1);
      const kp = P(k.id);
      const parentPts = [{x, gen}];
      (kp.parents||[]).forEach(pid=>{ if(spouseX.has(pid)) parentPts.push({x:spouseX.get(pid), gen}); });
      edges.push({childX:kpos.x, childGen:kpos.gen, parents:parentPts});
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
    if(!groups.has(key)) groups.set(key, {parents:e.parents, children:[]});
    groups.get(key).children.push({x:e.childX, gen:e.childGen});
  });
  groups.forEach(g=>{
    const parentY = py(g.parents[0].gen);
    const uniqueXs = [...new Set(g.parents.map(p=>p.x))];
    const anchorX = px(uniqueXs.reduce((a,b)=>a+b,0)/uniqueXs.length);
    const childY = py(g.children[0].gen);
    const busY = parentY + (childY-parentY)*0.6;
    const childPx = g.children.map(c=>px(c.x));
    const minX = Math.min(anchorX, ...childPx), maxX = Math.max(anchorX, ...childPx);
    svg += `<line x1="${anchorX.toFixed(1)}" y1="${parentY.toFixed(1)}" x2="${anchorX.toFixed(1)}" y2="${busY.toFixed(1)}" class="fam-line"/>`;
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
  return `<button class="node${n.dim?" dim":""}${n.id===focusId?" me":""}${more?" more":""}" style="left:${x}px;top:${y}px" data-go="${esc(n.id)}">
    <span class="nm">${esc(p.name||"Unnamed")}</span>
    <span class="yrs${birthKnown(p)?"":" unk"}">${esc(birthLabel(p))}</span>
    ${n.half?`<span class="chip">half</span>`:""}
  </button>`;
}
function dockHtml(f){
  if(!f || f.placeholder) return "";
  return `<div class="dock">
    <div class="dockInfo"><strong>${esc(f.name||"Unnamed")}</strong>${years(f)?` <span class="yrs">${esc(years(f))}</span>`:""}${f.place?`<div class="place">${esc(f.place)}</div>`:""}</div>
    <div class="dockBtns">
      ${(f.parents||[]).length<2?`<button class="dbtn" data-add="parent">+ Parent</button>`:""}
      <button class="dbtn" data-add="partner">+ Partner</button>
      <button class="dbtn" data-add="child">+ Child</button>
      <button class="dbtn" data-add="sibling">+ Sibling</button>
      <button class="dbtn edit" data-edit="${esc(f.id)}">Edit</button>
    </div>
  </div>`;
}
function renderPedigree(){
  if(!people.size){
    return `<div class="empty"><h2>Start your tree</h2><p>Add yourself or the oldest relative you know. Then add their parents, partners and children from their card.</p><button class="primary" data-add="root">Add the first person</button></div>`;
  }
  pickFocus();
  const f = P(focusId);
  if(!f) return `<p class="hint">Nobody to show.</p>`;

  const placed = [], edges = [];
  const focalPos = placeAncestor(placed, edges, f.id, null, 0, ancWidth(f.id, null), 0);
  const focalSpouseX = new Map();
  partnersOf(f).forEach(sp=>{ const n = placed.find(x=>x.id===sp.id); if(n) focalSpouseX.set(sp.id, n.x); });

  const kids = childrenOf(f.id).sort(byBorn);
  if(kids.length){
    const widths = kids.map(k=>descWidth(k.id));
    const totalW = widths.reduce((a,b)=>a+b,0);
    let cx = focalPos.x - totalW/2;
    kids.forEach((k,i)=>{
      const kpos = placeDescendant(placed, edges, k.id, cx, widths[i], 1);
      const kp = P(k.id);
      const parentPts = [{x:focalPos.x, gen:0}];
      (kp.parents||[]).forEach(pid=>{ if(focalSpouseX.has(pid)) parentPts.push({x:focalSpouseX.get(pid), gen:0}); });
      edges.push({childX:kpos.x, childGen:kpos.gen, parents:parentPts});
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

  return `<div class="pedigree" style="width:${width}px;height:${height}px">
    <svg class="lines" width="${width}" height="${height}">${linesHtml}</svg>
    ${nodesHtml}
  </div>${dockHtml(f)}`;
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
  return `<button class="card" data-go="${esc(p.id)}"><span class="nm">${esc(p.name||"Unnamed")}</span>${y?`<span class="yrs">${esc(y)}</span>`:""}${kids?`<span class="meta"><span class="chip">${kids} ${kids===1?"child":"children"}</span></span>`:""}</button>`;
}

function render(){
  if(!tree) return;
  $("#tabTree").setAttribute("aria-pressed", view==="tree");
  $("#tabAll").setAttribute("aria-pressed", view==="all");
  $("#backBtn").hidden = !(view==="tree" && trail.length);
  if(!loaded){ app.innerHTML = `<p class="hint">${esc(offlineNote || "Opening the tree…")}</p>`; return; }
  const hadFocus = document.activeElement && document.activeElement.id==="q";
  app.innerHTML = (offlineNote?`<p class="note">${esc(offlineNote)}</p>`:"") + (view==="tree" ? renderPedigree() : renderAll());
  if(hadFocus){ const q=$("#q"); q.focus(); q.setSelectionRange(q.value.length,q.value.length); }
}

/* ================= add / edit sheet ================= */
const relWords = {root:"Add the first person", parent:"Add a parent", partner:"Add a partner", child:"Add a child", sibling:"Add a brother or sister"};
function openSheet(mode){
  sheetMode = mode;
  const f = P(focusId), form = $("#sheetForm");
  form.reset(); form.classList.remove("picking");
  $("#delZone").hidden = true; $("#delConfirm").hidden = true; $("#delBtn").hidden = false;
  $("#otherWrap").hidden = true; $("#linkWrap").hidden = true; $("#pickWrap").hidden = true;
  if(mode.edit){
    const p = P(mode.edit);
    $("#sheetTitle").textContent = p.placeholder ? "Who was this?" : "Edit details";
    $("#f-name").value=p.name||"";
    $("#f-born-y").value=p.born??""; $("#f-born-m").value=p.bornMonth??""; $("#f-born-d").value=p.bornDay??"";
    $("#f-died-y").value=p.died??""; $("#f-died-m").value=p.diedMonth??""; $("#f-died-d").value=p.diedDay??"";
    $("#f-place").value=p.place||""; $("#f-note").value=p.note||"";
    $("#delZone").hidden = false;
  } else {
    const fname = f ? (f.name||"this person").split(/\s+/)[0] : "";
    $("#sheetTitle").textContent = relWords[mode.rel] + (f && mode.rel!=="root" ? ` for ${fname}` : "");
    if(mode.rel!=="root"){
      const blocked = new Set([f.id, ...(f.parents||[]), ...(f.spouses||[]), ...childrenOf(f.id).map(c=>c.id)]);
      const others = [...people.values()].filter(p=>!p.placeholder && !blocked.has(p.id)).sort(byName);
      if(others.length){
        $("#pickWrap").hidden = false;
        $("#f-existing").innerHTML = `<option value="">Someone new</option>` + others.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}${years(p)?" ("+esc(years(p))+")":""}</option>`).join("");
      }
    }
    if(mode.rel==="child"){
      $("#otherWrap").hidden = false;
      $("#f-other").innerHTML = partnersOf(f).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("") + `<option value="">Not listed / unknown</option>`;
    }
    if(mode.rel==="parent"){
      const existing = parentsOf(f)[0];
      if(existing && !(existing.spouses||[]).length){
        $("#linkWrap").hidden = false;
        $("#linkText").textContent = `Partner of ${existing.name}`;
      }
    }
  }
  $("#sheet").hidden = false;
  setTimeout(()=>$("#f-name").focus(), 50);
}
function closeSheet(){ $("#sheet").hidden = true; sheetMode = null; }

$("#f-existing").addEventListener("change", e => $("#sheetForm").classList.toggle("picking", !!e.target.value));

$("#sheetForm").addEventListener("submit", async e => {
  e.preventDefault();
  if(!sheetMode) return;
  const pickedId = !$("#pickWrap").hidden ? $("#f-existing").value : "";
  const fields = {
    name: $("#f-name").value.trim(),
    born: $("#f-born-y").value.trim(), bornMonth: $("#f-born-m").value, bornDay: $("#f-born-d").value.trim(),
    died: $("#f-died-y").value.trim(), diedMonth: $("#f-died-m").value, diedDay: $("#f-died-d").value.trim(),
    place: $("#f-place").value.trim(), note: $("#f-note").value.trim()
  };
  if(!pickedId && !fields.name){ toast("Add a name first."); $("#f-name").focus(); return; }
  $("#saveBtn").disabled = true;
  try {
    if(sheetMode.edit){
      const p = P(sheetMode.edit);
      await put({...p, ...fields});
    } else {
      const rel = sheetMode.rel, f = P(focusId);
      const person = pickedId ? {...P(pickedId)} : {id:newId(), ...fields, parents:[], spouses:[]};
      person.parents=[...(person.parents||[])]; person.spouses=[...(person.spouses||[])];
      if(rel==="root"){
        await put(person); focusId=person.id;
        await setDefaultFocus(person.id);
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
        } else if(pickedId) toast(`${person.name} already has parents listed, so they weren't changed.`);
        await put(person);
      }
    }
    closeSheet(); render();
  } finally { $("#saveBtn").disabled = false; }
});

$("#delBtn").addEventListener("click", () => {
  const p = P(sheetMode.edit);
  $("#delText").textContent = `Remove ${p.name||"this person"} from the tree for everyone? Their relatives stay.`;
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
  focusId = next ? next.id : null;
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
  $("#setDefaultBtn").textContent = f ? `Set ${f.name||"this person"} as everyone's starting point` : "Set as everyone's starting point";
  $("#menu").hidden = false;
});
$("#setDefaultBtn").addEventListener("click", async () => {
  const f = P(focusId); if(!f) return;
  const ok = await setDefaultFocus(f.id);
  if(ok) toast(`${f.name||"This person"} is now everyone's starting point.`);
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

/* ================= events ================= */
document.addEventListener("click", e => {
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
