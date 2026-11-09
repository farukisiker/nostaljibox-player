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
  const sync = new LockstepNative(plugin, io, true, opts.onWait, { log: opts.log || quiet });
  sync.attach();
  return { plugin, io, sync };
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
  // Before the load resolves nothing else has happened.
  assert.deepEqual(plugin.names(), ["lockstepHold", "loadStateBase64"]);
  assert.deepEqual(io.sent, []);
  await p;
  assert.deepEqual(plugin.loaded, [toBase64(state)]);
  // `ready` leaves before lockstepStart; start comes before the hold is released.
  assert.deepEqual(io.sent, [{ t: "ready", epoch: 1 }]);
  assert.deepEqual(plugin.names(), ["lockstepHold", "loadStateBase64", "lockstepStart", "lockstepHold"]);
  const start = plugin.calls[2].args;
  assert.deepEqual(start, { role: 1, epoch: 1, applied: [0, 0], delay: 4, batch: 2, checkEvery: 300 });
  assert.deepEqual(plugin.calls[3].args, { hold: false });
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
  sync.onMessage({ t: "ready", epoch: 1 });
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

test("checksum: guest forwards its hash, host compares; a mismatch is logged and counted, no resync in N0", async () => {
  const g = guest();
  await g.sync.onMessage({ t: "state", epoch: 1 }, new Uint8Array(1));
  g.plugin.emit("lockstepChecksum", { epoch: 1, frame: 300, hash: "00000000deadbeef" });
  assert.deepEqual(g.io.sent.at(-1), ["h", 1, 300, "00000000deadbeef"]);
  g.plugin.emit("lockstepChecksum", { epoch: 0, frame: 600, hash: "x" }); // stale epoch: dropped
  assert.equal(g.io.sent.length, 2);

  const logs = [];
  const h = host({ log: (...a) => logs.push(a) });
  await h.sync.resync();
  h.sync.onMessage({ t: "ready", epoch: 1 });
  const callsAfterStart = h.plugin.calls.length;
  h.plugin.emit("lockstepChecksum", { epoch: 1, frame: 300, hash: "aa" });
  h.sync.onMessage(["h", 1, 300, "aa"]);
  assert.equal(h.sync.desyncs, 0);
  h.sync.onMessage(["h", 1, 600, "bb"]); // guest first this time
  h.plugin.emit("lockstepChecksum", { epoch: 1, frame: 600, hash: "cc" });
  assert.equal(h.sync.desyncs, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "lockstep: DESYNC");
  assert.equal(logs[0][1], 600);
  // The only plugin call after the mismatch is the note to the driver: no state sent, no restart.
  assert.deepEqual(h.plugin.names().slice(callsAfterStart), ["lockstepNoteDesync"]);
  assert.equal(h.sync.hashes.size, 0);
});

test("desync: host tells the driver with lockstepNoteDesync { epoch, frame } without awaiting it; missing method and rejection are harmless", async () => {
  const logs = [];
  const h = host({ log: (...a) => logs.push(a) });
  await h.sync.resync();
  h.sync.onMessage({ t: "ready", epoch: 1 });
  const before = h.plugin.calls.length;
  // Match: nothing is noted.
  h.plugin.emit("lockstepChecksum", { epoch: 1, frame: 300, hash: "aa" });
  h.sync.onMessage(["h", 1, 300, "aa"]);
  assert.equal(h.plugin.desyncs, 0);
  assert.equal(h.plugin.calls.length, before);
  // Mismatch: noted synchronously, with the host's current epoch and the compared frame.
  h.plugin.emit("lockstepChecksum", { epoch: 1, frame: 600, hash: "aa" });
  h.sync.onMessage(["h", 1, 600, "bb"]);
  assert.deepEqual(h.plugin.calls.at(-1), { method: "lockstepNoteDesync", args: { epoch: 1, frame: 600 } });
  assert.equal(h.plugin.desyncs, 1);
  assert.equal(h.sync.desyncs, 1);
  // A second desync at another frame: another note, same epoch.
  h.sync.onMessage(["h", 1, 900, "x"]);
  h.plugin.emit("lockstepChecksum", { epoch: 1, frame: 900, hash: "y" });
  assert.deepEqual(h.plugin.calls.at(-1).args, { epoch: 1, frame: 900 });
  assert.equal(h.plugin.desyncs, 2);

  // Older plugin without the method: counted and logged in JS, no TypeError.
  const old = host({ log: quiet });
  delete old.plugin.lockstepNoteDesync;
  await old.sync.resync();
  old.sync.onMessage({ t: "ready", epoch: 1 });
  const n = old.plugin.calls.length;
  old.plugin.emit("lockstepChecksum", { epoch: 1, frame: 300, hash: "aa" });
  old.sync.onMessage(["h", 1, 300, "bb"]);
  assert.equal(old.sync.desyncs, 1);
  assert.equal(old.plugin.calls.length, n);

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
