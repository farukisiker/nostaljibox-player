// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/fable/js/
import test from "node:test";
import assert from "node:assert/strict";
import { LockstepNative, toBase64, fromBase64 } from "./lockstep-native.js";
import { fakePlugin, fakeIO } from "./fake-plugin.mjs";
import { createLockstep, Lockstep, LockstepEJS, channelIO } from "../../../../src/lockstep.js";

const tick = () => new Promise((r) => setTimeout(r, 0));
const quiet = () => {};

function guest(opts = {}) {
  const plugin = fakePlugin(opts);
  const io = fakeIO();
  const sync = new LockstepNative(plugin, io, false, opts.onWait, { log: quiet });
  sync.attach();
  return { plugin, io, sync };
}

function host(opts = {}) {
  const plugin = fakePlugin(opts);
  const io = fakeIO();
  const sync = new LockstepNative(plugin, io, true, opts.onWait, { log: opts.log || quiet, now: opts.now });
  sync.attach();
  return { plugin, io, sync };
}

// A host whose game runs at epoch 1 (booted → state → ready), with a settable clock.
async function runningHost(opts = {}) {
  const clock = { t: 0 };
  const h = host({ ...opts, now: () => clock.t });
  h.sync.setHold(true);
  await h.sync.resync();
  h.sync.onMessage({ t: "ready", epoch: 1 });
  h.clock = clock;
  h.mark = () => (h.mark.at = h.plugin.calls.length);
  h.since = () => h.plugin.names().slice(h.mark.at);
  h.mark();
  return h;
}

// Both hashes for `frame` at the host's current epoch, differing: one desync.
function mismatch(h, frame) {
  h.plugin.emit("lockstepChecksum", { epoch: h.sync.epoch, frame, hash: "aa" });
  h.sync.onMessage(["h", h.sync.epoch, frame, "bb"]);
}

test("base64 helpers round-trip", () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 31) & 255);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  assert.equal(toBase64(new Uint8Array(0)), "");
});

test("guest start sequence: hold at boot, state → load, ready, lockstepStart, hold(false), heartbeat armed", async () => {
  const { plugin, io, sync } = guest();
  sync.setHold(true); // guest-link does this right after attach (before `booted`)
  const state = Uint8Array.from([1, 2, 3, 4]);
  const p = sync.onMessage({ t: "state", epoch: 1, size: 4 }, state);
  // Before the load resolves nothing else has happened (the load's own hold(true) is a no-op here).
  assert.deepEqual(plugin.names(), ["lockstepHold", "lockstepHold", "loadStateBase64"]);
  assert.equal(plugin.hold, true);
  assert.deepEqual(io.sent, []);
  await p;
  assert.deepEqual(plugin.loaded, [toBase64(state)]);
  // `ready` leaves before lockstepStart; start comes before the hold is released.
  assert.deepEqual(io.sent, [{ t: "ready", epoch: 1 }]);
  assert.deepEqual(plugin.names(), ["lockstepHold", "lockstepHold", "loadStateBase64", "lockstepStart", "lockstepHold"]);
  const start = plugin.calls[3].args;
  assert.deepEqual(start, { role: 1, epoch: 1, applied: [0, 0], delay: 4, batch: 2, checkEvery: 300 });
  assert.deepEqual(plugin.calls[4].args, { hold: false });
  assert.equal(plugin.hold, false);
  assert.equal(io.armed, 1);
  assert.equal(sync.epoch, 1);
});

test("guest: a failed state load neither answers ready nor starts", async () => {
  const { plugin, io, sync } = guest();
  plugin.fail.loadStateBase64 = new Error("state-mismatch");
  let failed = null;
  sync.onLoadFailed = (e) => (failed = e);
  await sync.onMessage({ t: "state", epoch: 1 }, new Uint8Array(2));
  assert.deepEqual(io.sent, []);
  assert.ok(!plugin.names().includes("lockstepStart"));
  assert.equal(failed.message, "state-mismatch");
});

