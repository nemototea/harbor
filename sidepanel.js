/* ============================================================
   Harbor — side panel logic (v0.2, bookmark-backed)

   Source of truth = the Bookmarks Bar.
     - Space            = a folder directly under the bar
     - "バー" space      = the loose bookmarks sitting on the bar itself
     - Anchor           = a bookmark (url node)
     - Section          = a sub-folder inside a space folder
   Harbor only stores a thin metadata layer in chrome.storage.local:
     harbor:meta:v2 = {
       spaceColor:      { [folderId]: "#hex" },
       collapsed:       { [folderId]: true },
       activeSpaceId:   string,
       density:         "compact" | "cozy"
     }
   ============================================================ */

const META_KEY = "harbor:meta:v2";
const FAVICON_SIZE = 32;
const SWATCHES = ["#f5b740", "#4dd6c8", "#9b8cff", "#f0604d", "#6ea8fe", "#7bd88f", "#e879c7"];
const BAR_SPACE = "__bar__"; // virtual id for the loose-bar space

let barId = null;
let meta = null;
let editing = false;
let filterText = "";
let liveTabs = [];
let modalCtx = null;
let spaceCtx = null;
let undoCtx = null;     // { msg, fn }
let snackTimer = null;
let dnd = null;         // current drag payload

/* ---------- utils ---------- */
const $ = (sel) => document.querySelector(sel);
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
const norm = (s) => (s || "").toLowerCase();

/* ---------- metadata persistence ---------- */
function defaultMeta() {
  return { spaceColor: {}, collapsed: {}, activeSpaceId: BAR_SPACE, density: "compact" };
}
async function loadMeta() {
  const obj = await chrome.storage.local.get(META_KEY);
  meta = Object.assign(defaultMeta(), obj[META_KEY] || {});
}
async function saveMeta() {
  await chrome.storage.local.set({ [META_KEY]: meta });
}
function colorFor(spaceId, idx) {
  return meta.spaceColor[spaceId] || SWATCHES[idx % SWATCHES.length];
}

/* ---------- bookmark helpers ---------- */
async function resolveBarId() {
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0];
  const kids = root.children || [];
  const bar =
    kids.find((c) => c.folderType === "bookmarks-bar") ||
    kids.find((c) => c.id === "1") ||
    kids.find((c) => !c.url) ||
    kids[0];
  return bar ? bar.id : "1";
}
const isFolder = (n) => !n.url;
const isAnchor = (n) => !!n.url;

// Spaces = bar itself (loose bookmarks) + each direct child folder of the bar.
async function getSpaces() {
  const barKids = await chrome.bookmarks.getChildren(barId);
  const spaces = [{ id: BAR_SPACE, folderId: barId, name: "バー", fixed: true }];
  barKids.filter(isFolder).forEach((f) => {
    spaces.push({ id: f.id, folderId: f.id, name: f.title || "(無題)", fixed: false });
  });
  return spaces;
}
// folder id backing a given space id
function folderIdOf(space) { return space.id === BAR_SPACE ? barId : space.id; }

// Returns { anchors:[node], sections:[{folder, anchors:[node]}] } for a space.
async function readSpace(space) {
  const fid = folderIdOf(space);
  const kids = await chrome.bookmarks.getChildren(fid);
  const anchors = kids.filter(isAnchor);
  // The bar space must NOT show its sub-folders (those ARE the other spaces).
  const sections = space.id === BAR_SPACE
    ? []
    : await Promise.all(
        kids.filter(isFolder).map(async (f) => ({
          folder: f,
          anchors: (await chrome.bookmarks.getChildren(f.id)).filter(isAnchor),
        }))
      );
  return { anchors, sections };
}

async function activeSpace(spaces) {
  spaces = spaces || (await getSpaces());
  return spaces.find((s) => s.id === meta.activeSpaceId) || spaces[0];
}

