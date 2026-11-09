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
let tree = null;            // {key, name}
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
  const name = snap.data().name || nameHint || "Family Tree";
  tree = {key, name}; saveTree(key, name);
  history.replaceState(null, "", location.pathname + "#t=" + key);
  $("#home").hidden = true; $("#treeScreen").hidden = false;
  $("#treeTitle").textContent = name; document.title = name;
  loaded = false; offlineNote = ""; view = "tree"; trail = []; focusId = keyGet("ft-focus-"+key);
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
  if(p.born && p.died) return `${p.born} – ${p.died}`;
  if(p.born) return `b. ${p.born}`;
  if(p.died) return `d. ${p.died}`;
  return "";
}
const surname = p => { const w=(p.name||"").trim().split(/\s+/); return w.length>1 ? w[w.length-1] : (w[0]||"Unnamed"); };

/* ================= saving ================= */
async function put(p){
  const data = {
    name: p.name||"", born: p.born||"", died: p.died||"", place: p.place||"", note: p.note||"",
    parents: (p.parents||[]).slice(0,2), spouses: (p.spouses||[]).slice(0,20), updated: Date.now()
  };
  people.set(p.id, {id:p.id, ...data});
  try { await setDoc(doc(fs, "trees", tree.key, "people", p.id), data); return true; }
  catch(e){ toast("That change didn't save (" + (e.code||"error") + "). Try again."); return false; }
}
async function drop(id){
  people.delete(id);
  try { await deleteDoc(doc(fs, "trees", tree.key, "people", id)); }
  catch(e){ toast("Couldn't remove (" + (e.code||"error") + ")."); }
}

/* ================= tree rendering ================= */
function go(id, push=true){
  if(!P(id)) return;
  if(push && focusId && focusId!==id) trail.push(focusId);
  focusId=id; keySet("ft-focus-"+tree.key, id); view="tree"; render(); window.scrollTo({top:0});
}
function pickFocus(){
  if(focusId && P(focusId)) return;
  const all=[...people.values()].sort(byName);
  focusId = all.length ? all[0].id : null;
}
function card(p, extra=""){
  const kids = childrenOf(p.id).length, y = years(p);
  return `<button class="card" data-go="${esc(p.id)}"><span class="nm">${esc(p.name||"Unnamed")}</span>${y?`<span class="yrs">${esc(y)}</span>`:""}${(extra||kids)?`<span class="meta">${extra}${kids?`<span class="chip">${kids} ${kids===1?"child":"children"}</span>`:""}</span>`:""}</button>`;
}
const addBtn = (rel, label) => `<button class="add" data-add="${rel}">+ ${label}</button>`;