test("host: booted → resync takes the state while held and sends it with epoch+1", async () => {
  const { plugin, io, sync } = host({ state: toBase64(Uint8Array.from([9, 8, 7])) });
  sync.setHold(true); // host-link: frozen since the channel opened
  await sync.resync();
  assert.deepEqual(plugin.names(), ["lockstepHold", "lockstepHold", "getStateBase64"]);
  assert.equal(plugin.hold, true);
  assert.deepEqual(io.sent, [{ t: "state", epoch: 1, size: 3 }]);
  assert.deepEqual(io.bytes[0], Uint8Array.from([9, 8, 7]));
  assert.equal(sync.epoch, 1);
});

test("host: ready → lockstepStart(role 0) then hold(false) with no await in between; a stale or repeated ready is ignored", async () => {
  const { plugin, io, sync } = host();
  sync.setHold(true);
  await sync.resync();
  const before = plugin.calls.length;
  sync.onMessage({ t: "ready", epoch: 0 }); // old epoch
  assert.equal(plugin.calls.length, before);
  let resynced = 0;
  sync.onResynced = () => (resynced += 1);
  sync.onMessage({ t: "ready", epoch: 1 });
  assert.equal(resynced, 0); // the boot-time start is not a resync
  // Synchronous: both calls are queued before this line.
  assert.deepEqual(plugin.names().slice(before), ["lockstepStart", "lockstepHold"]);
  assert.deepEqual(plugin.calls[before].args, { role: 0, epoch: 1, applied: [0, 0], delay: 4, batch: 2, checkEvery: 300 });
  assert.deepEqual(plugin.calls[before + 1].args, { hold: false });
  assert.equal(io.armed, 1);
  sync.onMessage({ t: "ready", epoch: 1 }); // duplicate
  assert.equal(plugin.calls.length, before + 2);
});

test("lockstepInputs event → [\"i\", epoch, from, masks] on the channel; \"i\" message → pushRemoteInputs, no epoch filter in JS", () => {
  const { plugin, io, sync } = host();
  plugin.emit("lockstepInputs", { epoch: 1, from: 4, masks: [0, 16] });
  assert.deepEqual(io.sent, [["i", 1, 4, [0, 16]]]);
  sync.onMessage(["i", 1, 4, [1, 2]]);
  sync.onMessage(["i", 7, 10, [3]]); // a later epoch: the driver buffers it, JS passes it on
  const pushes = plugin.calls.filter((c) => c.method === "pushRemoteInputs").map((c) => c.args);
  assert.deepEqual(pushes, [
    { epoch: 1, from: 4, masks: [1, 2] },
    { epoch: 7, from: 10, masks: [3] },
  ]);
});

test("epoch buffering (driver model): inputs for the next epoch wait for its lockstepStart, old ones are dropped", async () => {
  const { plugin, sync } = guest();
  sync.onMessage(["i", 1, 0, [5, 6]]); // arrives before the state is loaded: epoch 1 is pending
  assert.deepEqual([...plugin.pending.get(1)], [[0, 5], [1, 6]]);
  await sync.onMessage({ t: "state", epoch: 1 }, new Uint8Array(1));
  assert.deepEqual([...plugin.remote], [[0, 5], [1, 6]]); // moved in at lockstepStart(epoch 1)
  sync.onMessage(["i", 0, 0, [9]]); // epoch 0: dropped
  assert.deepEqual([...plugin.remote], [[0, 5], [1, 6]]);
  sync.onMessage(["i", 1, 2, [7]]);
  assert.deepEqual([...plugin.remote], [[0, 5], [1, 6], [2, 7]]);
});

