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