/* ---------- tab actions ---------- */
async function openUrl(url) {
  const tabs = await chrome.tabs.query({});
  const match = tabs.find((t) => t.url && sameTarget(t.url, url));
  if (match) {
    await chrome.tabs.update(match.id, { active: true });
    if (match.windowId != null) await chrome.windows.update(match.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}
async function resetActiveTo(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await chrome.tabs.update(tab.id, { url });
}

/* ---------- space verbs ---------- */
async function openAllInActiveSpace() {
  const space = await activeSpace();
  const { anchors, sections } = await readSpace(space);
  const all = [...anchors, ...sections.flatMap((s) => s.anchors)];
  if (!all.length) return;
  const created = [];
  for (const a of all) {
    const tab = await chrome.tabs.create({ url: a.url, active: false });
    created.push(tab.id);
  }
  if (chrome.tabGroups && created.length) {
    try {
      const gid = await chrome.tabs.group({ tabIds: created });
      await chrome.tabGroups.update(gid, { title: space.name, color: "yellow" });
    } catch { /* grouping is best-effort */ }
  }
}
async function tidyLiveTabs() {
  const space = await activeSpace();
  const { anchors, sections } = await readSpace(space);
  const anchored = [...anchors, ...sections.flatMap((s) => s.anchors)];
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const toClose = tabs.filter(
    (t) => !t.active && !t.pinned && t.url && !anchored.some((a) => sameTarget(a.url, t.url))
  );
  if (!toClose.length) return;
  if (!confirm(`錨になっていないタブ ${toClose.length} 件を閉じます。よろしいですか?`)) return;
  await chrome.tabs.remove(toClose.map((t) => t.id));
}

/* ---------- mutations (bookmarks) ---------- */
async function createAnchor(parentId, title, url, index) {
  const opts = { parentId, title: title || hostOf(url), url };
  if (index != null) opts.index = index;
  return chrome.bookmarks.create(opts);
}
async function removeAnchorWithUndo(node) {
  const parentId = node.parentId;
  const index = node.index;
  const title = node.title;
  const url = node.url;
  await chrome.bookmarks.remove(node.id);
  showUndo(`「${title || hostOf(url)}」を削除`, async () => {
    await createAnchor(parentId, title, url, index);
  });
}

/* ---------- undo snackbar ---------- */
function showUndo(msg, fn) {
  undoCtx = { msg, fn };
  $("#snackMsg").textContent = msg;
  $("#snackbar").classList.remove("hidden");
  clearTimeout(snackTimer);
  snackTimer = setTimeout(hideUndo, 6000);
}
function hideUndo() {
  $("#snackbar").classList.add("hidden");
  undoCtx = null;
}
async function runUndo() {
  if (undoCtx) { const fn = undoCtx.fn; hideUndo(); await fn(); }
}

/* ============================================================
   RENDER
   ============================================================ */
async function renderAll() {
  const spaces = await getSpaces();
  if (!spaces.find((s) => s.id === meta.activeSpaceId)) meta.activeSpaceId = spaces[0].id;
  renderSpaces(spaces);
  await renderAnchored(spaces);
  await renderLive();
}

/* ---------- spaces ---------- */
function renderSpaces(spaces) {
  const nav = $("#spaces");
  nav.innerHTML = "";
  spaces.forEach((s, idx) => {
    const color = colorFor(s.id, idx);
    const pill = document.createElement("button");
    pill.className = "space-pill" + (s.id === meta.activeSpaceId ? " active" : "");
    pill.style.setProperty("--pill-color", color);
    pill.dataset.id = s.id;
    pill.draggable = !s.fixed;
    pill.innerHTML =
      `<span class="dot" style="background:${color}"></span>` +
      `<span class="space-name"></span>` +
      (s.fixed ? "" : `<span class="space-edit" title="編集">✎</span>`);
    pill.querySelector(".space-name").textContent = s.name;
    pill.addEventListener("click", (e) => {
      if (e.target.classList.contains("space-edit")) { openSpaceModal("edit", s, idx); return; }
      meta.activeSpaceId = s.id; saveMeta(); renderAll();
    });
    // drag-reorder folders (bar space is fixed/first)
    if (!s.fixed) wireSpaceDrag(pill, s);
    nav.appendChild(pill);
  });
  const add = document.createElement("button");
  add.className = "space-add";
  add.textContent = "+";
  add.title = "スペースを追加（バーにフォルダを作成）";
  add.addEventListener("click", () => openSpaceModal("add"));
  nav.appendChild(add);
}

function wireSpaceDrag(pill, space) {
  pill.addEventListener("dragstart", (e) => {
    dnd = { kind: "space", id: space.id };
    pill.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  pill.addEventListener("dragend", () => {
    pill.classList.remove("dragging");
    $("#spaces").querySelectorAll(".space-pill").forEach((p) => p.classList.remove("drop-before", "drop-after"));
    dnd = null;
  });
  pill.addEventListener("dragover", (e) => {
    if (!dnd || dnd.kind !== "space" || dnd.id === space.id) return;
    e.preventDefault();
    const r = pill.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    pill.classList.toggle("drop-after", after);
    pill.classList.toggle("drop-before", !after);
  });
  pill.addEventListener("dragleave", () => pill.classList.remove("drop-before", "drop-after"));
  pill.addEventListener("drop", async (e) => {
    if (!dnd || dnd.kind !== "space" || dnd.id === space.id) return;
    e.preventDefault();
    const r = pill.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    await moveSpaceFolder(dnd.id, space.id, after);
  });
}

async function moveSpaceFolder(srcId, targetId, after) {
  // index is among the bar's children; the bar space (loose bookmarks) isn't a folder, so skip it.
  const barKids = await chrome.bookmarks.getChildren(barId);
  const folders = barKids.filter(isFolder);
  const target = folders.find((f) => f.id === targetId);
  const src = folders.find((f) => f.id === srcId);
  if (!target || !src) return;
  let destIndex = target.index + (after ? 1 : 0);
  if (src.index < destIndex) destIndex -= 1; // account for removal shift within same parent
  await chrome.bookmarks.move(srcId, { parentId: barId, index: destIndex });
}

/* ---------- anchored grid + sections ---------- */
async function renderAnchored(spaces) {
  spaces = spaces || (await getSpaces());
  const space = await activeSpace(spaces);
  const wrap = $("#anchoredScroll");
  wrap.innerHTML = "";
  document.querySelector(".app").classList.toggle("dense", meta.density === "compact");

  const { anchors, sections } = await readSpace(space);
  const total = anchors.length + sections.reduce((n, s) => n + s.anchors.length, 0);
  $("#anchorCount").textContent = total ? String(total) : "";

  const lit = await currentlyOpenUrls();

  // main grid (space-level anchors)
  const mainGrid = buildGrid(folderIdOf(space), anchors, lit);
  wrap.appendChild(mainGrid);

  // "add current tab" tile lives in the main grid
  appendAddTile(mainGrid, folderIdOf(space));

  // sections (sub-folders)
  sections.forEach((sec) => {
    const collapsed = !!meta.collapsed[sec.folder.id];
    const head = document.createElement("div");
    head.className = "section-head" + (collapsed ? " collapsed" : "");
    head.innerHTML =
      `<span class="caret">▸</span><span class="section-name"></span>` +
      `<span class="section-count">${sec.anchors.length}</span>`;
    head.querySelector(".section-name").textContent = sec.folder.title || "(無題)";
    head.addEventListener("click", () => {
      meta.collapsed[sec.folder.id] = !collapsed; saveMeta(); renderAnchored();
    });
    wrap.appendChild(head);
    if (!collapsed) {
      const grid = buildGrid(sec.folder.id, sec.anchors, lit);
      wrap.appendChild(grid);
    }
  });

  if (total === 0 && space.id === BAR_SPACE) {
    const empty = document.createElement("div");
    empty.className = "empty-hint";
    empty.innerHTML =
      `ブックマークバーが空です。<br>下のタブをここへドラッグするか「＋ 現在のタブ」で錨を作成。<br>` +
      `「＋」スペースでバーにフォルダ＝スペースを追加できます。`;
    wrap.appendChild(empty);
  }
}

function buildGrid(parentId, anchors, litSet) {
  const grid = document.createElement("div");
  grid.className = "grid";
  grid.dataset.parent = parentId;
  wireGridDrop(grid, parentId);

  anchors.forEach((a) => {
    const hit = filterText && !(norm(a.title).includes(filterText) || norm(a.url).includes(filterText));
    const tile = document.createElement("div");
    tile.className = "tile" + (litSet.has(litKey(a.url)) ? " lit" : "") + (hit ? " dim" : "");
    tile.draggable = true;
    tile.dataset.id = a.id;

    const img = document.createElement("img");
    img.className = "fav";
    img.src = faviconUrl(a.url);
    img.alt = "";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = a.title || hostOf(a.url);
    tile.title = `${a.title || ""}\n${a.url}`;

    const reset = document.createElement("button");
    reset.className = "reset";
    reset.title = "今のタブをこのURLに戻す";
    reset.textContent = "⟲";
    reset.addEventListener("click", (e) => { e.stopPropagation(); resetActiveTo(a.url); });

    const badge = document.createElement("button");
    badge.className = "badge";
    badge.title = "削除（ブックマークを削除）";
    badge.textContent = "×";
    badge.addEventListener("click", (e) => { e.stopPropagation(); removeAnchorWithUndo(a); });

    const dock = document.createElement("span");
    dock.className = "dock-dot";
    dock.title = "現在このタブが開いています";

    tile.append(reset, img, label, badge, dock);
    tile.addEventListener("click", () => {
      if (editing) openAnchorModal("edit", a);
      else openUrl(a.url);
    });
    wireTileDrag(tile, a, parentId);
    grid.appendChild(tile);
  });
  return grid;
}

function appendAddTile(grid, parentId) {
  const add = document.createElement("div");
  add.className = "tile add";
  add.innerHTML = `<span class="plus">+</span><span class="add-label">現在のタブ</span>`;
  add.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) await createAnchor(parentId, tab.title, tab.url);
  });
  grid.appendChild(add);
}

/* ---------- anchor & live drag/drop ---------- */
function wireTileDrag(tile, node, parentId) {
  tile.addEventListener("dragstart", (e) => {
    dnd = { kind: "anchor", id: node.id, fromParent: parentId };
    tile.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  tile.addEventListener("dragend", () => {
    tile.classList.remove("dragging");
    document.querySelectorAll(".tile").forEach((t) => t.classList.remove("drop-before", "drop-after"));
    document.querySelectorAll(".grid").forEach((g) => g.classList.remove("drop-into"));
    dnd = null;
  });
  tile.addEventListener("dragover", (e) => {
    if (!dnd) return;
    if (dnd.kind === "anchor" && dnd.id === node.id) return;
    e.preventDefault();
    e.stopPropagation();
    const r = tile.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    tile.classList.toggle("drop-after", after);
    tile.classList.toggle("drop-before", !after);
  });
  tile.addEventListener("dragleave", () => tile.classList.remove("drop-before", "drop-after"));
  tile.addEventListener("drop", async (e) => {
    if (!dnd) return;
    e.preventDefault();
    e.stopPropagation();
    const r = tile.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    const target = await chrome.bookmarks.get(node.id).then((x) => x[0]);
    let index = target.index + (after ? 1 : 0);
    await dropOnto(parentId, index);
  });
}

function wireGridDrop(grid, parentId) {
  grid.addEventListener("dragover", (e) => {
    if (!dnd) return;
    e.preventDefault();
    grid.classList.add("drop-into");
  });
  grid.addEventListener("dragleave", (e) => {
    if (e.target === grid) grid.classList.remove("drop-into");
  });
  grid.addEventListener("drop", async (e) => {
    if (!dnd) return;
    e.preventDefault();
    grid.classList.remove("drop-into");
    // dropped on empty area → append to end
    await dropOnto(parentId, null);
  });
}

async function dropOnto(parentId, index) {
  if (!dnd) return;
  if (dnd.kind === "live") {
    // promote a live tab → create bookmark
    const tab = liveTabs.find((t) => t.id === dnd.tabId);
    if (tab && tab.url) await createAnchor(parentId, tab.title, tab.url, index);
  } else if (dnd.kind === "anchor") {
    // move/reorder bookmark; account for index shift within same parent
    const node = (await chrome.bookmarks.get(dnd.id))[0];
    let dest = index;
    if (dest != null && node.parentId === parentId && node.index < dest) dest -= 1;
    await chrome.bookmarks.move(dnd.id, dest == null ? { parentId } : { parentId, index: dest });
  }
  dnd = null;
}

/* ---------- live ---------- */
function litKey(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url || ""; }
}
async function currentlyOpenUrls() {
  const tabs = await chrome.tabs.query({});
  return new Set(tabs.filter((t) => t.url).map((t) => litKey(t.url)));
}

async function renderLive() {
  const ul = $("#liveList");
  liveTabs = await chrome.tabs.query({ currentWindow: true });
  $("#liveCount").textContent = liveTabs.length ? String(liveTabs.length) : "";
  ul.innerHTML = "";
  if (!liveTabs.length) {
    ul.innerHTML = `<li class="empty">開いているタブはありません</li>`;
    return;
  }

  // which live tabs correspond to an anchor anywhere in the bar tree
  const anchorUrls = await allAnchorKeys();

  liveTabs.sort((a, b) => a.index - b.index);
  liveTabs.forEach((t) => {
    const docked = t.url && anchorUrls.has(litKey(t.url));
    const li = document.createElement("li");
    li.className = "trow" + (t.active ? " active" : "") + (docked ? " docked" : "");
    li.draggable = true;
    li.dataset.tabId = String(t.id);

    const img = document.createElement("img");
    img.className = "fav";
    img.src = t.favIconUrl || faviconUrl(t.url || "");
    img.alt = "";
    img.addEventListener("error", () => { img.src = faviconUrl(t.url || ""); }, { once: true });

    const title = document.createElement("span");
    title.className = "ttitle";
    title.textContent = t.title || hostOf(t.url || "");
    title.title = t.url || "";

    const moored = document.createElement("span");
    moored.className = "moored";
    moored.title = "この URL は錨として登録済み";
    moored.textContent = "⚓";

    const pin = document.createElement("button");
    pin.className = "act pin";
    pin.title = "錨に追加（このスペースへ）";
    pin.textContent = "⚓";
    pin.addEventListener("click", async (e) => {
      e.stopPropagation();
      const space = await activeSpace();
      if (t.url) await createAnchor(folderIdOf(space), t.title, t.url);
    });

    const close = document.createElement("button");
    close.className = "act close";
    close.title = "タブを閉じる";
    close.textContent = "×";
    close.addEventListener("click", (e) => { e.stopPropagation(); chrome.tabs.remove(t.id); });

    li.append(img, title, moored, pin, close);
    li.addEventListener("click", () => chrome.tabs.update(t.id, { active: true }));

    // drag to promote
    li.addEventListener("dragstart", (e) => {
      dnd = { kind: "live", tabId: t.id };
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "copy";
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      document.querySelectorAll(".grid").forEach((g) => g.classList.remove("drop-into"));
      dnd = null;
    });

    ul.appendChild(li);
  });
}

async function allAnchorKeys() {
  // gather every bookmark url under the bar (anchors across all spaces/sections)
  const sub = await chrome.bookmarks.getSubTree(barId);
  const keys = new Set();
  const walk = (n) => {
    if (n.url) keys.add(litKey(n.url));
    (n.children || []).forEach(walk);
  };
  (sub[0].children || []).forEach(walk);
  return keys;
}

/* ============================================================
   MODALS
   ============================================================ */
async function openAnchorModal(mode, node) {
  modalCtx = { mode, id: node ? node.id : null };
  $("#modalTitle").textContent = mode === "add" ? "錨を追加" : "錨を編集";
  $("#fTitle").value = node ? (node.title || "") : "";
  $("#fUrl").value = node ? (node.url || "") : "";
  const sel = $("#fSpace");
  sel.innerHTML = "";
  const spaces = await getSpaces();
  const cur = node ? node.parentId : folderIdOf(await activeSpace(spaces));
  spaces.forEach((s) => {
    const o = document.createElement("option");
    o.value = folderIdOf(s); o.textContent = s.name;
    if (folderIdOf(s) === cur) o.selected = true;
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
  const parentId = $("#fSpace").value;
  if (modalCtx.mode === "edit") {
    await chrome.bookmarks.update(modalCtx.id, { title: title || hostOf(url), url });
    const node = (await chrome.bookmarks.get(modalCtx.id))[0];
    if (node.parentId !== parentId) await chrome.bookmarks.move(modalCtx.id, { parentId });
  } else {
    await createAnchor(parentId, title, url);
  }
  closeAnchorModal();
}

async function openSpaceModal(mode, space, idx) {
  spaceCtx = { mode, id: space ? space.id : null, color: space ? colorFor(space.id, idx || 0) : SWATCHES[0] };
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
  $("#sDelete").style.display = mode === "edit" ? "" : "none";
  $("#spaceOverlay").classList.remove("hidden");
  $("#sName").focus();
}
function closeSpaceModal() { $("#spaceOverlay").classList.add("hidden"); spaceCtx = null; }
async function saveSpaceModal() {
  if (!spaceCtx) return;
  const name = $("#sName").value.trim() || "スペース";
  if (spaceCtx.mode === "edit") {
    if (spaceCtx.id !== BAR_SPACE) await chrome.bookmarks.update(spaceCtx.id, { title: name });
    meta.spaceColor[spaceCtx.id] = spaceCtx.color;
  } else {
    const f = await chrome.bookmarks.create({ parentId: barId, title: name });
    meta.spaceColor[f.id] = spaceCtx.color;
    meta.activeSpaceId = f.id;
  }
  await saveMeta();
  closeSpaceModal();
}
async function deleteSpace() {
  if (!spaceCtx || spaceCtx.id === BAR_SPACE) return;
  const node = (await chrome.bookmarks.getSubTree(spaceCtx.id))[0];
  const count = (node.children || []).filter(isAnchor).length;
  const name = node.title || "";
  if (!confirm(`スペース「${name}」とその中の錨 ${count} 件（ブックマーク）を削除します。よろしいですか?`)) return;
  await chrome.bookmarks.removeTree(spaceCtx.id);
  delete meta.spaceColor[spaceCtx.id];
  if (meta.activeSpaceId === spaceCtx.id) meta.activeSpaceId = BAR_SPACE;
  await saveMeta();
  closeSpaceModal();
}

/* ============================================================
   WIRING / BOOT
   ============================================================ */
let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderAll, 100);
}

function wireStaticUi() {
  $("#editToggle").addEventListener("click", () => {
    editing = !editing;
    document.querySelector(".app").classList.toggle("editing", editing);
    $("#editToggle").textContent = editing ? "完了" : "編集";
  });
  $("#densityToggle").addEventListener("click", () => {
    meta.density = meta.density === "compact" ? "cozy" : "compact";
    saveMeta(); renderAnchored();
  });
  $("#filter").addEventListener("input", (e) => { filterText = norm(e.target.value); renderAnchored(); });
  $("#spaceOpenAll").addEventListener("click", openAllInActiveSpace);
  $("#tidyBtn").addEventListener("click", tidyLiveTabs);

  $("#mCancel").addEventListener("click", closeAnchorModal);
  $("#mSave").addEventListener("click", saveAnchorModal);
  $("#mDelete").addEventListener("click", async () => {
    if (modalCtx && modalCtx.id) {
      const node = (await chrome.bookmarks.get(modalCtx.id))[0];
      closeAnchorModal();
      await removeAnchorWithUndo(node);
    }
  });
  $("#sCancel").addEventListener("click", closeSpaceModal);
  $("#sSave").addEventListener("click", saveSpaceModal);
  $("#sDelete").addEventListener("click", deleteSpace);
  $("#snackUndo").addEventListener("click", runUndo);

  $("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeAnchorModal(); });
  $("#spaceOverlay").addEventListener("click", (e) => { if (e.target.id === "spaceOverlay") closeSpaceModal(); });

  document.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") { closeAnchorModal(); closeSpaceModal(); hideUndo(); return; }
    if (e.key === "Enter") {
      if (!$("#overlay").classList.contains("hidden")) { saveAnchorModal(); return; }
      if (!$("#spaceOverlay").classList.contains("hidden")) { saveSpaceModal(); return; }
    }
    // number keys 1–9 switch spaces (when not typing)
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
    if (!typing && /^[1-9]$/.test(e.key)) {
      const spaces = await getSpaces();
      const target = spaces[Number(e.key) - 1];
      if (target) { meta.activeSpaceId = target.id; saveMeta(); renderAll(); }
    }
  });

  // react to external bookmark + tab changes
  ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered", "onImportEnded"]
    .forEach((ev) => { if (chrome.bookmarks[ev]) chrome.bookmarks[ev].addListener(scheduleRender); });
  ["onCreated", "onRemoved", "onUpdated", "onActivated", "onMoved", "onAttached", "onDetached"]
    .forEach((ev) => { if (chrome.tabs[ev]) chrome.tabs[ev].addListener(scheduleRender); });
}

(async function init() {
  wireStaticUi();
  await loadMeta();
  barId = await resolveBarId();
  await renderAll();
})();
