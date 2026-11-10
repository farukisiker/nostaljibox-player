// SPDX-License-Identifier: GPL-3.0-or-later
// In-session play time for the single-player pause ad (NETPLAY.md §13.2). In memory only, 0 on
// page load. It counts only while the page is visible; the 12-minute threshold is the app's, the
// player just passes `playMs` along. Pure: `now` and `doc` are injected.
export function playClock({ now = () => Date.now(), doc = globalThis.document } = {}) {
  let total = 0;
  let since = null; // when the current counting stretch began
  let started = false;
  const visible = () => !doc || doc.visibilityState === "visible";
  const stop = () => {
    if (since !== null) total += Math.max(0, now() - since);
    since = null;
  };
  const resume = () => {
    if (started && since === null && visible()) since = now();
  };
  doc?.addEventListener?.("visibilitychange", () => (visible() ? resume() : stop()));
  return {
    start() {
      if (started) return;
      started = true;
      resume();
    },
    ms() {
      return total + (since !== null ? Math.max(0, now() - since) : 0);
    },
    reset() {
      total = 0;
      since = started && visible() ? now() : null;
    },
  };
}