test("checksum: guest forwards its hash, host compares; a mismatch is logged, counted and (N1-b) answered with one resync", async () => {
  const g = guest();
  await g.sync.onMessage({ t: "state", epoch: 1 }, new Uint8Array(1));
  g.plugin.emit("lockstepChecksum", { epoch: 1, frame: 300, hash: "00000000deadbeef" });
  assert.deepEqual(g.io.sent.at(-1), ["h", 1, 300, "00000000deadbeef"]);
  g.plugin.emit("lockstepChecksum", { epoch: 0, frame: 600, hash: "x" }); // stale epoch: dropped
  assert.equal(g.io.sent.length, 2);

  const logs = [];
  const h = await runningHost({ log: (...a) => logs.push(a), state: toBase64(Uint8Array.from([4, 2])) });
  h.plugin.emit("lockstepChecksum", { epoch: 1, frame: 300, hash: "aa" });
  h.sync.onMessage(["h", 1, 300, "aa"]);
  assert.equal(h.sync.desyncs, 0);
  assert.deepEqual(h.since(), []);
  h.sync.onMessage(["h", 1, 600, "bb"]); // guest first this time
  h.plugin.emit("lockstepChecksum", { epoch: 1, frame: 600, hash: "cc" });
  assert.equal(h.sync.desyncs, 1);
  assert.equal(h.sync.resyncs, 1);
  assert.equal(logs[0][0], "lockstep: DESYNC");
  assert.equal(logs[0][1], 600);
  // Synchronously: the note to the driver, then the hold; the epoch has already moved on.
  assert.deepEqual(h.since(), ["lockstepNoteDesync", "lockstepHold"]);
  assert.deepEqual(h.plugin.calls.at(-1).args, { hold: true });
  assert.equal(h.sync.epoch, 2);
  assert.equal(h.sync.started, false);
  assert.equal(h.sync.hashes.size, 0);
  await tick();
  await tick();
  // The state was taken while held and left with epoch 2.
  assert.deepEqual(h.since(), ["lockstepNoteDesync", "lockstepHold", "getStateBase64"]);
  assert.equal(h.plugin.hold, true);
  assert.deepEqual(h.io.sent.at(-1), { t: "state", epoch: 2, size: 2 });
  assert.deepEqual(h.io.bytes.at(-1), Uint8Array.from([4, 2]));
});

test("resync, host side: checksums of the old epoch are ignored while the state is on its way; ready(epoch+1) → lockstepStart(epoch+1), hold(false); old inputs dropped, new ones buffered", async () => {
  const h = await runningHost();
  let sent = null;
  h.sync.onResyncSent = (epoch) => (sent = epoch);
  mismatch(h, 600);
  await tick();
  await tick();
  assert.equal(sent, 2);
  h.mark();
  // Late hashes of epoch 1 and a ready for epoch 1 change nothing.
  h.plugin.emit("lockstepChecksum", { epoch: 1, frame: 900, hash: "aa" });
  h.sync.onMessage(["h", 1, 900, "bb"]);
  h.sync.onMessage({ t: "ready", epoch: 1 });
  assert.deepEqual(h.since(), []);
  assert.equal(h.sync.desyncs, 1);
  // Guest inputs for epoch 2 arrive before our start: the driver model buffers them.
  h.sync.onMessage(["i", 2, 4, [8, 9]]);
  assert.deepEqual([...h.plugin.pending.get(2)], [[4, 8], [5, 9]]);
  let resynced = null;
  h.sync.onResynced = (epoch) => (resynced = epoch);
  h.sync.onMessage({ t: "ready", epoch: 2 });
  assert.equal(resynced, 2); // host-link toasts "Re-synced" here (not at the boot-time ready)
  assert.deepEqual(h.since(), ["pushRemoteInputs", "lockstepStart", "lockstepHold"]);
  assert.deepEqual(h.plugin.calls.at(-2).args, { role: 0, epoch: 2, applied: [0, 0], delay: 4, batch: 2, checkEvery: 300 });
  assert.deepEqual(h.plugin.calls.at(-1).args, { hold: false });
  assert.equal(h.plugin.hold, false);
  assert.equal(h.plugin.epoch, 2);
  assert.deepEqual([...h.plugin.remote], [[4, 8], [5, 9]]); // moved in at lockstepStart(2)
  h.sync.onMessage(["i", 1, 700, [1]]); // a straggler of epoch 1: dropped by the driver
  assert.deepEqual([...h.plugin.remote], [[4, 8], [5, 9]]);
  h.sync.onMessage(["i", 2, 6, [3]]);
  assert.deepEqual([...h.plugin.remote], [[4, 8], [5, 9], [6, 3]]);
  // Epoch 2 compares work again.
  h.plugin.emit("lockstepChecksum", { epoch: 2, frame: 300, hash: "aa" });
  h.sync.onMessage(["h", 2, 300, "aa"]);
  assert.equal(h.sync.desyncs, 1);
  assert.equal(h.sync.hashes.size, 0);
});

