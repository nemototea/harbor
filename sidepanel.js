/*
 * Harbor — side panel workspace, anchored to your bookmarks bar.
 * Copyright (C) 2026 nemototea
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Free software under the GNU GPL v3 or later; distributed WITHOUT ANY
 * WARRANTY. See the LICENSE file in the project root for the full text.
 */

/* ============================================================
   Harbor — side panel logic (v0.3, bookmark-backed)

   Source of truth = the Bookmarks Bar.
     - Space   = a FOLDER directly under the bar   (pills, 1–9)
     - Pin     = a loose bookmark sitting on the bar itself (always-visible rail)
     - Anchor  = a bookmark (url node) inside a space folder
     - Section = a sub-folder inside a space folder (collapsible)
   LIVE behaves like a vertical-tab manager: tabs grouped by Chrome
   tab groups (color/title/collapse/add/create/ungroup), split-view aware.

   Harbor stores only a thin metadata layer in chrome.storage.local:
     harbor:meta:v2 = { spaceColor:{id:hex}, collapsed:{id:true},
                        activeSpaceId, density }
   ============================================================ */

const META_KEY = "harbor:meta:v2";
const FAVICON_SIZE = 32;
const SWATCHES = ["#f5b740", "#4dd6c8", "#9b8cff", "#f0604d", "#6ea8fe", "#7bd88f", "#e879c7"];
const NONE = -1; // chrome.tabs.TAB_GROUP_ID_NONE
const GROUP_COLORS = {
  grey: "#9aa0a6", blue: "#6ea8fe", red: "#f0604d", yellow: "#f5b740",
  green: "#7bd88f", pink: "#e879c7", purple: "#9b8cff", cyan: "#4dd6c8", orange: "#f59f4d",
};
const GROUP_COLOR_NAMES = Object.keys(GROUP_COLORS);

let barId = null;
let meta = null;
let filterText = "";
let liveTabs = [];
let modalCtx = null;
let spaceCtx = null;
let undoCtx = null;
let snackTimer = null;
let dnd = null;
let dialogResolve = null;

/* ---------- i18n ---------- */
const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

function localizeHtml() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  });
}

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
function litKey(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url || ""; }
}
function sameTarget(a, b) {
  try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; }
  catch { return a === b; }
}
const norm = (s) => (s || "").toLowerCase();
const isFolder = (n) => !n.url;
const isAnchor = (n) => !!n.url;
const splitNone = () => (chrome.tabs && chrome.tabs.SPLIT_VIEW_ID_NONE != null ? chrome.tabs.SPLIT_VIEW_ID_NONE : -1);

/* ---------- metadata ---------- */
function defaultMeta() { return { spaceColor: {}, collapsed: {}, activeSpaceId: null, density: "compact", tourSeen: false }; }
async function loadMeta() {
  const obj = await chrome.storage.local.get(META_KEY);
  meta = Object.assign(defaultMeta(), obj[META_KEY] || {});
}
async function saveMeta() { await chrome.storage.local.set({ [META_KEY]: meta }); }
function colorFor(id, idx) { return meta.spaceColor[id] || SWATCHES[(idx || 0) % SWATCHES.length]; }

/* ---------- bookmark model ---------- */
async function resolveBarId() {
  const tree = await chrome.bookmarks.getTree();
  const kids = (tree[0] && tree[0].children) || [];
  const bar =
    kids.find((c) => c.folderType === "bookmarks-bar") ||
    kids.find((c) => c.id === "1") ||
    kids.find((c) => !c.url) || kids[0];
  return bar ? bar.id : "1";
}
// Spaces = direct child FOLDERS of the bar (loose bookmarks are NOT spaces).
async function getSpaces() {
  const kids = await chrome.bookmarks.getChildren(barId);
  return kids.filter(isFolder).map((f) => ({ id: f.id, name: f.title || t("untitled"), index: f.index }));
}
async function getPins() {
  const kids = await chrome.bookmarks.getChildren(barId);
  return kids.filter(isAnchor);
}
async function readSpace(spaceId) {
  const kids = await chrome.bookmarks.getChildren(spaceId);
  const anchors = kids.filter(isAnchor);
  const sections = await Promise.all(
    kids.filter(isFolder).map(async (f) => ({
      folder: f, anchors: (await chrome.bookmarks.getChildren(f.id)).filter(isAnchor),
    }))
  );
  return { anchors, sections };
}
async function activeSpace(spaces) {
  spaces = spaces || (await getSpaces());
  if (!spaces.length) return null;
  return spaces.find((s) => s.id === meta.activeSpaceId) || spaces[0];
}
async function allAnchorKeys() {
  const sub = await chrome.bookmarks.getSubTree(barId);
  const keys = new Set();
  const walk = (n) => { if (n.url) keys.add(litKey(n.url)); (n.children || []).forEach(walk); };
  (sub[0].children || []).forEach(walk);
  return keys;
}
async function currentlyOpenUrls() {
  const tabs = await chrome.tabs.query({});
  return new Set(tabs.filter((t) => t.url).map((t) => litKey(t.url)));
}

/* ---------- tab actions ---------- */
async function openUrl(url) {
  const tabs = await chrome.tabs.query({});
  const match = tabs.find((t) => t.url && sameTarget(t.url, url));
  if (match) {
    await chrome.tabs.update(match.id, { active: true });
    if (match.windowId != null) await chrome.windows.update(match.windowId, { focused: true });
  } else { await chrome.tabs.create({ url }); }
}
async function resetActiveTo(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await chrome.tabs.update(tab.id, { url });
}

