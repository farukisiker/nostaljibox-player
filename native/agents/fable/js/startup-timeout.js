// SPDX-License-Identifier: GPL-3.0-or-later
// Startup timeout for the native backend only (NETPLAY.md §7 "Başlangıç zaman aşımı"). The caller
// arms it when a transfer has resolved (`expect("booted")` after `await io.sendBytes(rom)`, …) and
// clears it when the awaited message arrives. On the EJS backend `enabled` is false and every call
// is a no-op: EJS pairs may transfer hundreds of MB and old guests say nothing meanwhile.
// pause()/resume() (NETPLAY.md §13.3, two-phone link-start ad): the guest stops waiting for the
// host's state while the ad gate is open and waits the full time again once it closes.
export const STARTUP_TIMEOUT_MS = 30000;

export function startupTimeout(enabled, onTimeout, { ms = STARTUP_TIMEOUT_MS, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = {}) {
  let timer = null;
  let waitingFor = null;
  let paused = null; // what was awaited when pause() stopped the timer
  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    waitingFor = null;
  };
  const clear = () => {
    stop();
    paused = null;
  };
  const expect = (name) => {
    if (!enabled) return;
    clear();
    waitingFor = name;
    timer = setTimeout(() => {
      timer = null;
      waitingFor = null;
      onTimeout(name);
    }, ms);
  };
  return {
    enabled: !!enabled,
    get pending() {
      return waitingFor;
    },
    get paused() {
      return paused;
    },
    expect,
    got(name) {
      if (waitingFor === name) clear();
      if (paused === name) paused = null; // it came during the pause: nothing to wait for on resume
    },
    // Stops the timer but remembers what was awaited; a second pause keeps the first one's name.
    pause() {
      if (!enabled) return;
      const name = waitingFor || paused;
      stop();
      paused = name;
    },
    // Waits again for what pause() stopped, the full time from now. Nothing paused: no-op.
    resume() {
      if (!enabled || !paused) return;
      expect(paused);
    },
    clear,
  };
}