test("resync, guest side: state while running → hold(true), load, ready(epoch), lockstepStart(epoch), hold(false); old-epoch checksums dropped", async () => {
  const { plugin, io, sync } = guest();
  sync.setHold(true);
  await sync.onMessage({ t: "state", epoch: 1 }, new Uint8Array(1)); // game start
  assert.equal(plugin.hold, false);
  const before = plugin.calls.length;
  const state = Uint8Array.from([7, 7, 7]);
  const p = sync.onMessage({ t: "state", epoch: 2, size: 3 }, state);
  // Frozen before the load; nothing sent yet.
  assert.deepEqual(plugin.names().slice(before), ["lockstepHold", "loadStateBase64"]);
  assert.equal(plugin.hold, true);
  assert.equal(io.sent.length, 1);
  plugin.emit("lockstepChecksum", { epoch: 1, frame: 600, hash: "x" }); // the old epoch's last hash
  assert.equal(io.sent.length, 1);
  await p;
  assert.deepEqual(plugin.loaded.at(-1), toBase64(state));
  assert.deepEqual(io.sent.at(-1), { t: "ready", epoch: 2 });
  assert.deepEqual(plugin.names().slice(before), ["lockstepHold", "loadStateBase64", "lockstepStart", "lockstepHold"]);
  assert.deepEqual(plugin.calls.at(-2).args, { role: 1, epoch: 2, applied: [0, 0], delay: 4, batch: 2, checkEvery: 300 });
  assert.deepEqual(plugin.calls.at(-1).args, { hold: false });
  assert.equal(plugin.epoch, 2);
  assert.equal(sync.epoch, 2);
  plugin.emit("lockstepChecksum", { epoch: 2, frame: 300, hash: "y" });
  assert.deepEqual(io.sent.at(-1), ["h", 2, 300, "y"]);
});

test("resync, guest side: a state-mismatch rejection reports onLoadFailed(e, resync=true), no ready, no start, still held", async () => {
  const { plugin, io, sync } = guest();
  sync.setHold(true);
  await sync.onMessage({ t: "state", epoch: 1 }, new Uint8Array(1));
  const reports = [];
  sync.onLoadFailed = (e, resync) => reports.push([e.code, resync]);
  plugin.fail.loadStateBase64 = { code: "state-mismatch", message: "ROM hash differs" };
  const before = plugin.calls.length;
  await sync.onMessage({ t: "state", epoch: 2, size: 1 }, new Uint8Array(1));
  assert.deepEqual(reports, [["state-mismatch", true]]);
  assert.deepEqual(plugin.names().slice(before), ["lockstepHold", "loadStateBase64"]);
  assert.equal(plugin.hold, true);
  assert.equal(io.sent.filter((m) => m.t === "ready").length, 1); // only the boot-time one
  assert.equal(plugin.epoch, 1); // the driver was never restarted
  // guest-link's abort → end → detach: lockstepStop clears the hold.
  sync.detach();
  assert.equal(plugin.hold, false);
  // At game start the same failure reports resync=false.
  const g2 = guest();
  g2.sync.onLoadFailed = (e, resync) => reports.push([e.code, resync]);
  g2.plugin.fail.loadStateBase64 = { code: "state-mismatch" };
  await g2.sync.onMessage({ t: "state", epoch: 1 }, new Uint8Array(1));
  assert.deepEqual(reports.at(-1), ["state-mismatch", false]);
});

