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
// The gate is done when this phone's own ad is done AND the other phone's `addone` came, or at
// LINK_AD_GATE_MAX_MS, whichever is first; `onDone` runs once. A phone in its cooldown gets
// { shown: false } at once, sends `addone` right away and still waits for the other one.
import { HB_PREARM_NATIVE_MS } from "../../fable/js/heartbeat.js";

export const LINK_AD_GATE_MAX_MS = 75000;
// The native pre-arm heartbeat limit while a gate is open (heartbeat.js setPreArmLimit): an ad must
// not read as a lost link. Back to HB_PREARM_NATIVE_MS (30 s) when the gate is done.
export const LINK_AD_GATE_HB_MS = LINK_AD_GATE_MAX_MS + 10000;

const result = (r) => ({ shown: !!(r && r.shown), reason: r && r.reason != null ? String(r.reason) : null });

// Raises (open = true) or restores the channel's pre-arm heartbeat limit. No-op without a channel.
export function gateHeartbeat(io, open) {
  const hb = io && io.heartbeat;
  if (hb && hb.setPreArmLimit) hb.setPreArmLimit(open ? LINK_AD_GATE_HB_MS : HB_PREARM_NATIVE_MS);
}

export function adGate({
  send,
  gate,
  onDone,
  maxMs = LINK_AD_GATE_MAX_MS,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  let id = null;
  let mine = null; // this phone's gate result, once resolved
  let theirs = null; // the other phone's addone, once it came
  let early = null; // an addone that came before open() (not expected: messages are ordered)
  let timer = null;
  let finished = false;
  let cancelled = false;
  let ownAd = Promise.resolve();

  const finish = (timedOut) => {
    if (finished || cancelled) return;
    finished = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    onDone({ mine, theirs, timedOut });
  };
  const check = () => {
    if (mine && theirs) finish(false);
  };

  return {
    // Starts this phone's ad for gate `n` and the time cap. Once per gate object.
    open(n) {
      if (id !== null || cancelled) return;
      id = n;
      if (early && early.id === n) theirs = early.result;
      early = null;
      timer = setTimeout(() => {
        timer = null;
        finish(true);
      }, maxMs);
      let call;
      try {
        call = Promise.resolve(gate("link-start"));
      } catch (e) {
        call = Promise.reject(e);
      }
      ownAd = call.then(result, () => ({ shown: false, reason: "error" })); // never rejects
      ownAd.then((r) => {
        if (cancelled) return; // the link ended: nobody to tell
        mine = r;
        // Also after the time cap: the other phone may still be waiting for it.
        send({ t: "addone", id, shown: r.shown, reason: r.reason });
        check();
      });
    },
    // The other phone's addone (`msg` is that message, for its shown/reason). Another id: ignored.
    peerDone(n, msg) {
      if (finished || cancelled) return;
      if (id === null) {
        early = { id: n, result: result(msg) };
        return;
      }
      if (n !== id) return;
      theirs = result(msg);
      check();
    },
    // The link ended: no onDone, no addone, no timer. The app's own ad finishes on its own.
    cancel() {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
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
    // Resolves (never rejects) with this phone's own result once its gate("link-start") call has
    // settled; at once when it never opened.
    get ownAd() {
      return ownAd;
    },
  };
}
