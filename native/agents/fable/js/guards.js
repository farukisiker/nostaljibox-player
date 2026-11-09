// SPDX-License-Identifier: GPL-3.0-or-later
// Small re-entrancy guards for the link pages (review N0-e item 5).

// Runs fn the first time only: onLost, onclose and ICE "failed" may all fire for one lost link.
export function once(fn) {
  let done = false;
  const wrapped = (...args) => {
    if (done) return undefined;
    done = true;
    return fn(...args);
  };
  Object.defineProperty(wrapped, "done", { get: () => done });
  return wrapped;
}

// A latch set before the first await of an async handler, so a second QR scan or pasted link
// cannot start a second connection while the first is still being decoded.
export function latch() {
  let held = false;
  return {
    get held() {
      return held;
    },
    // true when this caller got the latch; false when someone else holds it.
    take() {
      if (held) return false;
      held = true;
      return true;
    },
    release() {
      held = false;
    },
  };
}