test("resync rate limit: a second mismatch within 10 s is counted but not resynced; after 10 s it is", async () => {
  const logs = [];
  const h = await runningHost({ log: (...a) => logs.push(a) });
  mismatch(h, 600);
  await tick();
  await tick();
  h.sync.onMessage({ t: "ready", epoch: 2 });
  assert.equal(h.sync.resyncs, 1);
  h.mark();
  h.clock.t = 5000;
  mismatch(h, 300);
  assert.equal(h.sync.desyncs, 2);
  assert.equal(h.sync.resyncs, 1);
  assert.deepEqual(h.since(), ["lockstepNoteDesync"]); // no hold, no state
  assert.equal(h.sync.epoch, 2);
  assert.equal(h.sync.started, true);
  assert.ok(logs.some((l) => l[0] === "lockstep: resync throttled"));
  h.clock.t = 10000;
  mismatch(h, 600);
  assert.equal(h.sync.resyncs, 2);
  assert.equal(h.sync.epoch, 3);
  assert.deepEqual(h.since(), ["lockstepNoteDesync", "lockstepNoteDesync", "lockstepHold"]);
  await tick();
  await tick();
  assert.deepEqual(h.io.sent.at(-1), { t: "state", epoch: 3, size: 3 });
});

test("unstable link: the fourth resync within a minute is refused and onUnstable fires; the window slides", async () => {
  const h = await runningHost();
  let unstable = 0;
  h.sync.onUnstable = () => (unstable += 1);
  const cycle = async (t) => {
    h.clock.t = t;
    mismatch(h, 600);
    await tick();
    await tick();
    h.sync.onMessage({ t: "ready", epoch: h.sync.epoch });
  };
  await cycle(0);
  await cycle(10000);
  await cycle(20000);
  assert.equal(h.sync.resyncs, 3);
  assert.equal(h.sync.epoch, 4);
  assert.equal(unstable, 0);
  h.mark();
  h.clock.t = 30000;
  mismatch(h, 600);
  assert.equal(unstable, 1);
  assert.equal(h.sync.resyncs, 3);
  assert.equal(h.sync.epoch, 4); // no fourth state
  assert.deepEqual(h.since(), ["lockstepNoteDesync"]);
  // host-link hangs up on onUnstable; if it did not, a mismatch after the first resync left the
  // window is served again (two in the last 60 s).
  h.clock.t = 61000;
  mismatch(h, 900);
  assert.equal(unstable, 1);
  assert.equal(h.sync.resyncs, 4);
  assert.equal(h.sync.epoch, 5);
});

test("resync failure: getStateBase64 rejecting reports onResyncFailed and is logged, never an unhandled rejection; a mismatch before the game runs or after detach is ignored", async () => {
  const logs = [];
  const h = await runningHost({ log: (...a) => logs.push(a) });
  h.plugin.fail.getStateBase64 = { code: "no-session", message: "No active game" };
  let failed = null;
  h.sync.onResyncFailed = (e) => (failed = e);
  mismatch(h, 600);
  await tick();
  await tick();
  assert.equal(failed.code, "no-session");
  assert.ok(logs.some((l) => l[0] === "lockstep: resync failed"));
  assert.equal(h.io.sent.filter((m) => m.t === "state").length, 1); // only the boot-time state

  // Host whose guest has not answered `ready` yet (started=false): hashes do not even compare.
  const early = host();
  early.sync.setHold(true);
  await early.sync.resync();
  early.mark = early.plugin.calls.length;
  early.plugin.emit("lockstepChecksum", { epoch: 1, frame: 300, hash: "aa" });
  early.sync.onMessage(["h", 1, 300, "bb"]);
  assert.equal(early.sync.desyncs, 1);
  assert.equal(early.sync.resyncs, 0);
  assert.deepEqual(early.plugin.names().slice(early.mark), ["lockstepNoteDesync"]);

  // After detach nothing runs.
  const gone = await runningHost();
  gone.sync.detach();
  gone.mark();
  gone.sync.recover(600);
  assert.equal(gone.sync.resyncs, 0);
  assert.deepEqual(gone.since(), []);
});

