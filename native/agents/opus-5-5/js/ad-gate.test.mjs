// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/opus-5-5/js/ad-gate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { adGate, gateHeartbeat, LINK_AD_GATE_MAX_MS, LINK_AD_GATE_HB_MS } from "./ad-gate.js";
import { fakeTimers } from "../../fable/js/fake-plugin.mjs";
import { createHeartbeat, HB_PREARM_NATIVE_MS } from "../../fable/js/heartbeat.js";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

// An adHook.gate double: each call returns a promise the test settles (ad on screen until then).
function fakeAd() {
  const ad = {
    calls: [],
    gate(trigger) {
      return new Promise((resolve, reject) => ad.calls.push({ trigger, resolve, reject }));
    },
    close(result = { shown: true, reason: "shown" }) {
      ad.calls[ad.calls.length - 1].resolve(result);
    },
  };
  return ad;
}

function make({ gate } = {}) {
  const timers = fakeTimers();
  const ad = fakeAd();
  const sent = [];
  const done = [];
  const g = adGate({
    send: (m) => sent.push(m),
    gate: gate || ad.gate,
    onDone: (r) => done.push(r),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { timers, ad, sent, done, g };
}

test("both phones show an ad: onDone only once both are done (own first, then the other's addone)", async () => {
  const { ad, sent, done, g, timers } = make();
  g.open(1);
  assert.deepEqual(ad.calls.map((c) => c.trigger), ["link-start"]);
  assert.equal(g.active, true);
  assert.equal(timers.count, 1); // the 75 s cap
  ad.close({ shown: true, reason: "shown" });
  await flush();
  assert.deepEqual(sent, [{ t: "addone", id: 1, shown: true, reason: "shown" }]);
  assert.deepEqual(done, []); // still waiting for the other phone
  g.peerDone(1, { t: "addone", id: 1, shown: true, reason: "shown" });
  assert.deepEqual(done, [{ mine: { shown: true, reason: "shown" }, theirs: { shown: true, reason: "shown" }, timedOut: false }]);
  assert.equal(g.active, false);
  assert.equal(g.done, true);
  assert.equal(timers.count, 0);
});

test("the other phone's addone first, then the own ad closes: done then", async () => {
  const { ad, done, g } = make();
  g.open(1);
  g.peerDone(1, { shown: true, reason: "shown" });
  await flush();
  assert.deepEqual(done, []);
  ad.close();
  await flush();
  assert.equal(done.length, 1);
  assert.equal(done[0].timedOut, false);
});

test("a phone in its cooldown answers at once but still waits for the other phone", async () => {
  const timers = fakeTimers();
  const sent = [];
  const done = [];
  const g = adGate({
    send: (m) => sent.push(m),
    gate: async () => ({ shown: false, reason: "cooldown" }),
    onDone: (r) => done.push(r),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  g.open(1);
  await flush();
  assert.deepEqual(sent, [{ t: "addone", id: 1, shown: false, reason: "cooldown" }]);
  timers.advance(30000); // the other phone's 30 s video ad
  assert.deepEqual(done, []);
  g.peerDone(1, { shown: true, reason: "shown" });
  assert.deepEqual(done, [{ mine: { shown: false, reason: "cooldown" }, theirs: { shown: true, reason: "shown" }, timedOut: false }]);
});

test("no addone from the other phone: onDone at 75 s with timedOut, once; late messages change nothing", async () => {
  const { ad, sent, done, g, timers } = make();
  g.open(1);
  ad.close();
  await flush();
  timers.advance(LINK_AD_GATE_MAX_MS - 1);
  assert.deepEqual(done, []);
  timers.advance(1);
  assert.deepEqual(done, [{ mine: { shown: true, reason: "shown" }, theirs: null, timedOut: true }]);
  g.peerDone(1, { shown: true });
  timers.advance(LINK_AD_GATE_MAX_MS);
  assert.equal(done.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(timers.count, 0);
});

test("own ad still open at the cap: onDone(timedOut) without it; its addone still goes out later", async () => {
  const { ad, sent, done, g, timers } = make();
  g.open(1);
  g.peerDone(1, { shown: false, reason: "cooldown" });
  timers.advance(LINK_AD_GATE_MAX_MS);
  assert.deepEqual(done, [{ mine: null, theirs: { shown: false, reason: "cooldown" }, timedOut: true }]);
  ad.close();
  await flush();
  assert.deepEqual(sent, [{ t: "addone", id: 1, shown: true, reason: "shown" }]); // the other phone may still wait
  assert.equal(done.length, 1);
});

test("cancel: no onDone, no timer, no addone when the ad closes afterwards", async () => {
  const { ad, sent, done, g, timers } = make();
  g.open(1);
  g.cancel();
  assert.equal(timers.count, 0);
  assert.equal(g.active, false);
  g.peerDone(1, { shown: true });
  ad.close();
  await flush();
  timers.advance(2 * LINK_AD_GATE_MAX_MS);
  assert.deepEqual(done, []);
  assert.deepEqual(sent, []);
  g.open(2); // a cancelled gate does not open again
  assert.equal(ad.calls.length, 1);
});

test("an addone with another id is ignored; open() runs once per gate", async () => {
  const { ad, done, g } = make();
  g.open(1);
  g.open(1);
  assert.equal(ad.calls.length, 1);
  ad.close();
  await flush();
  g.peerDone(2, { shown: true });
  g.peerDone(undefined, { shown: true });
  assert.deepEqual(done, []);
  g.peerDone(1, { shown: true });
  assert.equal(done.length, 1);
});

test("a gate that rejects or throws (it should not) counts as { shown: false }", async () => {
  for (const gate of [() => Promise.reject(new Error("boom")), () => { throw new Error("sync boom"); }]) {
    const { sent, done, g } = make({ gate });
    g.open(1);
    await flush();
    assert.deepEqual(sent, [{ t: "addone", id: 1, shown: false, reason: "error" }]);
    g.peerDone(1, { shown: true, reason: "shown" });
    assert.deepEqual(done[0].mine, { shown: false, reason: "error" });
  }
  const odd = make({ gate: async () => undefined }); // not the contract either
  odd.g.open(1);
  await flush();
  assert.deepEqual(odd.sent, [{ t: "addone", id: 1, shown: false, reason: null }]);
});

test("an addone that came before open() is kept for the same id (messages are ordered; defensive)", async () => {
  const { ad, done, g } = make();
  g.peerDone(1, { shown: false, reason: "cooldown" });
  g.open(1);
  ad.close();
  await flush();
  assert.equal(done.length, 1);
  assert.deepEqual(done[0].theirs, { shown: false, reason: "cooldown" });
  const other = make();
  other.g.peerDone(7, { shown: true });
  other.g.open(1);
  other.ad.close();
  await flush();
  assert.deepEqual(other.done, []);
});

test("ownAd resolves with the own result (never rejects); at once for a gate that never opened", async () => {
  const idle = make();
  assert.equal(await idle.g.ownAd, undefined);
  const { ad, g } = make({ gate: undefined });
  g.open(1);
  let settled = null;
  g.ownAd.then((r) => (settled = r));
  await flush();
  assert.equal(settled, null);
  ad.calls[0].reject(new Error("x"));
  await flush();
  assert.deepEqual(settled, { shown: false, reason: "error" });
});

test("two gates wired to each other: the host's cooldown answer, the guest's ad, both done together", async () => {
  const timers = fakeTimers();
  const guestAd = fakeAd();
  const done = { host: [], guest: [] };
  let host = null;
  let guest = null;
  host = adGate({
    send: (m) => queueMicrotask(() => guest.peerDone(m.id, m)),
    gate: async () => ({ shown: false, reason: "cooldown" }),
    onDone: (r) => done.host.push(r),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  guest = adGate({
    send: (m) => queueMicrotask(() => host.peerDone(m.id, m)),
    gate: guestAd.gate,
    onDone: (r) => done.guest.push(r),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  host.open(1);
  guest.open(1); // on the adgate message
  await flush();
  assert.deepEqual(done, { host: [], guest: [] });
  timers.advance(30000);
  guestAd.close();
  await flush();
  assert.equal(done.host.length, 1);
  assert.equal(done.guest.length, 1);
  assert.equal(done.host[0].timedOut, false);
  assert.deepEqual(done.host[0].theirs, { shown: true, reason: "shown" });
  assert.deepEqual(done.guest[0].theirs, { shown: false, reason: "cooldown" });
  assert.equal(timers.count, 0);
});

test("gateHeartbeat raises the native pre-arm limit to 85 s and restores 30 s; no channel → no-op", () => {
  const timers = fakeTimers();
  const hb = createHeartbeat({ send: () => {}, onLost: () => {}, native: true, now: timers.now, setInterval: timers.setInterval, clearInterval: timers.clearInterval });
  hb.seen(true);
  const io = { heartbeat: hb };
  gateHeartbeat(io, true);
  assert.equal(LINK_AD_GATE_HB_MS, 85000);
  assert.equal(hb.limitMs, LINK_AD_GATE_HB_MS);
  gateHeartbeat(io, false);
  assert.equal(hb.limitMs, HB_PREARM_NATIVE_MS);
  gateHeartbeat(null, true);
  gateHeartbeat({}, true);
  hb.close();
});