/* ---------- space verbs ---------- */
async function openAllInActiveSpace() {
  const space = await activeSpace();
  if (!space) return;
  const { anchors, sections } = await readSpace(space.id);
  const all = [...anchors, ...sections.flatMap((s) => s.anchors)];
  if (!all.length) return;
  const created = [];
  for (const a of all) { const tab = await chrome.tabs.create({ url: a.url, active: false }); created.push(tab.id); }
  if (chrome.tabGroups && created.length) {
    try {
      const gid = await chrome.tabs.group({ tabIds: created });
      await chrome.tabGroups.update(gid, { title: space.name });
    } catch { /* best effort */ }
  }
}
async function tidyLiveTabs() {
  const saved = await allAnchorKeys();
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const toClose = tabs.filter((t) => !t.active && !t.pinned && t.url && !saved.has(litKey(t.url)));
  if (!toClose.length) return;
  if (!(await confirmDialog(t("tidyConfirm", [String(toClose.length)]), { okLabel: t("tidyBtnLabel") }))) return;
  await chrome.tabs.remove(toClose.map((t) => t.id));
}

/* ---------- mutations ---------- */
async function createAnchor(parentId, title, url, index) {
  const opts = { parentId, title: title || hostOf(url), url };
  if (index != null) opts.index = index;
  return chrome.bookmarks.create(opts);
}
async function removeAnchorWithUndo(node) {
  const { parentId, index, title, url } = node;
  await chrome.bookmarks.remove(node.id);
  showUndo(t("deletedMsg", [title || hostOf(url)]), async () => { await createAnchor(parentId, title, url, index); });
}

/* ---------- undo snackbar ---------- */
function showUndo(msg, fn) {
  undoCtx = { fn };
  $("#snackMsg").textContent = msg;
  $("#snackbar").classList.remove("hidden");
  clearTimeout(snackTimer);
  snackTimer = setTimeout(hideUndo, 6000);
}
function hideUndo() { $("#snackbar").classList.add("hidden"); undoCtx = null; }
async function runUndo() { if (undoCtx) { const fn = undoCtx.fn; hideUndo(); await fn(); } }

/* ============================================================
   ITEM MENU  — one overflow ( ⋯ ) menu, shared by hover button
   AND right-click. Used by spaces, groups, anchors and pins so
   rename / delete / etc. live in a single discoverable place.
   ============================================================ */
function closeItemMenu() { const m = $("#itemMenu"); if (m) { m.classList.add("hidden"); m.innerHTML = ""; } }
function itemMenuOpen() { const m = $("#itemMenu"); return m && !m.classList.contains("hidden"); }
// rows: [{ icon, label, danger?, onClick }] | { sep: true }
function openItemMenu(rows, x, y, anchorEl) {
  const menu = $("#itemMenu");
  menu.innerHTML = "";
  rows.forEach((r) => {
    if (r.sep) { const hr = document.createElement("div"); hr.className = "im-sep"; menu.appendChild(hr); return; }
    const b = document.createElement("button");
    b.className = "im-row" + (r.danger ? " danger" : "");
    const ico = document.createElement("span"); ico.className = "im-ico"; ico.textContent = r.icon || "";
    const lbl = document.createElement("span"); lbl.className = "im-label"; lbl.textContent = r.label;
    b.append(ico, lbl);
    b.addEventListener("click", async (e) => { e.stopPropagation(); closeItemMenu(); await r.onClick(); });
    menu.appendChild(b);
  });
  menu.classList.remove("hidden");
  // measure, then clamp into the viewport (anchored under the ⋯ button, or at the cursor)
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let px = x, py = y;
  if (anchorEl) { const r = anchorEl.getBoundingClientRect(); px = r.right - mw; py = r.bottom + 4; }
  px = Math.max(8, Math.min(px, window.innerWidth - mw - 8));
  py = Math.max(8, Math.min(py, window.innerHeight - mh - 8));
  menu.style.left = px + "px"; menu.style.top = py + "px";
  const first = menu.querySelector(".im-row"); if (first) first.focus();
}
// attach the SAME menu to an element's right-click; getRows is called lazily
function wireContextMenu(el, getRows) {
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    openItemMenu(getRows(), e.clientX, e.clientY);
  });
}
// the visible hover/focus affordance — a ⋯ button opening the same menu
function makeMoreBtn(getRows) {
  const b = document.createElement("button");
  b.className = "more"; b.textContent = "⋯";
  b.title = t("moreActionsTitle"); b.setAttribute("aria-label", t("moreActionsTitle"));
  b.addEventListener("click", (e) => { e.stopPropagation(); openItemMenu(getRows(), 0, 0, b); });
  return b;
}

/* ============================================================
   DIALOG  — in-app confirm / prompt (replaces window.confirm /
   window.prompt so destructive + rename flows stay on-brand and
   keyboard-driven). Resolves to the input string, true, or null.
   ============================================================ */
function openDialog({ title, message, input, defaultValue, okLabel, cancelLabel, danger }) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    $("#dlgTitle").textContent = title || "";
    const msgEl = $("#dlgMsg");
    msgEl.textContent = message || "";
    msgEl.classList.toggle("hidden", !message);
    const hasInput = !!input;
    $("#dlgInputWrap").classList.toggle("hidden", !hasInput);
    if (hasInput) $("#dlgInput").value = defaultValue || "";
    const ok = $("#dlgOk");
    ok.textContent = okLabel || t("okLabel");
    ok.classList.toggle("btn-danger", !!danger);
    ok.classList.toggle("btn-primary", !danger);
    $("#dlgCancel").textContent = cancelLabel || t("cancelLabel");
    $("#dialogOverlay").classList.remove("hidden");
    (hasInput ? $("#dlgInput") : ok).focus();
    if (hasInput) $("#dlgInput").select();
  });
}
function closeDialog(result) {
  $("#dialogOverlay").classList.add("hidden");
  const r = dialogResolve; dialogResolve = null;
  if (r) r(result);
}
function submitDialog() {
  if (!dialogResolve) return;
  const hasInput = !$("#dlgInputWrap").classList.contains("hidden");
  closeDialog(hasInput ? $("#dlgInput").value : true);
}
async function confirmDialog(message, opts = {}) {
  const r = await openDialog({
    title: opts.title || t("confirmTitle"), message,
    okLabel: opts.okLabel || t("okLabel"), danger: opts.danger !== false,
  });
  return r === true;
}
async function promptDialog(title, defaultValue, opts = {}) {
  const r = await openDialog({
    title, message: opts.message, input: true, defaultValue,
    okLabel: opts.okLabel || t("saveLabel"),
  });
  return r == null ? null : String(r);
}