test("desync: host tells the driver with lockstepNoteDesync { epoch, frame } without awaiting it; missing method and rejection are harmless", async () => {
  const logs = [];
  const h = await runningHost({ log: (...a) => logs.push(a) });
  // Match: nothing is noted.
  h.plugin.emit("lockstepChecksum", { epoch: 1, frame: 300, hash: "aa" });
  h.sync.onMessage(["h", 1, 300, "aa"]);
  assert.equal(h.plugin.desyncs, 0);
  assert.deepEqual(h.since(), []);
  // Mismatch: noted synchronously, with the host's current epoch and the compared frame, before the resync's hold.
  h.plugin.emit("lockstepChecksum", { epoch: 1, frame: 600, hash: "aa" });
  h.sync.onMessage(["h", 1, 600, "bb"]);
  assert.deepEqual(h.plugin.calls.at(-2), { method: "lockstepNoteDesync", args: { epoch: 1, frame: 600 } });
  assert.equal(h.plugin.desyncs, 1);
  assert.equal(h.sync.desyncs, 1);
  // After the resync a desync at another frame: another note, with the new epoch.
  await tick();
  await tick();
  h.sync.onMessage({ t: "ready", epoch: 2 });
  h.clock.t = 10000;
  h.sync.onMessage(["h", 2, 900, "x"]);
  h.plugin.emit("lockstepChecksum", { epoch: 2, frame: 900, hash: "y" });
  assert.deepEqual(h.plugin.calls.at(-2).args, { epoch: 2, frame: 900 });
  assert.equal(h.plugin.desyncs, 2);

  // Older plugin without the method: counted and logged in JS, no TypeError, resync still runs.
  const old = host({ log: quiet });
  delete old.plugin.lockstepNoteDesync;
  await old.sync.resync();
  old.sync.onMessage({ t: "ready", epoch: 1 });
  const n = old.plugin.calls.length;
  old.plugin.emit("lockstepChecksum", { epoch: 1, frame: 300, hash: "aa" });
  old.sync.onMessage(["h", 1, 300, "bb"]);
  assert.equal(old.sync.desyncs, 1);
  assert.deepEqual(old.plugin.names().slice(n), ["lockstepHold"]);

  // A throwing implementation must not break the host's compare path.
  const bad = host({ log: (...a) => logs.push(a) });
  bad.plugin.lockstepNoteDesync = () => {
    throw new Error("boom");
  };
  await bad.sync.resync();
  bad.sync.onMessage({ t: "ready", epoch: 1 });
  let onDesyncFrame = null;
  bad.sync.onDesync = (f) => (onDesyncFrame = f);
  bad.plugin.emit("lockstepChecksum", { epoch: 1, frame: 300, hash: "aa" });
  bad.sync.onMessage(["h", 1, 300, "bb"]);
  assert.equal(bad.sync.desyncs, 1);
  assert.equal(onDesyncFrame, 300);
  assert.equal(bad.sync.resyncs, 1);
  assert.ok(logs.some((l) => l[0] === "lockstep: lockstepNoteDesync failed"));
});

