// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/fable/js/
import test from "node:test";
import assert from "node:assert/strict";
import { createHeartbeat, HB_INTERVAL_MS } from "./heartbeat.js";
import { fakeTimers } from "./fake-plugin.mjs";
import { channelIO } from "../../../../src/lockstep.js";

function make({ native = false } = {}) {
  const timers = fakeTimers();
  const sent = [];
  let lost = 0;
  const hb = createHeartbeat({
    send: () => sent.push("hb"),
    onLost: () => lost++,
    native,
    now: timers.now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  return { timers, sent, hb, lost: () => lost };
}

test("sends one hb per second while open", () => {
  const { timers, sent } = make();
  timers.advance(3500);
  assert.equal(sent.length, 3);
  assert.equal(HB_INTERVAL_MS, 1000);
});

test("a peer that never sent hb (old app) has no silence limit, armed or not, on either backend", () => {
  for (const native of [false, true]) {
    const { timers, hb, lost } = make({ native });
    hb.arm();
    timers.advance(60000);
    assert.equal(lost(), 0, `native=${native}`);
    assert.equal(hb.active, true);
    assert.equal(hb.limitMs, Infinity);
  }
});

test("hb received but game not started: 30 s ends the link on the native backend only", () => {
  const nat = make({ native: true });
  nat.hb.seen(true);
  nat.timers.advance(29000);
  assert.equal(nat.lost(), 0);
  nat.timers.advance(2000);
  assert.equal(nat.lost(), 1);
  assert.equal(nat.hb.active, false); // the timer is cleared with the loss

  const ejs = make({ native: false });
  ejs.hb.seen(true);
  ejs.timers.advance(120000);
  assert.equal(ejs.lost(), 0);
  assert.equal(ejs.hb.active, true);
});

test("armed + first hb: 5 s of silence → onLost once; any message resets the clock", () => {
  const { timers, hb, lost } = make({ native: false });
  hb.arm();
  timers.advance(10000); // armed but no hb from the peer yet: nothing
  assert.equal(lost(), 0);
  hb.seen(true);
  timers.advance(4000);
  hb.seen(false); // an input packet counts as life too
  timers.advance(4000);
  assert.equal(lost(), 0);
  timers.advance(2000); // the tick at 20 s sees 6 s of silence
  assert.equal(lost(), 1);
  timers.advance(10000);
  assert.equal(lost(), 1);
});

test("arm after the first hb works the same way", () => {
  const { timers, hb, lost } = make({ native: true });
  hb.seen(true);
  timers.advance(2000);
  hb.arm();
  timers.advance(5500);
  assert.equal(lost(), 1);
});

test("own sleep: a tick that comes late forgives the silence once", () => {
  const { timers, hb, lost } = make({ native: true });
  hb.arm();
  hb.seen(true);
  timers.advance(1000);
  timers.sleep(8000); // this page was in the background; no ticks ran
  timers.advance(1000); // first tick after waking: late by > 2 s
  assert.equal(lost(), 0);
  timers.advance(4000); // still nothing from the peer
  assert.equal(lost(), 0);
  timers.advance(2000); // 5 s after the wake-up tick
  assert.equal(lost(), 1);
});

test("close clears the interval; nothing fires afterwards", () => {
  const { timers, hb, sent, lost } = make({ native: true });
  hb.arm();
  hb.seen(true);
  hb.close();
  assert.equal(hb.active, false);
  assert.equal(timers.count, 0);
  timers.advance(60000);
  assert.equal(sent.length, 0);
  assert.equal(lost(), 0);
});

// channelIO wiring: the heartbeat lives in the channel layer, outside the lockstep classes.
function fakeChannel() {
  const listeners = {};
  return {
    readyState: "open",
    sent: [],
    send(d) {
      this.sent.push(d);
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    fire(type) {
      listeners[type]?.();
    },
  };
}

test("channelIO: hb every second on the wire, every incoming message is life, close → clearInterval", () => {
  const timers = fakeTimers();
  const channel = fakeChannel();
  let lost = 0;
  const io = channelIO(channel, () => {}, {
    native: true,
    onLost: () => lost++,
    timers: { now: timers.now, setInterval: timers.setInterval, clearInterval: timers.clearInterval },
  });
  timers.advance(2000);
  assert.deepEqual(channel.sent, ['{"t":"hb"}', '{"t":"hb"}']);
  channel.onmessage({ data: JSON.stringify({ t: "hb" }) });
  io.armHeartbeat();
  timers.advance(4000);
  channel.onmessage({ data: new Uint8Array(4).buffer }); // a stray binary chunk also counts
  timers.advance(4000);
  assert.equal(lost, 0);
  timers.advance(2000);
  assert.equal(lost, 1);

  const c2 = fakeChannel();
  const t2 = fakeTimers();
  channelIO(c2, () => {}, { timers: { now: t2.now, setInterval: t2.setInterval, clearInterval: t2.clearInterval } });
  assert.equal(t2.count, 1);
  c2.fire("close");
  assert.equal(t2.count, 0);
});

test("channelIO on the EJS backend with an old peer: 60 s of silence, nothing happens (today's behaviour)", () => {
  const timers = fakeTimers();
  const channel = fakeChannel();
  let lost = 0;
  const io = channelIO(channel, () => {}, {
    native: false,
    onLost: () => lost++,
    timers: { now: timers.now, setInterval: timers.setInterval, clearInterval: timers.clearInterval },
  });
  io.armHeartbeat();
  channel.onmessage({ data: JSON.stringify({ t: "booted" }) }); // the old peer talks, but never hb
  timers.advance(60000);
  assert.equal(lost, 0);
  io.close();
  assert.equal(timers.count, 0);
});
