/*
 * Harbor — side panel workspace, anchored to your bookmarks bar.
 * Copyright (C) 2026 nemototea
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Free software under the GNU GPL v3 or later; distributed WITHOUT ANY
 * WARRANTY. See the LICENSE file in the project root for the full text.
 */

// Harbor service worker
// Toolbar icon (and the Ctrl/Cmd+Shift+K shortcut, which maps to _execute_action)
// open/close the side panel for the current window.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn("Harbor: setPanelBehavior failed", e));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});
