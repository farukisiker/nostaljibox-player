// SPDX-License-Identifier: GPL-3.0-or-later
// Lockstep on the native player (NETPLAY.md §3.1). The frame gate, input sampling and checksum run
// in the native LockstepDriver on the core thread; this class only moves input batches between the
// plugin's events and the data channel and drives the start sequence (state → ready → start → run).
// Same surface as the EmulatorJS Lockstep (attach, detach, setHold, resync, onMessage, restart), so
// host-link.js / guest-link.js do not care which one the factory handed them.
//
// Plugin contract (API.md §9): lockstepStart/Stop/Hold resolve as soon as they are queued, in call
// order; pushRemoteInputs returns nothing; events lockstepInputs/lockstepChecksum/lockstepState.

export const DEFAULTS = { delay: 4, batch: 2, checkEvery: 300 };

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
    this.epoch = 0;
    this.active = false;
    this.started = false; // lockstepStart issued for the current epoch
    this.desyncs = 0;
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

  // Host: freeze (already frozen since the channel opened), take the savestate while frozen and send
  // it with the next epoch. Resolves when the last chunk is queued, so the caller can start the
  // `ready` timeout. In N0 this runs once, at game start (the guest's `booted`).
  async resync() {
    if (!this.isHost) return;
    this.epoch += 1;
    this.started = false;
    this.hashes.clear();
    await this.call("lockstepHold", { hold: true });
    const res = await this.plugin.getStateBase64({});
    await this.io.sendBytes({ t: "state", epoch: this.epoch }, fromBase64(res && res.data));
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
    }
  }

  // Guest: load the host's state, tell the host, then start and unfreeze. `ready` leaves before the
  // first input batch; the driver's `pending` buffer is the safety net if the order ever flips.
  async loadState(msg, bytes) {
    this.epoch = msg.epoch;
    this.started = false;
    try {
      await this.plugin.loadStateBase64({ data: toBase64(bytes || new Uint8Array(0)) });
    } catch (e) {
      this.log("lockstep: loadState failed", e);
      this.onLoadFailed?.(e);
      return;
    }
    if (!this.active) return;
    this.started = true;
    this.io.send({ t: "ready", epoch: this.epoch });
    this.call("lockstepStart", this.startParams(1));
    this.call("lockstepHold", { hold: false });
    this.io.armHeartbeat?.();
  }

  // Host only. N0: a mismatch is logged and counted; resync comes with N1.
  compare(frame, hash, whose) {
    const entry = this.hashes.get(frame) || {};
    entry[whose] = hash;
    this.hashes.set(frame, entry);
    if (entry.mine === undefined || entry.theirs === undefined) return;
    this.hashes.delete(frame);
    if (entry.mine !== entry.theirs) {
      this.desyncs += 1;
      this.log("lockstep: DESYNC", frame, entry.mine, entry.theirs);
      this.onDesync?.(frame);
    }
  }
}
