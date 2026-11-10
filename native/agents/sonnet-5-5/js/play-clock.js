// SPDX-License-Identifier: GPL-3.0-or-later
// In-session play time for the single-player pause ad (NETPLAY.md §13.2). In memory only, 0 on
// page load. It counts only while the page is visible and the game runs (pause() / resume(): a menu
// that pauses the game, or any other pause, does not count as play); the 12-minute threshold is the
// app's, the player just passes `playMs` along. Pure: `now` and `doc` are injected.
export function playClock({ now = () => Date.now(), doc = globalThis.document } = {}) {
  let total = 0;
  let since = null; // when the current counting stretch began
  let started = false;
  let paused = false; // the game is paused (menu, interruption…)
  const visible = () => !doc || doc.visibilityState === "visible";
  const counting = () => started && !paused && visible();
  const stop = () => {
    if (since !== null) total += Math.max(0, now() - since);
    since = null;
  };
  const go = () => {
    if (since === null && counting()) since = now();
  };
  doc?.addEventListener?.("visibilitychange", () => (visible() ? go() : stop()));
  return {
    start() {
      if (started) return;
      started = true;
      go();
    },
    // The game stopped running / runs again.
    pause() {
      paused = true;
      stop();
    },
    resume() {
      paused = false;
      go();
    },
    ms() {
      return total + (since !== null ? Math.max(0, now() - since) : 0);
    },
    reset() {
      total = 0;
      since = counting() ? now() : null;
    },
  };
}

// Keeps the clock in step with the native session: its `state` events (API.md §3, "running" or
// "paused" with reasons; native-menu.js pauses through plugin.pause()). Never throws.
export function followNativeState(clock, plugin) {
  try {
    plugin?.addListener?.("state", (p) => (p && p.state === "running" ? clock.resume() : clock.pause()));
  } catch {
    // no events: the clock counts by visibility alone
  }
}

// Keeps the clock in step with EmulatorJS: its pause() and play() (the menu bar's ❚❚/▶ buttons and
// play.js's menu pause) all go through emu.togglePlaying, after which emu.paused says which.
export function followEjsPlaying(clock, emu) {
  const toggle = emu && emu.togglePlaying;
  if (typeof toggle !== "function") return;
  emu.togglePlaying = function (...args) {
    const r = toggle.apply(this, args);
    if (emu.paused) clock.pause();
    else clock.resume();
    return r;
  };
}