/* ============================================================
   RENDER
   ============================================================ */
async function renderAll() {
  try {
    const spaces = await getSpaces();
    if (spaces.length && !spaces.find((s) => s.id === meta.activeSpaceId)) meta.activeSpaceId = spaces[0].id;
    renderSpaces(spaces);
    await renderPins();
    await renderAnchored(spaces);
    await renderLive();
  } catch (err) { console.warn("Harbor: render failed", err); }
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
    pill.draggable = true;
    pill.innerHTML =
      `<span class="dot" style="background:${color}"></span><span class="space-name"></span>`;
    pill.querySelector(".space-name").textContent = s.name;
    const rows = () => [
      { icon: "✎", label: t("menuEditSpace"), onClick: () => openSpaceModal("edit", s, idx) },
      { sep: true },
      { icon: "×", label: t("deleteLabel"), danger: true, onClick: () => deleteSpaceById(s.id) },
    ];
    pill.appendChild(makeMoreBtn(rows));
    wireContextMenu(pill, rows);
    pill.addEventListener("click", (e) => {
      if (e.target.closest(".more")) return;
      meta.activeSpaceId = s.id; saveMeta(); renderAll();
    });
    wireSpaceDrag(pill, s);
    nav.appendChild(pill);
  });
  const add = document.createElement("button");
  add.className = "space-add";
  add.textContent = "+";
  add.title = t("addSpaceTitle");
  add.addEventListener("click", () => openSpaceModal("add"));
  nav.appendChild(add);
  // keep the active pill visible when switching via keys / swipe
  const act = nav.querySelector(".space-pill.active");
  if (act) act.scrollIntoView({ inline: "center", block: "nearest" });
}

/* ---------- Arc-style horizontal swipe to switch spaces ---------- */
let swipeAccum = 0, swipeLast = 0, swipeWheelTs = 0;
const SWIPE_THRESH = 200;
async function switchSpace(dir) {
  const spaces = await getSpaces();
  if (!spaces.length) return;
  let i = spaces.findIndex((s) => s.id === meta.activeSpaceId);
  if (i < 0) i = 0;
  const ni = Math.max(0, Math.min(spaces.length - 1, i + dir));
  if (ni === i) return;
  meta.activeSpaceId = spaces[ni].id; saveMeta(); renderAll();
}
function wireSpaceSwipe() {
  window.addEventListener("wheel", (e) => {
    // let the horizontally-scrollable rails consume their own gestures first
    if (e.target.closest && (e.target.closest(".spaces") || e.target.closest(".pins"))) return;
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.2) return; // ignore vertical/diagonal scrolls
    const now = Date.now();
    if (now - swipeWheelTs > 250) swipeAccum = 0; // reset a stale gesture
    swipeWheelTs = now;
    if (now - swipeLast < 550) return;            // cooldown between switches
    swipeAccum += e.deltaX;
    if (swipeAccum > SWIPE_THRESH) { swipeAccum = 0; swipeLast = now; switchSpace(1); }
    else if (swipeAccum < -SWIPE_THRESH) { swipeAccum = 0; swipeLast = now; switchSpace(-1); }
  }, { passive: true });
}

function wireSpaceDrag(pill, space) {
  pill.addEventListener("dragstart", (e) => { dnd = { kind: "space", id: space.id }; pill.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
  pill.addEventListener("dragend", () => { pill.classList.remove("dragging"); $("#spaces").querySelectorAll(".space-pill").forEach((p) => p.classList.remove("drop-before", "drop-after")); dnd = null; });
  pill.addEventListener("dragover", (e) => {
    if (!dnd || dnd.kind !== "space" || dnd.id === space.id) return;
    e.preventDefault();
    const r = pill.getBoundingClientRect(); const after = e.clientX > r.left + r.width / 2;
    pill.classList.toggle("drop-after", after); pill.classList.toggle("drop-before", !after);
  });
  pill.addEventListener("dragleave", () => pill.classList.remove("drop-before", "drop-after"));
  pill.addEventListener("drop", async (e) => {
    if (!dnd || dnd.kind !== "space" || dnd.id === space.id) return;
    e.preventDefault();
    const r = pill.getBoundingClientRect(); const after = e.clientX > r.left + r.width / 2;
    await moveSpaceFolder(dnd.id, space.id, after);
  });
}
async function moveSpaceFolder(srcId, targetId, after) {
  const folders = (await chrome.bookmarks.getChildren(barId)).filter(isFolder);
  const target = folders.find((f) => f.id === targetId);
  const src = folders.find((f) => f.id === srcId);
  if (!target || !src) return;
  let destIndex = target.index + (after ? 1 : 0);
  if (src.index < destIndex) destIndex -= 1;
  await chrome.bookmarks.move(srcId, { parentId: barId, index: destIndex });
}

/* ---------- pins (loose bar bookmarks) ---------- */
async function renderPins() {
  const wrap = $("#pins");
  const pins = await getPins();
  $("#pinCount").textContent = pins.length ? String(pins.length) : "";
  wrap.innerHTML = "";

  pins.forEach((p) => {
    const chip = document.createElement("div");
    chip.className = "pin";
    chip.draggable = true;
    chip.dataset.id = p.id;
    chip.title = `${p.title || ""}\n${p.url}`;
    const img = document.createElement("img");
    img.className = "pin-fav"; img.src = faviconUrl(p.url); img.alt = "";
    const rows = () => [
      { icon: "✎", label: t("menuEdit"), onClick: () => openAnchorModal("edit", p) },
      { sep: true },
      { icon: "×", label: t("deleteLabel"), danger: true, onClick: () => removeAnchorWithUndo(p) },
    ];
    chip.append(img, makeMoreBtn(rows));
    wireContextMenu(chip, rows);
    chip.addEventListener("click", (e) => { if (e.target.closest(".more")) return; openUrl(p.url); });
    wireAnchorDrag(chip, p, barId);
    wrap.appendChild(chip);
  });

  const add = document.createElement("button");
  add.className = "pin-add";
  add.textContent = "+";
  add.title = t("pinCurrentTabTitle");
  add.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) await createAnchor(barId, tab.title, tab.url);
  });
  wrap.appendChild(add);

  if (!pins.length) {
    const hint = document.createElement("span");
    hint.className = "pin-hint";
    hint.textContent = t("pinDragHint");
    wrap.appendChild(hint);
  }
}
function wirePinsDrop(wrap) {
  wrap.addEventListener("dragover", (e) => { if (!dnd) return; e.preventDefault(); wrap.classList.add("drop-into"); });
  wrap.addEventListener("dragleave", (e) => { if (e.target === wrap) wrap.classList.remove("drop-into"); });
  wrap.addEventListener("drop", async (e) => { if (!dnd) return; e.preventDefault(); wrap.classList.remove("drop-into"); await dropOnto(barId, null); });
}

