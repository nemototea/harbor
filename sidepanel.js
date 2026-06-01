/* ============================================================
   Harbor — side panel logic
   Storage model (chrome.storage.local, single key):
     {
       version: 1,
       activeSpaceId: string,
       spaces:  [{ id, name, color }],
       anchors: [{ id, spaceId, title, url, order }]
     }
   ============================================================ */

const KEY = "harbor:v1";
const FAVICON_SIZE = 32;
const SWATCHES = ["#f5b740", "#4dd6c8", "#9b8cff", "#f0604d", "#6ea8fe", "#7bd88f", "#e879c7"];

let state = null;
let editing = false;
let modalCtx = null;   // { mode: 'add'|'edit', anchorId? }
let spaceCtx = null;   // { mode: 'add'|'edit', spaceId?, color }
let dragId = null;

/* ---------- utils ---------- */
const $ = (sel) => document.querySelector(sel);
function uid() {
  return "h" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}
function faviconUrl(pageUrl) {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", pageUrl || "");
  u.searchParams.set("size", String(FAVICON_SIZE));
  return u.toString();
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
function sameTarget(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch { return a === b; }
}

/* ---------- persistence ---------- */
function defaultState() {
  const spaces = [
    { id: uid(), name: "クラウド", color: "#f5b740" },
    { id: uid(), name: "CFM", color: "#4dd6c8" },
    { id: uid(), name: "システムチーム", color: "#9b8cff" },
  ];
  return { version: 1, activeSpaceId: spaces[0].id, spaces, anchors: [] };
}
async function load() {
  const obj = await chrome.storage.local.get(KEY);
  if (obj[KEY] && obj[KEY].spaces && obj[KEY].spaces.length) {
    state = obj[KEY];
  } else {
    state = defaultState();
    await save();
  }
  if (!state.spaces.find((s) => s.id === state.activeSpaceId)) {
    state.activeSpaceId = state.spaces[0].id;
  }
}
async function save() {
  await chrome.storage.local.set({ [KEY]: state });
}

/* ---------- selectors ---------- */
const activeSpace = () =>
  state.spaces.find((s) => s.id === state.activeSpaceId) || state.spaces[0];
const anchorsIn = (spaceId) =>
  state.anchors.filter((a) => a.spaceId === spaceId).sort((a, b) => a.order - b.order);

/* ---------- tab actions ---------- */
async function openAnchor(anchor) {
  const tabs = await chrome.tabs.query({});
  const match = tabs.find((t) => t.url && sameTarget(t.url, anchor.url));
  if (match) {
    await chrome.tabs.update(match.id, { active: true });
    if (match.windowId != null) await chrome.windows.update(match.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: anchor.url });
  }
}
async function resetActiveTo(anchor) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await chrome.tabs.update(tab.id, { url: anchor.url });
}
async function activateTab(tabId) {
  await chrome.tabs.update(tabId, { active: true });
}
async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
}

/* ---------- mutations ---------- */
async function addAnchorFromTab(tab, spaceId) {
  if (!tab || !tab.url) return;
  const last = anchorsIn(spaceId).at(-1);
  state.anchors.push({
    id: uid(),
    spaceId,
    title: tab.title || hostOf(tab.url),
    url: tab.url,
    order: (last ? last.order : -1) + 1,
  });
  await save();
  render();
}
async function deleteAnchor(id) {
  state.anchors = state.anchors.filter((a) => a.id !== id);
  await save();
  render();
}
async function reorderAnchor(srcId, targetId, after) {
  const list = anchorsIn(activeSpace().id);
  const src = state.anchors.find((a) => a.id === srcId);
  if (!src) return;
  const ordered = list.filter((a) => a.id !== srcId);
  const idx = ordered.findIndex((a) => a.id === targetId);
  const insertAt = idx < 0 ? ordered.length : after ? idx + 1 : idx;
  ordered.splice(insertAt, 0, src);
  ordered.forEach((a, i) => (a.order = i));
  await save();
  render();
}

/* ---------- rendering ---------- */
function render() {
  renderSpaces();
  renderAnchors();
  document.body.parentElement; // noop
}
function renderSpaces() {
  const nav = $("#spaces");
  nav.innerHTML = "";
  state.spaces.forEach((s) => {
    const pill = document.createElement("button");
    pill.className = "space-pill" + (s.id === state.activeSpaceId ? " active" : "");
    pill.style.setProperty("--pill-color", s.color);
    pill.innerHTML =
      `<span class="dot" style="background:${s.color}"></span>` +
      `<span class="space-name"></span>` +
      `<span class="space-edit" title="編集">✎</span>`;
    pill.querySelector(".space-name").textContent = s.name;
    pill.addEventListener("click", (e) => {
      if (e.target.classList.contains("space-edit")) {
        openSpaceModal("edit", s);
        return;
      }
      state.activeSpaceId = s.id;
      save();
      render();
    });
    nav.appendChild(pill);
  });
  const add = document.createElement("button");
  add.className = "space-add";
  add.textContent = "+";
  add.title = "スペースを追加";
  add.addEventListener("click", () => openSpaceModal("add"));
  nav.appendChild(add);
}

