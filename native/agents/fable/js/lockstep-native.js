// SPDX-License-Identifier: GPL-3.0-or-later
// Lockstep on the native player (NETPLAY.md §3.1). The frame gate, input sampling and checksum run
// in the native LockstepDriver on the core thread; this class only moves input batches between the
// plugin's events and the data channel and drives the start sequence (state → ready → start → run).
// Same surface as the EmulatorJS Lockstep (attach, detach, setHold, resync, onMessage, restart), so
// host-link.js / guest-link.js do not care which one the factory handed them.
//
// Plugin contract (API.md §9): lockstepStart/Stop/Hold resolve as soon as they are queued, in call
// order; pushRemoteInputs and lockstepNoteDesync (v3.1) return nothing; events
// lockstepInputs/lockstepChecksum/lockstepState.
//
// Resync (N1-b, NETPLAY.md §2.1): a checksum mismatch on the host runs the same sequence as game
// start with the next epoch: hold → getStateBase64 (NBST1 envelope, carried opaquely) → `state`;
// the guest holds, loads, answers `ready`, starts and unfreezes; the host starts on `ready`. Inputs
// of the old epoch are dropped by the drivers, the new epoch's are buffered until its start. At most
// one resync per RESYNC_MIN_GAP_MS; the fourth within RESYNC_BURST_WINDOW_MS ends the link instead
// (`onUnstable`). `resyncs` is a JS counter: the plugin has no such stat (and its `desyncs` resets
// on every lockstepStart), see .ai-runs/dev/wp2.requests.

export const DEFAULTS = { delay: 4, batch: 2, checkEvery: 300 };
export const RESYNC_MIN_GAP_MS = 10000;
export const RESYNC_BURST_LIMIT = 3;
export const RESYNC_BURST_WINDOW_MS = 60000;

export function toBase64(bytes, chunk = 3 * 8192) {
  let out = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    let bin = "";
    for (let j = 0; j < slice.length; j++) bin += String.fromCharCode(slice[j]);
    out += btoa(bin);
  }
  return out;
}