/* ---------- anchored grid + sections ---------- */
async function renderAnchored(spaces) {
  spaces = spaces || (await getSpaces());
  document.querySelector(".app").classList.toggle("dense", meta.density === "compact");
  const wrap = $("#anchoredScroll");
  wrap.innerHTML = "";

  const space = await activeSpace(spaces);
  $("#spaceTitle").textContent = space ? space.name : "";

  if (!space) {
    $("#anchorCount").textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty-hint";
    empty.innerHTML = t("noSpacesHint");
    wrap.appendChild(empty);
    return;
  }

  const { anchors, sections } = await readSpace(space.id);
  const total = anchors.length + sections.reduce((n, s) => n + s.anchors.length, 0);
  $("#anchorCount").textContent = total ? String(total) : "";
  const lit = await currentlyOpenUrls();

  const mainGrid = buildGrid(space.id, anchors, lit);
  appendAddTile(mainGrid, space.id);
  wrap.appendChild(mainGrid);

  sections.forEach((sec) => {
    const collapsed = !!meta.collapsed[sec.folder.id];
    const head = document.createElement("div");
    head.className = "section-head" + (collapsed ? " collapsed" : "");
    head.innerHTML = `<span class="caret">▸</span><span class="section-name"></span><span class="section-count">${sec.anchors.length}</span>`;
    head.querySelector(".section-name").textContent = sec.folder.title || t("untitled");
    head.addEventListener("click", () => { meta.collapsed[sec.folder.id] = !collapsed; saveMeta(); renderAnchored(); });
    wrap.appendChild(head);
    if (!collapsed) wrap.appendChild(buildGrid(sec.folder.id, sec.anchors, lit));
  });
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
    tile.draggable = true; tile.dataset.id = a.id; tile.title = `${a.title || ""}\n${a.url}`;
    const img = document.createElement("img"); img.className = "fav"; img.src = faviconUrl(a.url); img.alt = "";
    const label = document.createElement("span"); label.className = "label"; label.textContent = a.title || hostOf(a.url);
    const dock = document.createElement("span"); dock.className = "dock-dot"; dock.title = t("currentlyOpenTitle");
    const rows = () => [
      { icon: "✎", label: t("menuEdit"), onClick: () => openAnchorModal("edit", a) },
      { icon: "⟲", label: t("resetTabTitle"), onClick: () => resetActiveTo(a.url) },
      { sep: true },
      { icon: "×", label: t("deleteLabel"), danger: true, onClick: () => removeAnchorWithUndo(a) },
    ];
    tile.append(img, label, makeMoreBtn(rows), dock);
    wireContextMenu(tile, rows);
    tile.addEventListener("click", (e) => { if (e.target.closest(".more")) return; openUrl(a.url); });
    wireAnchorDrag(tile, a, parentId);
    grid.appendChild(tile);
  });
  return grid;
}
function appendAddTile(grid, parentId) {
  const add = document.createElement("div");
  add.className = "tile add";
  add.innerHTML = `<span class="plus">+</span><span class="add-label">${t("addCurrentTabLabel")}</span>`;
  add.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) await createAnchor(parentId, tab.title, tab.url);
  });
  grid.appendChild(add);
}

