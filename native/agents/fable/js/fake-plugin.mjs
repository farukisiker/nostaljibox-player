// SPDX-License-Identifier: GPL-3.0-or-later
// Test double for the NativePlayer plugin's netplay surface (API.md §9). Records every call in order
// and models the driver's epoch rule (pushRemoteInputs: epoch < current dropped, > current buffered
// until that lockstepStart, == current applied) so JS tests can check what the driver would see.
export function fakePlugin({ state = "AAEC", version = "642d1d1", appVersion = "1.0.0+1", available = true } = {}) {
  const listeners = new Map();
  const plugin = {
    calls: [],
    epoch: null, // current driver epoch, null before the first lockstepStart
    remote: new Map(), // frame -> mask, as the driver would hold them
    pending: new Map(), // epoch -> Map(frame -> mask)
    hold: false,
    stopped: 0,
    desyncs: 0, // lockstepNoteDesync calls, as the driver's `desyncs` stat would count them
    loaded: [],
    fail: {}, // method -> error, to make a call reject

    names() {
      return plugin.calls.map((c) => c.method);
    },
    emit(name, data) {
      for (const fn of listeners.get(name) || []) fn(data);
    },
    listenerCount(name) {
      return (listeners.get(name) || new Set()).size;
    },
    addListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return Promise.resolve({ remove: () => listeners.get(name).delete(fn) });
    },
    isAvailable() {
      return Promise.resolve({ available, version, appVersion, containers: ["zip"] });
    },
    lockstepStart(args) {
      plugin.calls.push({ method: "lockstepStart", args });
      if (plugin.fail.lockstepStart) return Promise.reject(plugin.fail.lockstepStart);
      plugin.epoch = args.epoch;
      plugin.remote = plugin.pending.get(args.epoch) || new Map();
      plugin.pending.clear();
      return Promise.resolve({});
    },
    lockstepStop(args) {
      plugin.calls.push({ method: "lockstepStop", args });
      plugin.stopped += 1;
      plugin.hold = false; // the contract: stop clears the session hold
      plugin.remote = new Map();
      plugin.pending.clear();
      return Promise.resolve({});
    },
    lockstepHold(args) {
      plugin.calls.push({ method: "lockstepHold", args });
      plugin.hold = !!args.hold;
      return Promise.resolve({});
    },
    pushRemoteInputs(args) {
      plugin.calls.push({ method: "pushRemoteInputs", args });
      const { epoch, from, masks } = args;
      if (plugin.epoch !== null && epoch < plugin.epoch) return undefined; // dropped
      const target = plugin.epoch !== null && epoch === plugin.epoch ? plugin.remote : (plugin.pending.get(epoch) || plugin.pending.set(epoch, new Map()).get(epoch));
      masks.forEach((m, i) => target.set(from + i, m));
      return undefined; // CAPPluginReturnNone
    },
    lockstepNoteDesync(args) {
      plugin.calls.push({ method: "lockstepNoteDesync", args });
      plugin.desyncs += 1; // the driver counts it and emits lockstepState
      return undefined; // CAPPluginReturnNone
    },
    getStateBase64(args) {
      plugin.calls.push({ method: "getStateBase64", args });
      if (plugin.fail.getStateBase64) return Promise.reject(plugin.fail.getStateBase64);
      return Promise.resolve({ data: state });
    },
    loadStateBase64(args) {
      plugin.calls.push({ method: "loadStateBase64", args });
      plugin.loaded.push(args.data);
      if (plugin.fail.loadStateBase64) return Promise.reject(plugin.fail.loadStateBase64);
      return Promise.resolve({});
    },
  };
  return plugin;
}

// A data-channel double: records sent JSON messages and byte transfers.
export function fakeIO() {
  const io = {
    sent: [],
    bytes: [],
    armed: 0,
    closed: 0,
    send(msg) {
      io.sent.push(msg);
    },
    async sendBytes(msg, bytes) {
      io.sent.push({ ...msg, size: bytes.length });
      io.bytes.push(bytes);
    },
    armHeartbeat() {
      io.armed += 1;
    },
    close() {
      io.closed += 1;
    },
  };
  return io;
}

// Deterministic timers for heartbeat / timeout tests: advance(ms) runs due callbacks in order.
export function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const api = {
    now: () => now,
    setInterval(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms, at: now + ms, repeat: true });
      return id;
    },
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms, at: now + ms, repeat: false });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    get count() {
      return timers.size;
    },
    // Jumps straight to `now + ms` without firing intermediate ticks (a suspended page).
    sleep(ms) {
      now += ms;
      for (const t of timers.values()) while (t.at <= now) t.at += t.ms;
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
        if (!next) break;
        now = next.t.at;
        if (next.t.repeat) next.t.at += next.t.ms;
        else timers.delete(next.id);
        next.t.fn();
      }
      now = end;
    },
  };
  return api;
}