test("lockstepState → onWait only on change; detach → lockstepStop, listeners removed, wait notice cleared", async () => {
  const waits = [];
  const { plugin, sync } = host({ onWait: (w) => waits.push(w) });
  plugin.emit("lockstepState", { waiting: true, frame: 40 });
  plugin.emit("lockstepState", { waiting: true, frame: 41 });
  assert.deepEqual(waits, [true]);
  assert.equal(sync.frame, 41);
  sync.detach();
  assert.deepEqual(waits, [true, false]);
  assert.equal(plugin.stopped, 1);
  assert.equal(plugin.hold, false); // stop clears the session hold (contract)
  await tick();
  assert.equal(plugin.listenerCount("lockstepInputs"), 0);
  assert.equal(plugin.listenerCount("lockstepChecksum"), 0);
  assert.equal(plugin.listenerCount("lockstepState"), 0);
});

test("held guest + detach (host left before state): lockstepStop is what unfreezes it", () => {
  const { plugin, sync } = guest();
  sync.setHold(true);
  assert.equal(plugin.hold, true);
  sync.detach();
  assert.equal(plugin.names().at(-1), "lockstepStop");
  assert.equal(plugin.hold, false);
});

test("a rejected plugin call is logged, never thrown into the channel handler", async () => {
  const logs = [];
  const { plugin, sync } = host({ log: (...a) => logs.push(a) });
  plugin.fail.lockstepStart = new Error("invalid lockstep params");
  await sync.resync();
  sync.onMessage({ t: "ready", epoch: 1 });
  await tick();
  assert.ok(logs.some((l) => l[0] === "lockstep: lockstepStart failed"));
});

test("factory: native when window.nbNative.plugin is set (or the target is a plugin), EJS otherwise; the EJS class is unchanged", () => {
  const emu = { gameManager: { functions: {} } };
  const io = fakeIO();
  globalThis.window = {};
  const ejs = createLockstep(emu, io, true, quiet);
  assert.ok(ejs instanceof Lockstep);
  assert.equal(Lockstep, LockstepEJS);
  assert.equal(ejs.emu, emu);
  assert.equal(ejs.isHost, true);
  // Today's EJS surface and defaults are still there.
  for (const m of ["attach", "detach", "setHold", "resync", "onMessage", "restart"]) assert.equal(typeof ejs[m], "function");
  assert.equal(ejs.checkEvery, 300);

  const plugin = fakePlugin();
  globalThis.window = { nbNative: { plugin } };
  const nat = createLockstep(emu, io, false, quiet);
  assert.ok(nat instanceof LockstepNative);
  assert.equal(nat.plugin, plugin);

  globalThis.window = {};
  const viaTarget = createLockstep(plugin, io, false, quiet);
  assert.ok(viaTarget instanceof LockstepNative);
  delete globalThis.window;
});

test("channelIO: hb messages are swallowed, other messages and binary transfers reach onMessage as before", () => {
  const sent = [];
  const channel = { readyState: "open", send: (d) => sent.push(d), addEventListener() {} };
  const got = [];
  const timers = { setInterval: () => 1, clearInterval() {}, now: () => 0 };
  const io = channelIO(channel, (msg, bytes) => got.push([msg, bytes]), { timers });
  channel.onmessage({ data: JSON.stringify({ t: "hb" }) });
  channel.onmessage({ data: JSON.stringify({ t: "booted" }) });
  channel.onmessage({ data: JSON.stringify({ t: "state", epoch: 1, size: 3 }) });
  channel.onmessage({ data: Uint8Array.from([1, 2]).buffer });
  channel.onmessage({ data: Uint8Array.from([3]).buffer });
  assert.deepEqual(got[0], [{ t: "booted" }, undefined]);
  assert.deepEqual(got[1][0], { t: "state", epoch: 1, size: 3 });
  assert.deepEqual(got[1][1], Uint8Array.from([1, 2, 3]));
  assert.equal(got.length, 2);
  io.send(["i", 1, 0, [0]]);
  assert.deepEqual(sent, ['["i",1,0,[0]]']);
  assert.equal(typeof io.armHeartbeat, "function");
  assert.equal(typeof io.close, "function");
});