/* ---------- DnD for anchors/pins ---------- */
function wireAnchorDrag(el, node, parentId) {
  el.addEventListener("dragstart", (e) => { dnd = { kind: "anchor", id: node.id, fromParent: parentId }; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    document.querySelectorAll(".tile,.pin").forEach((t) => t.classList.remove("drop-before", "drop-after"));
    document.querySelectorAll(".grid,.pins").forEach((g) => g.classList.remove("drop-into"));
    dnd = null;
  });
  el.addEventListener("dragover", (e) => {
    if (!dnd || (dnd.kind === "anchor" && dnd.id === node.id)) return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect(); const after = e.clientX > r.left + r.width / 2;
    el.classList.toggle("drop-after", after); el.classList.toggle("drop-before", !after);
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after"));
  el.addEventListener("drop", async (e) => {
    if (!dnd) return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect(); const after = e.clientX > r.left + r.width / 2;
    let index = null; // fall back to append if the target bookmark is gone
    try {
      const target = (await chrome.bookmarks.get(node.id))[0];
      if (target) index = target.index + (after ? 1 : 0);
    } catch { /* target removed — append */ }
    await dropOnto(parentId, index);
  });
}
function wireGridDrop(grid, parentId) {
  grid.addEventListener("dragover", (e) => { if (!dnd) return; e.preventDefault(); grid.classList.add("drop-into"); });
  grid.addEventListener("dragleave", (e) => { if (e.target === grid) grid.classList.remove("drop-into"); });
  grid.addEventListener("drop", async (e) => { if (!dnd) return; e.preventDefault(); grid.classList.remove("drop-into"); await dropOnto(parentId, null); });
}
async function dropOnto(parentId, index) {
  // capture + clear synchronously, BEFORE any await, so a single drop can't
  // be processed twice (and stray listeners can't multiply the create)
  const payload = dnd;
  dnd = null;
  if (!payload) return;
  try {
    if (payload.kind === "live") {
      const tab = liveTabs.find((t) => t.id === payload.tabId);
      if (tab && tab.url) await createAnchor(parentId, tab.title, tab.url, index);
    } else if (payload.kind === "anchor") {
      const node = (await chrome.bookmarks.get(payload.id))[0];
      if (!node) return;
      let dest = index;
      if (dest != null && node.parentId === parentId && node.index < dest) dest -= 1;
      await chrome.bookmarks.move(payload.id, dest == null ? { parentId } : { parentId, index: dest });
    }
  } catch (err) { console.warn("Harbor: drop failed", err); }
}

/* ============================================================
   LIVE  — vertical tabs + groups + split-view detection
   ============================================================ */
async function renderLive() {
  const list = $("#liveList");
  liveTabs = await chrome.tabs.query({ currentWindow: true });
  liveTabs.sort((a, b) => a.index - b.index);
  $("#liveCount").textContent = liveTabs.length ? String(liveTabs.length) : "";
  list.innerHTML = "";
  if (!liveTabs.length) { list.innerHTML = `<div class="empty">${t("noOpenTabs")}</div>`; return; }

  // derive window id from the tabs we already have (avoids a null windows.getCurrent())
  const winId = liveTabs[0].windowId;
  let groups = [];
  if (chrome.tabGroups && winId != null) {
    try { groups = await chrome.tabGroups.query({ windowId: winId }); } catch { /* */ }
  }
  const gmap = new Map(groups.map((g) => [g.id, g]));
  const gcount = {};
  liveTabs.forEach((t) => { if (t.groupId != null && t.groupId !== NONE) gcount[t.groupId] = (gcount[t.groupId] || 0) + 1; });
  const splitCount = {};
  liveTabs.forEach((t) => { const s = t.splitViewId; if (s != null && s !== splitNone()) splitCount[s] = (splitCount[s] || 0) + 1; });
  const anchorKeys = await allAnchorKeys();

  const seen = new Set();
  for (const t of liveTabs) {
    const gid = t.groupId;
    const grouped = gid != null && gid !== NONE;
    const g = grouped ? gmap.get(gid) : null;
    if (grouped && !seen.has(gid)) { seen.add(gid); list.appendChild(buildGroupHeader(g, gid, gcount[gid] || 0)); }
    if (g && g.collapsed) continue;
    list.appendChild(buildTabRow(t, !!grouped, g, anchorKeys, splitCount));
  }
  applyLiveFilter();
}

// the top-bar filter dims/hides non-matching LIVE rows too (not just anchors),
// and folds away expanded group headers left with nothing visible.
function tabMatches(tab) {
  if (!filterText) return true;
  return norm(tab.title).includes(filterText) || norm(tab.url).includes(filterText);
}
function applyLiveFilter() {
  const list = $("#liveList");
  if (!list) return;
  const visByGroup = {};
  list.querySelectorAll(".trow").forEach((row) => {
    const tab = liveTabs.find((t) => t.id === Number(row.dataset.tabId));
    const match = tab ? tabMatches(tab) : true;
    row.classList.toggle("dim", !match);
    if (match && tab && tab.groupId != null && tab.groupId !== NONE) visByGroup[tab.groupId] = (visByGroup[tab.groupId] || 0) + 1;
  });
  list.querySelectorAll(".group-head").forEach((h) => {
    const gid = Number(h.dataset.gid);
    const empty = filterText && !h.classList.contains("collapsed") && !visByGroup[gid];
    h.classList.toggle("dim", !!empty);
  });
}

function buildGroupHeader(g, gid, count) {
  const color = g && g.color ? (GROUP_COLORS[g.color] || "#9aa0a6") : "#9aa0a6";
  const collapsed = g ? g.collapsed : false;
  const head = document.createElement("div");
  head.className = "group-head" + (collapsed ? " collapsed" : "");
  head.style.setProperty("--g-color", color);
  head.dataset.gid = String(gid);

  const caret = document.createElement("span"); caret.className = "g-caret"; caret.textContent = "▾";
  const dot = document.createElement("button"); dot.className = "g-dot"; dot.title = t("groupColorTitle");
  const name = document.createElement("span"); name.className = "g-name"; name.textContent = (g && g.title) || t("groupDefaultName");
  name.title = t("groupRenameHint");
  const cnt = document.createElement("span"); cnt.className = "g-count"; cnt.textContent = String(count);

  const renameGroup = async () => {
    const next = await promptDialog(t("groupNamePrompt"), (g && g.title) || "");
    if (next != null && chrome.tabGroups) await chrome.tabGroups.update(gid, { title: next });
  };
  const ungroupGroup = async () => {
    const ids = liveTabs.filter((t) => t.groupId === gid).map((t) => t.id);
    if (ids.length) await chrome.tabs.ungroup(ids);
  };
  const rows = () => [
    { icon: "✎", label: t("menuRename"), onClick: renameGroup },
    { icon: "●", label: t("menuChangeColor"), onClick: () => openGroupColorPop(gid, dot) },
    { sep: true },
    { icon: "⤴", label: t("ungroupTitle"), danger: true, onClick: ungroupGroup },
  ];
  const more = makeMoreBtn(rows);
  head.append(caret, dot, name, cnt, more);
  wireContextMenu(head, rows);

  head.addEventListener("click", async (e) => {
    if (e.target === dot || e.target === name || e.target.closest(".more")) return;
    if (chrome.tabGroups && g) await chrome.tabGroups.update(gid, { collapsed: !collapsed });
  });
  dot.addEventListener("click", (e) => { e.stopPropagation(); openGroupColorPop(gid, dot); });
  name.addEventListener("dblclick", (e) => { e.stopPropagation(); renameGroup(); });

  // accept a tab dropped onto the header → join this group
  head.addEventListener("dragover", (e) => { if (dnd && dnd.kind === "live") { e.preventDefault(); head.classList.add("drop-join"); } });
  head.addEventListener("dragleave", () => head.classList.remove("drop-join"));
  head.addEventListener("drop", async (e) => {
    if (!dnd || dnd.kind !== "live") return;
    e.preventDefault(); head.classList.remove("drop-join");
    const tabId = dnd.tabId; dnd = null;
    await chrome.tabs.group({ groupId: gid, tabIds: [tabId] });
  });
  return head;
}

function buildTabRow(tab, grouped, g, anchorKeys, splitCount) {
  const docked = tab.url && anchorKeys.has(litKey(tab.url));
  const inSplit = tab.splitViewId != null && tab.splitViewId !== splitNone() && (splitCount[tab.splitViewId] || 0) >= 2;
  const row = document.createElement("div");
  row.className = "trow" + (tab.active ? " active" : "") + (docked ? " docked" : "") + (grouped ? " grouped" : "");
  row.draggable = true; row.dataset.tabId = String(tab.id);
  if (grouped && g) row.style.setProperty("--g-color", GROUP_COLORS[g.color] || "#9aa0a6");

  const img = document.createElement("img"); img.className = "fav"; img.src = tab.favIconUrl || faviconUrl(tab.url || ""); img.alt = "";
  img.addEventListener("error", () => { img.src = faviconUrl(tab.url || ""); }, { once: true });
  const title = document.createElement("span"); title.className = "ttitle"; title.textContent = tab.title || hostOf(tab.url || ""); title.title = tab.url || "";

  const split = document.createElement("span"); split.className = "split-badge"; split.textContent = "⊟";
  split.title = t("splitViewTitle"); if (!inSplit) split.style.display = "none";
  const moored = document.createElement("span"); moored.className = "moored"; moored.textContent = "⚓"; moored.title = t("mooredTitle");

  const grp = document.createElement("button"); grp.className = "act grp";
  grp.textContent = grouped ? "⤴" : "⊕"; grp.title = grouped ? t("removeFromGroupTitle") : t("createGroupTitle");
  grp.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (grouped) await chrome.tabs.ungroup([tab.id]);
    else await chrome.tabs.group({ tabIds: [tab.id] });
  });
  const pin = document.createElement("button"); pin.className = "act pin"; pin.textContent = "⚓"; pin.title = t("anchorAddToSpaceTitle");
  pin.addEventListener("click", async (e) => {
    e.stopPropagation();
    const space = await activeSpace();
    const parent = space ? space.id : barId;
    if (tab.url) await createAnchor(parent, tab.title, tab.url);
  });
  const close = document.createElement("button"); close.className = "act close"; close.textContent = "×"; close.title = t("tabCloseTitle");
  close.addEventListener("click", (e) => { e.stopPropagation(); chrome.tabs.remove(tab.id); });

  row.append(img, title, split, moored, grp, pin, close);
  row.addEventListener("click", () => chrome.tabs.update(tab.id, { active: true }));
  row.addEventListener("dragstart", (e) => { dnd = { kind: "live", tabId: tab.id }; row.classList.add("dragging"); e.dataTransfer.effectAllowed = "copyMove"; });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    document.querySelectorAll(".grid,.pins").forEach((g2) => g2.classList.remove("drop-into"));
    document.querySelectorAll(".group-head").forEach((h) => h.classList.remove("drop-join"));
    dnd = null;
  });
  return row;
}