function renderAnchors() {
  const grid = $("#anchorGrid");
  grid.innerHTML = "";
  const list = anchorsIn(activeSpace().id);
  $("#anchorCount").textContent = list.length ? String(list.length) : "";

  list.forEach((a) => {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.draggable = true;
    tile.dataset.id = a.id;

    const img = document.createElement("img");
    img.className = "fav";
    img.src = faviconUrl(a.url);
    img.alt = "";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = a.title || hostOf(a.url);

    const reset = document.createElement("button");
    reset.className = "reset";
    reset.title = "今のタブをこのURLに戻す";
    reset.textContent = "⟲";
    reset.addEventListener("click", (e) => { e.stopPropagation(); resetActiveTo(a); });

    const badge = document.createElement("button");
    badge.className = "badge";
    badge.title = "削除";
    badge.textContent = "×";
    badge.addEventListener("click", (e) => { e.stopPropagation(); deleteAnchor(a.id); });

    tile.append(reset, img, label, badge);

    tile.addEventListener("click", () => {
      if (editing) { openAnchorModal("edit", a); }
      else { openAnchor(a); }
    });
    // drag & drop reorder
    tile.addEventListener("dragstart", () => { dragId = a.id; tile.classList.add("dragging"); });
    tile.addEventListener("dragend", () => {
      dragId = null;
      tile.classList.remove("dragging");
      grid.querySelectorAll(".tile").forEach((t) => t.classList.remove("drop-before", "drop-after"));
    });
    tile.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (dragId === a.id) return;
      const rect = tile.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      tile.classList.toggle("drop-after", after);
      tile.classList.toggle("drop-before", !after);
    });
    tile.addEventListener("dragleave", () => tile.classList.remove("drop-before", "drop-after"));
    tile.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!dragId || dragId === a.id) return;
      const rect = tile.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      reorderAnchor(dragId, a.id, after);
    });

    grid.appendChild(tile);
  });

  // "add current" tile
  const add = document.createElement("div");
  add.className = "tile add";
  add.innerHTML = `<span class="plus">+</span><span class="add-label">現在のタブ</span>`;
  add.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await addAnchorFromTab(tab, activeSpace().id);
  });
  grid.appendChild(add);
}

async function renderLive() {
  const ul = $("#liveList");
  const tabs = await chrome.tabs.query({ currentWindow: true });
  $("#liveCount").textContent = tabs.length ? String(tabs.length) : "";
  ul.innerHTML = "";
  if (!tabs.length) {
    ul.innerHTML = `<li class="empty">開いているタブはありません</li>`;
    return;
  }
  tabs.sort((a, b) => a.index - b.index);
  tabs.forEach((t) => {
    const li = document.createElement("li");
    li.className = "trow" + (t.active ? " active" : "");

    const img = document.createElement("img");
    img.className = "fav";
    img.src = t.favIconUrl || faviconUrl(t.url || "");
    img.alt = "";
    img.addEventListener("error", () => { img.src = faviconUrl(t.url || ""); }, { once: true });

    const title = document.createElement("span");
    title.className = "ttitle";
    title.textContent = t.title || hostOf(t.url || "");
    title.title = t.url || "";

    const pin = document.createElement("button");
    pin.className = "act pin";
    pin.title = "錨に追加";
    pin.textContent = "⚓";
    pin.addEventListener("click", (e) => { e.stopPropagation(); addAnchorFromTab(t, activeSpace().id); });

    const close = document.createElement("button");
    close.className = "act close";
    close.title = "タブを閉じる";
    close.textContent = "×";
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.id); });

    li.append(img, title, pin, close);
    li.addEventListener("click", () => activateTab(t.id));
    ul.appendChild(li);
  });
}

