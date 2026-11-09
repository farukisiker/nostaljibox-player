// SPDX-License-Identifier: GPL-3.0-or-later
// Data-channel heartbeat (NETPLAY.md §7.1). iOS WebKit does not fire `channel.onclose` when the
// other phone's process dies, so each side sends `{ t: "hb" }` every second and watches for silence.
// Two-tier limit, so old peers and EJS–EJS pairs keep today's behaviour:
//   - a peer that never sent `hb` (old app) has no silence limit at all (only onclose / ICE failed);
//   - after the peer's first `hb` but before `arm()` (the game has not started yet): 30 s on the
//     native backend, none on EJS (a PS1/N64 image transfer or boot can take minutes);
//   - after `arm()` and the first `hb`: 5 s on the native backend; 30 s on EJS (an EJS page in the
//     background or a slow Android process used to wait indefinitely; §10.4 is still open, so the
//     short limit applies to native pairs only).
// A tick that comes > 2 s late means this JS was suspended (background); the silence is forgiven once.
export const HB_INTERVAL_MS = 1000;
export const HB_ARMED_LIMIT_MS = 5000;
export const HB_ARMED_EJS_MS = 30000;
export const HB_PREARM_NATIVE_MS = 30000;
export const HB_OWN_SLEEP_MS = 2000;

export function createHeartbeat({
  send,
  onLost,
  native = false,
  now = () => Date.now(),
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
}) {
  let lastSeen = now();
  let lastTick = lastSeen;
  let peerBeats = false;
  let armed = false;
  let lost = false;
  let timer = null;

  const limit = () => {
    if (!peerBeats) return Infinity;
    if (armed) return native ? HB_ARMED_LIMIT_MS : HB_ARMED_EJS_MS;
    return native ? HB_PREARM_NATIVE_MS : Infinity;
  };
  const close = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const tick = () => {
    const t = now();
    const slept = t - lastTick > HB_OWN_SLEEP_MS;
    lastTick = t;
    send();
    if (slept) {
      lastSeen = t; // our own clock stopped: give the other phone one round before judging it
      return;
    }
    if (!lost && t - lastSeen > limit()) {
      lost = true;
      close();
      onLost();
    }
  };
  timer = setInterval(tick, HB_INTERVAL_MS);

  return {
    // Every incoming message (JSON or binary chunk) counts as a sign of life; `hb` ones also mark
    // the peer as a new one.
    seen(isHeartbeat = false) {
      lastSeen = now();
      if (isHeartbeat) peerBeats = true;
    },
    arm() {
      armed = true;
    },
    close,
    get active() {
      return timer !== null;
    },
    get armed() {
      return armed;
    },
    get peerBeats() {
      return peerBeats;
    },
    get limitMs() {
      return limit();
    },
  };
}