/* ---------- group color popover ---------- */
function openGroupColorPop(gid, anchorEl) {
  const pop = $("#groupPop");
  pop.innerHTML = "";
  GROUP_COLOR_NAMES.forEach((nm) => {
    const b = document.createElement("button");
    b.className = "gc-swatch"; b.style.background = GROUP_COLORS[nm]; b.title = nm;
    b.addEventListener("click", async () => { pop.classList.add("hidden"); if (chrome.tabGroups) await chrome.tabGroups.update(gid, { color: nm }); });
    pop.appendChild(b);
  });
  const r = anchorEl.getBoundingClientRect();
  pop.style.left = Math.min(r.left, window.innerWidth - 150) + "px";
  pop.style.top = (r.bottom + 6) + "px";
  pop.classList.remove("hidden");
}

/* ============================================================
   MODALS
   ============================================================ */
async function openAnchorModal(mode, node) {
  modalCtx = { mode, id: node ? node.id : null };
  $("#modalTitle").textContent = mode === "add" ? t("anchorAddModalTitle") : t("anchorEditModalTitle");
  $("#fTitle").value = node ? (node.title || "") : "";
  $("#fUrl").value = node ? (node.url || "") : "";
  const sel = $("#fSpace"); sel.innerHTML = "";
  const spaces = await getSpaces();
  const space = await activeSpace(spaces);
  const cur = node ? node.parentId : (space ? space.id : barId);
  // allow PINS (bar root) as a destination too
  const opts = [{ id: barId, name: t("pinsOption") }, ...spaces];
  opts.forEach((s) => {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = s.name;
    if (s.id === cur) o.selected = true;
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
  } else { await createAnchor(parentId, title, url); }
  closeAnchorModal();
}

async function openSpaceModal(mode, space, idx) {
  spaceCtx = { mode, id: space ? space.id : null, color: space ? colorFor(space.id, idx) : SWATCHES[0] };
  $("#spaceModalTitle").textContent = mode === "add" ? t("spaceAddModalTitle") : t("spaceEditModalTitle");
  $("#sName").value = space ? space.name : "";
  const sw = $("#sSwatches"); sw.innerHTML = "";
  SWATCHES.forEach((c) => {
    const b = document.createElement("button");
    b.className = "swatch" + (c === spaceCtx.color ? " sel" : "");
    b.style.background = c;
    b.addEventListener("click", () => { spaceCtx.color = c; sw.querySelectorAll(".swatch").forEach((x) => x.classList.remove("sel")); b.classList.add("sel"); });
    sw.appendChild(b);
  });
  $("#sDelete").style.display = mode === "edit" ? "" : "none";
  $("#spaceOverlay").classList.remove("hidden");
  $("#sName").focus();
}
function closeSpaceModal() { $("#spaceOverlay").classList.add("hidden"); spaceCtx = null; }
async function saveSpaceModal() {
  if (!spaceCtx) return;
  const name = $("#sName").value.trim() || t("spaceDefaultName");
  if (spaceCtx.mode === "edit") {
    await chrome.bookmarks.update(spaceCtx.id, { title: name });
    meta.spaceColor[spaceCtx.id] = spaceCtx.color;
  } else {
    const f = await chrome.bookmarks.create({ parentId: barId, title: name });
    meta.spaceColor[f.id] = spaceCtx.color;
    meta.activeSpaceId = f.id;
  }
  await saveMeta();
  closeSpaceModal();
  await renderAll(); // color lives in meta, not bookmarks — render explicitly
}
async function deleteSpaceById(id) {
  const node = (await chrome.bookmarks.getSubTree(id))[0];
  if (!node) return;
  const count = (node.children || []).filter(isAnchor).length;
  if (!(await confirmDialog(t("deleteSpaceConfirm", [node.title || "", String(count)]), { okLabel: t("deleteLabel") }))) return;
  await chrome.bookmarks.removeTree(id);
  delete meta.spaceColor[id];
  if (meta.activeSpaceId === id) meta.activeSpaceId = null;
  await saveMeta();
  await renderAll(); // color lives in meta, not bookmarks — render explicitly
}
async function deleteSpace() {
  if (!spaceCtx || !spaceCtx.id) return;
  const id = spaceCtx.id;
  closeSpaceModal();
  await deleteSpaceById(id);
}

/* ============================================================
   FIRST-RUN GUIDED TOUR  (coachmarks over the live UI)
   ============================================================ */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
function getTour() {
  return [
    { key: t("tour0Key"), title: t("tour0Title"), body: t("tour0Body"), center: true },
    { sel: "#spaces",          key: t("tour1Key"), title: t("tour1Title"), body: t("tour1Body") },
    { sel: "#pinsBlock",       key: t("tour2Key"), title: t("tour2Title"), body: t("tour2Body") },
    { sel: ".block-anchored",  key: t("tour3Key"), title: t("tour3Title"), body: t("tour3Body") },
    { sel: ".block-live",      key: t("tour4Key"), title: t("tour4Title"), body: t("tour4Body") },
    { key: t("tour5Key"), title: t("tour5Title"), body: t("tour5Body", [IS_MAC ? "⌘" : "Ctrl"]), center: true },
  ];
}
let tourIdx = -1;
function renderTourDots() {
  const dots = $("#tourDots");
  dots.innerHTML = "";
  getTour().forEach((_, i) => { const d = document.createElement("i"); if (i === tourIdx) d.classList.add("on"); dots.appendChild(d); });
}
function positionTour() {
  const tour_data = getTour();
  const step = tour_data[tourIdx];
  const tour = $("#tour"), spot = $("#tourSpot"), card = $("#tourCard");
  const el = step.sel ? document.querySelector(step.sel) : null;
  if (step.center || !el) { tour.classList.add("center"); card.style.left = card.style.top = ""; return; }
  tour.classList.remove("center");
  const r = el.getBoundingClientRect();
  const pad = 6;
  const sx = Math.max(4, r.left - pad), sy = Math.max(4, r.top - pad);
  const sw = Math.min(window.innerWidth - 8 - sx, r.width + pad * 2);
  const sh = r.height + pad * 2;
  spot.style.left = sx + "px"; spot.style.top = sy + "px";
  spot.style.width = sw + "px"; spot.style.height = sh + "px";
  const cw = card.offsetWidth, ch = card.offsetHeight, gap = 12;
  let top = sy + sh + gap;
  if (top + ch > window.innerHeight - 8) top = Math.max(8, sy - ch - gap); // flip above when no room below
  let left = sx + sw / 2 - cw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - cw - 8));
  card.style.left = left + "px"; card.style.top = top + "px";
}
function showTourStep(i) {
  const tour_data = getTour();
  tourIdx = Math.max(0, Math.min(tour_data.length - 1, i));
  const step = tour_data[tourIdx];
  $("#tourKey").textContent = step.key || "";
  $("#tourTitle").textContent = step.title || "";
  $("#tourBody").innerHTML = step.body || "";
  const isLast = tourIdx === tour_data.length - 1;
  $("#tourBack").classList.toggle("hidden", tourIdx === 0);
  // on the final step "Skip" duplicates "Get started" — drop it to free room for the wider label
  $("#tourSkip").classList.toggle("hidden", isLast);
  $("#tourNext").textContent = isLast ? t("tourStartLabel") : t("tourNextLabel");
  renderTourDots();
  positionTour();
}
function startTour() {
  $("#tour").classList.remove("hidden");
  showTourStep(0);
}
function endTour() {
  $("#tour").classList.add("hidden");
  tourIdx = -1;
  if (meta && !meta.tourSeen) { meta.tourSeen = true; saveMeta(); }
}
function tourNext() { if (tourIdx >= getTour().length - 1) endTour(); else showTourStep(tourIdx + 1); }
function tourPrev() { if (tourIdx > 0) showTourStep(tourIdx - 1); }
function tourActive() { return !$("#tour").classList.contains("hidden"); }
function wireTour() {
  $("#helpToggle").addEventListener("click", startTour);
  $("#tourNext").addEventListener("click", tourNext);
  $("#tourBack").addEventListener("click", tourPrev);
  $("#tourSkip").addEventListener("click", endTour);
  window.addEventListener("resize", () => { if (tourActive()) positionTour(); });
}