/* ---------- anchor modal ---------- */
function openAnchorModal(mode, anchor) {
  modalCtx = { mode, anchorId: anchor ? anchor.id : null };
  $("#modalTitle").textContent = mode === "add" ? "錨を追加" : "錨を編集";
  $("#fTitle").value = anchor ? anchor.title : "";
  $("#fUrl").value = anchor ? anchor.url : "";
  const sel = $("#fSpace");
  sel.innerHTML = "";
  state.spaces.forEach((s) => {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = s.name;
    if (anchor && anchor.spaceId === s.id) o.selected = true;
    if (!anchor && s.id === state.activeSpaceId) o.selected = true;
    sel.appendChild(o);
  });
  $("#mDelete").style.display = mode === "edit" ? "" : "none";
  $("#overlay").classList.remove("hidden");
  $("#fTitle").focus();
}
function closeAnchorModal() { $("#overlay").classList.add("hidden"); modalCtx = null; }
async function saveAnchorModal() {
  if (!modalCtx) return;
  const title = $("#fTitle").value.trim();
  let url = $("#fUrl").value.trim();
  if (!url) return;
  if (!/^[a-zA-Z][\w+.-]*:/.test(url)) url = "https://" + url;
  const spaceId = $("#fSpace").value;
  if (modalCtx.mode === "edit") {
    const a = state.anchors.find((x) => x.id === modalCtx.anchorId);
    if (a) { a.title = title || hostOf(url); a.url = url; a.spaceId = spaceId; }
  } else {
    const last = anchorsIn(spaceId).at(-1);
    state.anchors.push({ id: uid(), spaceId, title: title || hostOf(url), url, order: (last ? last.order : -1) + 1 });
  }
  await save();
  closeAnchorModal();
  render();
}

/* ---------- space modal ---------- */
function openSpaceModal(mode, space) {
  spaceCtx = { mode, spaceId: space ? space.id : null, color: space ? space.color : SWATCHES[0] };
  $("#spaceModalTitle").textContent = mode === "add" ? "スペースを追加" : "スペースを編集";
  $("#sName").value = space ? space.name : "";
  const sw = $("#sSwatches");
  sw.innerHTML = "";
  SWATCHES.forEach((c) => {
    const b = document.createElement("button");
    b.className = "swatch" + (c === spaceCtx.color ? " sel" : "");
    b.style.background = c;
    b.addEventListener("click", () => {
      spaceCtx.color = c;
      sw.querySelectorAll(".swatch").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
    });
    sw.appendChild(b);
  });
  $("#sDelete").style.display = mode === "edit" && state.spaces.length > 1 ? "" : "none";
  $("#spaceOverlay").classList.remove("hidden");
  $("#sName").focus();
}
function closeSpaceModal() { $("#spaceOverlay").classList.add("hidden"); spaceCtx = null; }
async function saveSpaceModal() {
  if (!spaceCtx) return;
  const name = $("#sName").value.trim() || "スペース";
  if (spaceCtx.mode === "edit") {
    const s = state.spaces.find((x) => x.id === spaceCtx.spaceId);
    if (s) { s.name = name; s.color = spaceCtx.color; }
  } else {
    const s = { id: uid(), name, color: spaceCtx.color };
    state.spaces.push(s);
    state.activeSpaceId = s.id;
  }
  await save();
  closeSpaceModal();
  render();
}
async function deleteSpace() {
  if (!spaceCtx || state.spaces.length <= 1) return;
  const id = spaceCtx.spaceId;
  const sp = state.spaces.find((s) => s.id === id);
  const n = anchorsIn(id).length;
  if (!confirm(`スペース「${sp ? sp.name : ""}」と、その中の錨 ${n} 件を削除します。よろしいですか?`)) return;
  state.spaces = state.spaces.filter((s) => s.id !== id);
  state.anchors = state.anchors.filter((a) => a.spaceId !== id);
  if (state.activeSpaceId === id) state.activeSpaceId = state.spaces[0].id;
  await save();
  closeSpaceModal();
  render();
}

/* ---------- live refresh wiring ---------- */
let liveTimer = null;
function scheduleLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(renderLive, 120);
}
["onCreated", "onRemoved", "onUpdated", "onActivated", "onMoved", "onAttached", "onDetached"]
  .forEach((ev) => { if (chrome.tabs[ev]) chrome.tabs[ev].addListener(scheduleLive); });

/* ---------- boot ---------- */
function wireStaticUi() {
  $("#editToggle").addEventListener("click", () => {
    editing = !editing;
    document.querySelector(".app").classList.toggle("editing", editing);
    $("#editToggle").textContent = editing ? "完了" : "編集";
  });
  $("#mCancel").addEventListener("click", closeAnchorModal);
  $("#mSave").addEventListener("click", saveAnchorModal);
  $("#mDelete").addEventListener("click", async () => {
    if (modalCtx && modalCtx.anchorId) { await deleteAnchor(modalCtx.anchorId); closeAnchorModal(); }
  });
  $("#sCancel").addEventListener("click", closeSpaceModal);
  $("#sSave").addEventListener("click", saveSpaceModal);
  $("#sDelete").addEventListener("click", deleteSpace);
  $("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeAnchorModal(); });
  $("#spaceOverlay").addEventListener("click", (e) => { if (e.target.id === "spaceOverlay") closeSpaceModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeAnchorModal(); closeSpaceModal(); }
    if (e.key === "Enter") {
      if (!$("#overlay").classList.contains("hidden")) saveAnchorModal();
      else if (!$("#spaceOverlay").classList.contains("hidden")) saveSpaceModal();
    }
  });
}

(async function init() {
  wireStaticUi();
  await load();
  render();
  renderLive();
})();
