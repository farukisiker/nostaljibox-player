// SPDX-License-Identifier: GPL-3.0-or-later
// Startup timeout for the native backend only (NETPLAY.md §7 "Başlangıç zaman aşımı"). The caller
// arms it when a transfer has resolved (`expect("booted")` after `await io.sendBytes(rom)`, …) and
// clears it when the awaited message arrives. On the EJS backend `enabled` is false and every call
// is a no-op: EJS pairs may transfer hundreds of MB and old guests say nothing meanwhile.
export const STARTUP_TIMEOUT_MS = 30000;

export function startupTimeout(enabled, onTimeout, { ms = STARTUP_TIMEOUT_MS, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = {}) {
  let timer = null;
  let waitingFor = null;
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    waitingFor = null;
  };
  return {
    enabled: !!enabled,
    get pending() {
      return waitingFor;
    },
    expect(name) {
      if (!enabled) return;
      clear();
      waitingFor = name;
      timer = setTimeout(() => {
        timer = null;
        waitingFor = null;
        onTimeout(name);
      }, ms);
    },
    got(name) {
      if (waitingFor === name) clear();
    },
    clear,
  };
}