/* ============================================================
   WIRING / BOOT
   ============================================================ */
let renderTimer = null;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(renderAll, 100); }

function wireStaticUi() {
  $("#densityToggle").addEventListener("click", () => { meta.density = meta.density === "compact" ? "cozy" : "compact"; saveMeta(); renderAnchored(); });
  $("#filter").addEventListener("input", (e) => { filterText = norm(e.target.value); renderAnchored(); applyLiveFilter(); });
  $("#spaceOpenAll").addEventListener("click", openAllInActiveSpace);
  $("#tidyBtn").addEventListener("click", tidyLiveTabs);

  $("#mCancel").addEventListener("click", closeAnchorModal);
  $("#mSave").addEventListener("click", saveAnchorModal);
  $("#mDelete").addEventListener("click", async () => {
    if (modalCtx && modalCtx.id) { const node = (await chrome.bookmarks.get(modalCtx.id))[0]; closeAnchorModal(); await removeAnchorWithUndo(node); }
  });
  $("#sCancel").addEventListener("click", closeSpaceModal);
  $("#sSave").addEventListener("click", saveSpaceModal);
  $("#sDelete").addEventListener("click", deleteSpace);
  $("#snackUndo").addEventListener("click", runUndo);

  $("#dlgOk").addEventListener("click", submitDialog);
  $("#dlgCancel").addEventListener("click", () => closeDialog(null));
  $("#dialogOverlay").addEventListener("click", (e) => { if (e.target.id === "dialogOverlay") closeDialog(null); });

  $("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeAnchorModal(); });
  $("#spaceOverlay").addEventListener("click", (e) => { if (e.target.id === "spaceOverlay") closeSpaceModal(); });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#groupPop") && !e.target.classList.contains("g-dot")) $("#groupPop").classList.add("hidden");
    if (!e.target.closest("#itemMenu") && !e.target.closest(".more")) closeItemMenu();
  });
  // floating layers shouldn't linger when the surface beneath them moves
  document.addEventListener("scroll", () => { closeItemMenu(); $("#groupPop").classList.add("hidden"); }, true);
  window.addEventListener("resize", () => { closeItemMenu(); $("#groupPop").classList.add("hidden"); });

  document.addEventListener("keydown", async (e) => {
    if (tourActive()) {
      if (e.key === "Escape") endTour();
      else if (e.key === "ArrowRight" || e.key === "Enter") tourNext();
      else if (e.key === "ArrowLeft") tourPrev();
      return;
    }
    if (e.key === "Escape") {
      if (itemMenuOpen()) { closeItemMenu(); return; }
      if (dialogResolve) { closeDialog(null); return; }
      closeAnchorModal(); closeSpaceModal(); hideUndo(); $("#groupPop").classList.add("hidden"); return;
    }
    if (e.key === "Enter") {
      if (dialogResolve) { submitDialog(); return; }
      if (!$("#overlay").classList.contains("hidden")) { saveAnchorModal(); return; }
      if (!$("#spaceOverlay").classList.contains("hidden")) { saveSpaceModal(); return; }
    }
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
    if (!typing && /^[1-9]$/.test(e.key)) {
      const spaces = await getSpaces();
      const target = spaces[Number(e.key) - 1];
      if (target) { meta.activeSpaceId = target.id; saveMeta(); renderAll(); }
    }
  });

  ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered", "onImportEnded"]
    .forEach((ev) => { if (chrome.bookmarks[ev]) chrome.bookmarks[ev].addListener(scheduleRender); });
  ["onCreated", "onRemoved", "onUpdated", "onActivated", "onMoved", "onAttached", "onDetached"]
    .forEach((ev) => { if (chrome.tabs[ev]) chrome.tabs[ev].addListener(scheduleRender); });
  if (chrome.tabGroups) ["onCreated", "onUpdated", "onRemoved", "onMoved"]
    .forEach((ev) => { if (chrome.tabGroups[ev]) chrome.tabGroups[ev].addListener(scheduleRender); });

  wireSpaceSwipe();
  wireTour();
  wirePinsDrop($("#pins")); // wire the persistent PINS container ONCE (not per render)
}

(async function init() {
  localizeHtml();
  wireStaticUi();
  await loadMeta();
  barId = await resolveBarId();
  await renderAll();
  if (!meta.tourSeen) startTour(); // first run: orient the navigator before they set sail
})();
