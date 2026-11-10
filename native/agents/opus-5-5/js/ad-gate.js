// SPDX-License-Identifier: GPL-3.0-or-later
// Two-phone link-start ad gate (NETPLAY.md §13.3, ADS_SPEC §3.4). Both phones are loaded and
// frozen (`hold`) between the guest's `booted` and the host's `state`; each shows its own
// "link-start" ad there, and the game starts once both are closed. No ad code here: the caller
// passes the player's adHook.gate (src/ad-hook.js, aliased to the app's real hook in the app build),
// which always resolves { shown, reason } and never throws.
//
// Messages (channelIO JSON):
//   host → guest  { t: "adgate", id }                 sent by host-link.js, then both open a gate
//   both ways     { t: "addone", id, shown, reason }  when that phone's own gate("link-start") resolved
// `onDone` runs once, when this phone's own ad is closed AND (the other phone's `addone` came, or
// LINK_AD_GATE_MAX_MS passed without it). The cap is only for the other phone's missing `addone`:
// while this phone's own ad is still on screen the gate stays open, however long that takes, so a
// game never starts under it (the user may be in the store or a browser page the ad opened).
// `onSettled` runs once, when both ads are known to be closed (own ad closed and the other phone's
// `addone` in): with `onDone` in the usual case, later when `onDone` came by the cap. A phone in its
// cooldown gets { shown: false } at once, sends `addone` right away and still waits for the other one.
export const LINK_AD_GATE_MAX_MS = 75000;
// The heartbeat's silence limit while a gate is open (heartbeat.js setGateLimit, both backends): an
// ad must not read as a lost link. Cleared once both ads are closed (onSettled).
export const LINK_AD_GATE_HB_MS = LINK_AD_GATE_MAX_MS + 10000;

const result = (r) => ({ shown: !!(r && r.shown), reason: r && r.reason != null ? String(r.reason) : null });

// Raises (open = true) or clears the channel's gate heartbeat limit. No-op without a channel.
export function gateHeartbeat(io, open) {
  const hb = io && io.heartbeat;
  if (hb && hb.setGateLimit) hb.setGateLimit(open ? LINK_AD_GATE_HB_MS : null);
}

export function adGate({
  send,
  gate,
  onDone,
  onSettled = () => {},
  maxMs = LINK_AD_GATE_MAX_MS,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  let id = null;
  let mine = null; // this phone's gate result, once resolved
  let theirs = null; // the other phone's addone, once it came
  let early = null; // an addone that came before open() (not expected: messages are ordered)
  let timer = null;
  let capped = false; // the cap passed without the other phone's addone
  let finished = false; // onDone ran
  let settled = false; // onSettled ran
  let cancelled = false;
  let ownDone = false; // this phone's gate("link-start") call has settled
  let ownAd = Promise.resolve();

  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const check = () => {
    if (cancelled || !mine) return; // nothing goes on while this phone's own ad is open
    if (!finished && (theirs || capped)) {
      finished = true;
      stopTimer();
      onDone({ mine, theirs, timedOut: !theirs });
    }
    if (!settled && !cancelled && theirs) {
      settled = true;
      onSettled({ mine, theirs });
    }
  };

  return {
    // Starts this phone's ad for gate `n` and the cap for the other phone's addone. Once per gate.
    open(n) {
      if (id !== null || cancelled) return;
      id = n;
      if (early && early.id === n) theirs = early.result;
      early = null;
      if (!theirs) {
        timer = setTimeout(() => {
          timer = null;
          capped = true;
          check();
        }, maxMs);
      }
      let call;
      try {
        call = Promise.resolve(gate("link-start"));
      } catch (e) {
        call = Promise.reject(e);
      }
      ownAd = call.then(result, () => ({ shown: false, reason: "error" })); // never rejects
      ownAd.then((r) => {
        ownDone = true;
        if (cancelled) return; // the link ended: nobody to tell
        mine = r;
        // Also after the cap: the other phone waits for it.
        send({ t: "addone", id, shown: r.shown, reason: r.reason });
        check();
      });
    },
    // The other phone's addone (`msg` is that message, for its shown/reason). Another id: ignored.
    // One that comes after a capped onDone still counts (onSettled).
    peerDone(n, msg) {
      if (cancelled || theirs) return;
      if (id === null) {
        early = { id: n, result: result(msg) };
        return;
      }
      if (n !== id) return;
      theirs = result(msg);
      stopTimer(); // the cap is only for this addone
      check();
    },
    // The link ended: no onDone, no onSettled, no addone, no timer. The app's own ad finishes on its own.
    cancel() {
      cancelled = true;
      stopTimer();
    },
    get id() {
      return id;
    },
    // Opened, not yet done and not cancelled: a state that comes now waits for onDone.
    get active() {
      return id !== null && !finished && !cancelled;
    },
    get done() {
      return finished;
    },
    // Both ads are closed (onSettled ran).
    get settled() {
      return settled;
    },
    // This phone's own ad is closed, or there never was one (also after cancel, once it closed).
    get ownDone() {
      return id === null || ownDone;
    },
    // Resolves (never rejects) with this phone's own result once its gate("link-start") call has
    // settled; at once when it never opened.
    get ownAd() {
      return ownAd;
    },
  };
}
