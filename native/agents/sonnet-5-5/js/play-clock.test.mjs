// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/sonnet-5-5/js/play-clock.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { playClock, followNativeState, followEjsPlaying } from "./play-clock.js";

function setup(state = "visible") {
  let t = 1000;
  const listeners = [];
  const doc = { visibilityState: state, addEventListener: (_, f) => listeners.push(f) };
  const clock = playClock({ now: () => t, doc });
  return {
    clock,
    advance: (ms) => (t += ms),
    show: (s) => { doc.visibilityState = s; listeners.forEach((f) => f()); },
  };
}

test("does not count before start", () => {
  const s = setup();
  s.advance(5000);
  assert.equal(s.clock.ms(), 0);
});

test("counts while visible", () => {
  const s = setup();
  s.clock.start();
  s.advance(3000);
  assert.equal(s.clock.ms(), 3000);
  s.advance(2000);
  assert.equal(s.clock.ms(), 5000);
});

test("stops while hidden and continues when visible again", () => {
  const s = setup();
  s.clock.start();
  s.advance(1000);
  s.show("hidden");
  s.advance(60000);
  assert.equal(s.clock.ms(), 1000);
  s.show("visible");
  s.advance(500);
  assert.equal(s.clock.ms(), 1500);
});

test("start while hidden begins on visible", () => {
  const s = setup("hidden");
  s.clock.start();
  s.advance(9000);
  assert.equal(s.clock.ms(), 0);
  s.show("visible");
  s.advance(100);
  assert.equal(s.clock.ms(), 100);
});

test("reset zeroes and keeps counting from now", () => {
  const s = setup();
  s.clock.start();
  s.advance(4000);
  s.clock.reset();
  assert.equal(s.clock.ms(), 0);
  s.advance(250);
  assert.equal(s.clock.ms(), 250);
});

test("reset while hidden stays at zero until visible", () => {
  const s = setup();
  s.clock.start();
  s.advance(4000);
  s.show("hidden");
  s.clock.reset();
  s.advance(5000);
  assert.equal(s.clock.ms(), 0);
});

test("a menu pause stops the clock; it counts again once the game resumes", () => {
  const s = setup();
  s.clock.start();
  s.advance(2000);
  s.clock.pause(); // the menu paused the game
  s.advance(120000); // idling in the menu
  assert.equal(s.clock.ms(), 2000);
  s.show("hidden"); // and the page goes to the background meanwhile
  s.show("visible"); // back: still paused, still not counting
  s.advance(5000);
  assert.equal(s.clock.ms(), 2000);
  s.clock.resume();
  s.advance(1000);
  assert.equal(s.clock.ms(), 3000);
});

test("reset while paused stays at zero until the game resumes; resume while hidden waits for visible", () => {
  const s = setup();
  s.clock.start();
  s.advance(4000);
  s.clock.pause();
  s.clock.reset(); // the pause ad was shown
  s.advance(3000);
  assert.equal(s.clock.ms(), 0);
  s.show("hidden");
  s.clock.resume();
  s.advance(3000);
  assert.equal(s.clock.ms(), 0);
  s.show("visible");
  s.advance(700);
  assert.equal(s.clock.ms(), 700);
});

test("followNativeState: the session's state events pause and resume the clock; no plugin, no harm", () => {
  const s = setup();
  const listeners = {};
  const plugin = { addListener: (name, fn) => ((listeners[name] = fn), Promise.resolve({ remove() {} })) };
  followNativeState(s.clock, plugin);
  s.clock.start();
  s.advance(1000);
  listeners.state({ state: "paused", reasons: ["user"] }); // native-menu.js → plugin.pause()
  s.advance(60000);
  assert.equal(s.clock.ms(), 1000);
  listeners.state({ state: "running", reasons: [] }); // menu closed → plugin.resume()
  s.advance(500);
  assert.equal(s.clock.ms(), 1500);
  followNativeState(s.clock, null);
  followNativeState(s.clock, { addListener() { throw new Error("no events"); } });
});

test("followEjsPlaying: EmulatorJS's pause()/play() (all through togglePlaying) pause and resume the clock", () => {
  const s = setup();
  const emu = { paused: false, loops: [] };
  emu.togglePlaying = function () {
    this.paused = !this.paused;
    this.loops.push(this.paused ? 0 : 1);
  };
  emu.pause = () => { if (!emu.paused) emu.togglePlaying(); };
  emu.play = () => { if (emu.paused) emu.togglePlaying(); };
  followEjsPlaying(s.clock, emu);
  s.clock.start();
  s.advance(1000);
  emu.pause(); // play.js's menu pause
  s.advance(30000);
  assert.equal(s.clock.ms(), 1000);
  emu.play(); // ▶ in the menu bar
  s.advance(250);
  assert.equal(s.clock.ms(), 1250);
  assert.deepEqual(emu.loops, [0, 1]); // EmulatorJS's own toggle still runs
  followEjsPlaying(s.clock, null);
  followEjsPlaying(s.clock, {});
});
