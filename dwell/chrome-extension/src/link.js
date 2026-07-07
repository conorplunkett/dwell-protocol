// Dwell Protocol — account link bridge. Runs only on dwellprotocol.com. When the user is
// signed in to the website, their session token sits in localStorage; hand it to
// the background so it can link THIS device to the account — no magic link, no
// extra clicks in the extension. Polls briefly (and on focus) so signing in
// within the same tab links right away. Content scripts share the page origin's
// localStorage, so this reads the same value the site itself uses.
(function () {
  const KEY = "dwell_session";
  let last = null;

  function tick() {
    let session = null;
    try { session = localStorage.getItem(KEY); } catch (_) { /* storage blocked */ }
    if (!session || session === last) return;
    last = session;
    try {
      chrome.runtime.sendMessage({ type: "BB_LINK", session }, () => void chrome.runtime.lastError);
    } catch (_) { /* extension context gone */ }
  }

  tick();
  setInterval(tick, 3000);
  window.addEventListener("focus", tick);
})();
