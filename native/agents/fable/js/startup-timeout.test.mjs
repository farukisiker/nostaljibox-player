// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/fable/js/
import test from "node:test";
import assert from "node:assert/strict";
import { startupTimeout, STARTUP_TIMEOUT_MS } from "./startup-timeout.js";
import { fakeTimers, fakePlugin, fakeIO } from "./fake-plugin.mjs";
import { LockstepNative } from "./lockstep-native.js";
import { nt, pickLang, NETPLAY_KEYS } from "./strings.js";

function make(enabled) {
  const timers = fakeTimers();
  const fired = [];
  const st = startupTimeout(enabled, (what) => fired.push(what), { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  return { timers, fired, st };
}

test("native host: the booted timer starts only when the ROM transfer has resolved, 30 s later → abort", async () => {
  const { timers, fired, st } = make(true);
  const io = fakeIO();
  let resolveRom;
  io.sendBytes = () => new Promise((r) => (resolveRom = r)); // the transfer is still running
  const sending = io.sendBytes({ t: "rom" }, new Uint8Array(1)).then(() => st.expect("booted"));
  timers.advance(120000); // a slow ROM transfer alone must not time out
  assert.deepEqual(fired, []);
  assert.equal(st.pending, null);
  resolveRom();
  await sending;
  assert.equal(st.pending, "booted");
  timers.advance(STARTUP_TIMEOUT_MS - 1);
  assert.deepEqual(fired, []);
  timers.advance(2);
  assert.deepEqual(fired, ["booted"]);
  assert.equal(st.pending, null);
});

test("booted in time clears the timer; then the state send resolves and ready is awaited", async () => {
  const { timers, fired, st } = make(true);
  st.expect("booted");
  timers.advance(10000);
  st.got("booted");
  timers.advance(60000);
  assert.deepEqual(fired, []);
  // Host resync (native) resolves when the state bytes are queued; only then the ready timer starts.
  const plugin = fakePlugin();
  const io = fakeIO();
  const sync = new LockstepNative(plugin, io, true, null, { log: () => {} });
  await sync.resync().then(() => st.expect("ready"));
  assert.equal(st.pending, "ready");
  timers.advance(30001);
  assert.deepEqual(fired, ["ready"]);
});

test("got() for another message leaves the timer alone; clear() stops everything", () => {
  const { timers, fired, st } = make(true);
  st.expect("state");
  st.got("booted");
  assert.equal(st.pending, "state");
  st.clear();
  assert.equal(timers.count, 0);
  timers.advance(60000);
  assert.deepEqual(fired, []);
});

test("EJS backend: no timer at all", () => {
  const { timers, fired, st } = make(false);
  st.expect("booted");
  st.expect("ready");
  assert.equal(st.enabled, false);
  assert.equal(st.pending, null);
  assert.equal(timers.count, 0);
  timers.advance(10 * 60000);
  assert.deepEqual(fired, []);
});

test("pause: the timer stops, nothing fires; resume: the same name, the full time again (§13.3 ad gate)", () => {
  const { timers, fired, st } = make(true);
  st.expect("state");
  timers.advance(20000);
  st.pause();
  assert.equal(st.pending, null);
  assert.equal(st.paused, "state");
  assert.equal(timers.count, 0);
  timers.advance(5 * 60000); // a long ad: no timeout while paused
  assert.deepEqual(fired, []);
  st.pause(); // a second pause keeps what was awaited
  assert.equal(st.paused, "state");
  st.resume();
  assert.equal(st.pending, "state");
  assert.equal(st.paused, null);
  timers.advance(STARTUP_TIMEOUT_MS - 1); // from the resume, not from the first expect
  assert.deepEqual(fired, []);
  timers.advance(2);
  assert.deepEqual(fired, ["state"]);
});

test("pause/resume: the awaited message during the pause, resume with nothing paused, clear, EJS no-op", () => {
  const { timers, fired, st } = make(true);
  st.expect("state");
  st.pause();
  st.got("state"); // came while paused: nothing to wait for any more
  assert.equal(st.paused, null);
  st.resume();
  assert.equal(st.pending, null);
  assert.equal(timers.count, 0);
  st.resume(); // nothing paused
  assert.equal(timers.count, 0);
  st.expect("state");
  st.pause();
  st.clear(); // the link ended during the pause
  st.resume();
  assert.equal(timers.count, 0);
  st.expect("ready");
  st.pause();
  st.expect("booted"); // a new explicit wait replaces the paused one
  assert.equal(st.paused, null);
  assert.equal(st.pending, "booted");
  timers.advance(STARTUP_TIMEOUT_MS + 1);
  assert.deepEqual(fired, ["booted"]);

  const ejs = make(false);
  ejs.st.expect("state");
  ejs.st.pause();
  ejs.st.resume();
  assert.equal(ejs.st.paused, null);
  assert.equal(ejs.timers.count, 0);
});

test("strings: English and Turkish, placeholders, language pick (all 13 languages: strings.test.mjs)", () => {
  assert.equal(nt("connectionLost", null, "en"), "Connection lost");
  assert.equal(nt("connectionLost", null, "tr"), "Bağlantı koptu");
  assert.match(nt("peerMismatch", { mine: "A", theirs: "B" }, "tr"), /sende A, karşıda B/);
  assert.match(nt("peerMismatch", { mine: "A", theirs: "B" }, "en"), /you: A, other phone: B/);
  assert.equal(nt("guestBootFailed", { code: "core-load" }, "en"), "The game could not open on this phone (core-load)");
  assert.equal(nt("nope", null, "tr"), "nope");
  assert.equal(pickLang({ navigator: { languages: ["tr-TR", "en"] } }), "tr");
  assert.equal(pickLang({ navigator: { language: "de-DE" } }), "de");
  assert.equal(pickLang({ navigator: { language: "xx-YY" } }), "en");
  assert.equal(pickLang({ localStorage: { getItem: () => "tr" }, navigator: { language: "en" } }), "tr");
  assert.equal(pickLang({}), "en");
  for (const k of NETPLAY_KEYS) assert.notEqual(nt(k, null, "tr"), k, `missing tr: ${k}`);
});