export function fromBase64(text) {
  const bin = atob(text || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export class LockstepNative {
  constructor(plugin, io, isHost, onWait, options = {}) {
    this.plugin = plugin;
    this.io = io;
    this.isHost = isHost;
    this.onWait = onWait || (() => {});
    this.params = { ...DEFAULTS, ...options };
    this.log = options.log || ((...a) => console.warn(...a));
    this.now = options.now || (() => Date.now());
    this.epoch = 0;
    this.active = false;
    this.started = false; // lockstepStart issued for the current epoch
    this.desyncs = 0;
    this.resyncs = 0; // host: states resent after a mismatch (the boot-time one is not counted)
    this.resyncTimes = []; // host: when those happened, for the burst limit
    this.frame = 0;
    this.hashes = new Map();
    this.handles = [];
    this.noticeShown = false;
  }

  // Capacitor's addListener returns a promise of a handle (or the handle itself on older versions).
  listen(name, fn) {
    let h;
    try {
      h = this.plugin.addListener(name, fn);
    } catch {
      h = null;
    }
    this.handles.push(h);
  }

  attach() {
    this.active = true;
    if (globalThis.window?.nbNative) globalThis.window.nbNative.lockstep = this; // console debugging
    this.listen("lockstepInputs", (e) => {
      if (!this.active) return;
      this.io.send(["i", e.epoch, e.from, e.masks]);
    });
    this.listen("lockstepChecksum", (e) => {
      if (!this.active || e.epoch !== this.epoch) return;
      if (this.isHost) this.compare(e.frame, e.hash, "mine");
      else this.io.send(["h", e.epoch, e.frame, e.hash]);
    });
    this.listen("lockstepState", (e) => {
      if (!this.active) return;
      if (typeof e.frame === "number") this.frame = e.frame;
      const waiting = !!e.waiting;
      if (waiting !== this.noticeShown) this.onWait((this.noticeShown = waiting));
    });
  }

  // Back to single player (the other phone left, or the link was cut). lockstepStop also clears
  // the session hold, so a host frozen before `ready` runs again.
  detach() {
    this.active = false;
    this.started = false;
    for (const h of this.handles.splice(0)) {
      Promise.resolve(h)
        .then((handle) => handle && handle.remove && handle.remove())
        .catch(() => {});
    }
    if (globalThis.window?.nbNative?.lockstep === this) delete globalThis.window.nbNative.lockstep;
    if (this.noticeShown) this.onWait((this.noticeShown = false));
    this.call("lockstepStop", {});
  }

  setHold(hold) {
    this.call("lockstepHold", { hold: !!hold });
  }

  // Plugin calls are fire-and-forget on one FIFO path; a rejection must never break the channel.
  call(method, args) {
    try {
      const p = this.plugin[method](args);
      if (p && p.catch) p.catch((e) => this.log(`lockstep: ${method} failed`, e));
      return p;
    } catch (e) {
      this.log(`lockstep: ${method} failed`, e);
      return undefined;
    }
  }

  startParams(role) {
    const { delay, batch, checkEvery } = this.params;
    return { role, epoch: this.epoch, applied: [0, 0], delay, batch, checkEvery };
  }

  // Host: freeze (at game start already frozen since the channel opened), take the savestate while
  // frozen and send it with the next epoch. Resolves when the last chunk is queued, so the caller
  // can start the `ready` timeout. Runs at game start (the guest's `booted`) and on every resync.
  // The epoch moves first, so checksums and `ready` of the old epoch are ignored from here on.
  async resync() {
    if (!this.isHost) return;
    this.epoch += 1;
    this.started = false;
    this.hashes.clear();
    await this.call("lockstepHold", { hold: true });
    const res = await this.plugin.getStateBase64({});
    await this.io.sendBytes({ t: "state", epoch: this.epoch }, fromBase64(res && res.data));
  }

  // Host, after a mismatch at `frame`: resend the state unless one is already on its way, one went
  // less than RESYNC_MIN_GAP_MS ago (the next checksum tries again), or this would be the
  // (RESYNC_BURST_LIMIT+1)th within RESYNC_BURST_WINDOW_MS: then `onUnstable` ends the link.
  // `onResyncSent(epoch)` fires once the state's last chunk is queued (arm the `ready` timeout),
  // `onResyncFailed(e)` when the state could not be taken or sent (the host would stay frozen).
  recover(frame) {
    if (!this.isHost || !this.active || !this.started) return;
    const t = this.now();
    const last = this.resyncTimes[this.resyncTimes.length - 1]; // no Array.at: the app targets iOS 15.0
    if (last !== undefined && t - last < RESYNC_MIN_GAP_MS) {
      this.log("lockstep: resync throttled", frame);
      return;
    }
    this.resyncTimes = this.resyncTimes.filter((at) => t - at < RESYNC_BURST_WINDOW_MS);
    if (this.resyncTimes.length >= RESYNC_BURST_LIMIT) {
      this.log("lockstep: unstable link", this.resyncTimes.length, "resyncs in", RESYNC_BURST_WINDOW_MS / 1000, "s");
      this.onUnstable?.();
      return;
    }
    this.resyncTimes.push(t);
    this.resyncs += 1;
    this.log("lockstep: resync", this.resyncs, "at frame", frame, "→ epoch", this.epoch + 1);
    this.resync()
      .then(() => this.active && this.onResyncSent?.(this.epoch))
      .catch((e) => {
        this.log("lockstep: resync failed", e);
        this.onResyncFailed?.(e);
      });
  }

  restart() {
    // The native driver restarts itself on lockstepStart; nothing to do here.
  }

  onMessage(msg, bytes) {
    if (Array.isArray(msg)) {
      const [type, epoch, from, value] = msg;
      if (type === "i") {
        // No epoch filter here: the driver drops old epochs and buffers the next one (§2).
        this.call("pushRemoteInputs", { epoch, from, masks: value });
      } else if (type === "h" && this.isHost && this.active && epoch === this.epoch) {
        this.compare(from, value, "theirs");
      }
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "state" && !this.isHost) return this.loadState(msg, bytes);
    if (msg.t === "ready" && this.isHost && msg.epoch === this.epoch && !this.started) {
      // No await between these two: start before anything else can slip in on the FIFO path.
      this.started = true;
      this.call("lockstepStart", this.startParams(0));
      this.call("lockstepHold", { hold: false });
      this.io.armHeartbeat?.();
      // After a resync (not the boot-time start) both phones run again: tell the player.
      if (this.resyncs > 0) this.onResynced?.(this.epoch);
    }
  }

  // Guest: freeze, load the host's state, tell the host, then start and unfreeze. `ready` leaves
  // before the first input batch; the driver's `pending` buffer is the safety net if the order ever
  // flips. At game start the guest is already held (guest-link, before `booted`); on a resync it is
  // running, and the hold stops it before the load. `onLoadFailed(e, resync)` reports a rejected
  // state (`state-mismatch`, or a core refusal) — the caller ends the session; the hold stays until
  // detach's lockstepStop clears it.
  async loadState(msg, bytes) {
    const resync = this.started;
    this.epoch = msg.epoch;
    this.started = false;
    this.call("lockstepHold", { hold: true });
    try {
      await this.plugin.loadStateBase64({ data: toBase64(bytes || new Uint8Array(0)) });
    } catch (e) {
      this.log("lockstep: loadState failed", e);
      this.onLoadFailed?.(e, resync);
      return;
    }
    if (!this.active) return;
    this.started = true;
    this.io.send({ t: "ready", epoch: this.epoch });
    this.call("lockstepStart", this.startParams(1));
    this.call("lockstepHold", { hold: false });
    this.io.armHeartbeat?.();
  }

  // Host only. A mismatch is logged, counted, noted to the driver and (N1-b) recovered from with a
  // resync, subject to the limits in `recover`.
  compare(frame, hash, whose) {
    const entry = this.hashes.get(frame) || {};
    entry[whose] = hash;
    this.hashes.set(frame, entry);
    if (entry.mine === undefined || entry.theirs === undefined) return;
    this.hashes.delete(frame);
    if (entry.mine !== entry.theirs) {
      this.desyncs += 1;
      this.log("lockstep: DESYNC", frame, entry.mine, entry.theirs);
      // API.md §9 v3.1: tell the driver so the native `desyncs` stat and lockstepState agree
      // with JS. Returns nothing (CAPPluginReturnNone), so it is not awaited; an older plugin
      // without the method is skipped.
      if (typeof this.plugin.lockstepNoteDesync === "function") {
        this.call("lockstepNoteDesync", { epoch: this.epoch, frame });
      }
      this.onDesync?.(frame);
      this.recover(frame);
    }
  }
}