function renderTree(){
  if(!people.size){
    return `<div class="empty"><h2>Start your tree</h2><p>Add yourself or the oldest relative you know. Then add their parents, partners and children from their card.</p><button class="primary" data-add="root">Add the first person</button></div>`;
  }
  pickFocus();
  const f = P(focusId);
  const par = parentsOf(f), prt = partnersOf(f), sibs = siblingsOf(f);
  const kids = childrenOf(f.id).sort((a,b)=>String(a.born||"").localeCompare(String(b.born||"")));
  const coParents = new Set(kids.flatMap(k=>k.parents.filter(x=>x!==f.id)));
  const showWith = coParents.size>1;
  let h = "";
  h += `<section class="gen"><h2>Parents</h2><div class="row">${par.map(p=>card(p)).join("")}${par.length<2?addBtn("parent","Add parent"):""}</div></section>`;
  h += `<div class="stem"></div>`;
  h += `<section class="focus" aria-label="Selected person"><span class="nm">${esc(f.name||"Unnamed")}</span>`;
  if(years(f)) h += `<span class="yrs">${esc(years(f))}</span>`;
  if(f.place) h += `<p class="place">${esc(f.place)}</p>`;
  if(f.note) h += `<p class="story">${esc(f.note)}</p>`;
  h += `<div class="tools"><button class="btn" data-edit="${esc(f.id)}">Edit details</button></div></section>`;
  h += `<section class="gen partners"><h2>${prt.length>1?"Partners":"Partner"}</h2><div class="row">${prt.map(p=>card(p)).join("")}${addBtn("partner","Add partner")}</div></section>`;
  h += `<div class="stem"></div>`;
  h += `<section class="gen"><h2>Children ${kids.length?`<span>· ${kids.length}</span>`:""}</h2><div class="row">${kids.map(k=>{
      const other = showWith ? k.parents.filter(x=>x!==f.id).map(P).filter(Boolean)[0] : null;
      return card(k, other?`<span class="chip">with ${esc((other.name||"").split(/\s+/)[0])}</span>`:"");
    }).join("")}${addBtn("child","Add child")}</div></section>`;
  h += `<section class="gen sib"><h2>Brothers &amp; sisters ${sibs.length?`<span>· ${sibs.length}</span>`:""}</h2>`;
  if(par.length) h += `<div class="row">${sibs.map(s=>card(s.p, s.half?`<span class="chip">half</span>`:"")).join("")}${addBtn("sibling","Add sibling")}</div>`;
  else h += `<p class="hint">Add a parent first, then siblings can hang off the same parents.</p>`;
  return h + `</section>`;
}

function renderAll(){
  const q = query.trim().toLowerCase();
  const list = [...people.values()].filter(p => !q || (p.name||"").toLowerCase().includes(q) || (p.place||"").toLowerCase().includes(q));
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

function render(){
  if(!tree) return;
  $("#tabTree").setAttribute("aria-pressed", view==="tree");
  $("#tabAll").setAttribute("aria-pressed", view==="all");
  $("#backBtn").hidden = !(view==="tree" && trail.length);
  if(!loaded){ app.innerHTML = `<p class="hint">${esc(offlineNote || "Opening the tree…")}</p>`; return; }
  const hadFocus = document.activeElement && document.activeElement.id==="q";
  app.innerHTML = (offlineNote?`<p class="note">${esc(offlineNote)}</p>`:"") + (view==="tree" ? renderTree() : renderAll());
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
    $("#sheetTitle").textContent = "Edit details";
    $("#f-name").value=p.name||""; $("#f-born").value=p.born||""; $("#f-died").value=p.died||""; $("#f-place").value=p.place||""; $("#f-note").value=p.note||"";
    $("#delZone").hidden = false;
  } else {
    const fname = f ? (f.name||"this person").split(/\s+/)[0] : "";
    $("#sheetTitle").textContent = relWords[mode.rel] + (f && mode.rel!=="root" ? ` for ${fname}` : "");
    if(mode.rel!=="root"){
      const blocked = new Set([f.id, ...(f.parents||[]), ...(f.spouses||[]), ...childrenOf(f.id).map(c=>c.id)]);
      const others = [...people.values()].filter(p=>!blocked.has(p.id)).sort(byName);
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
    name: $("#f-name").value.trim(), born: $("#f-born").value.trim(), died: $("#f-died").value.trim(),
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
      if(rel==="root"){ await put(person); focusId=person.id; keySet("ft-focus-"+tree.key, person.id); }
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
        if(!person.parents.length) person.parents = [...(f.parents||[])];
        else if(pickedId) toast(`${person.name} already has parents listed, so they weren't changed.`);
        await put(person);
      }
    }
    closeSheet(); render();
  } finally { $("#saveBtn").disabled = false; }
});

$("#delBtn").addEventListener("click", () => {
  const p = P(sheetMode.edit);
  $("#delText").textContent = `Remove ${p.name} from the tree for everyone? Their relatives stay.`;
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
  $("#menu").hidden = false;
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
  const g = e.target.closest("[data-go]"); if(g) return go(g.dataset.go);
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
