// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/sonnet-5-5/js/play-clock.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { playClock } from "./play-clock.js";

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
