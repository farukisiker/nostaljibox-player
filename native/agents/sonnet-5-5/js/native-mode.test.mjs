// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/sonnet-5-5/js/
import test from "node:test";
import assert from "node:assert/strict";

// ---- minimal DOM / Capacitor stubs (installed before the modules are imported) ----
class El {
  constructor(id, hidden = false) {
    this.id = id;
    this.hidden = false;
    this.style = {};
    this.clicks = 0;
    const set = new Set(hidden ? ["hidden"] : []);
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
    };
  }
  closest(sel) {
    return sel === `#${this.id}` ? this : null;
  }
  click() {
    this.clicks++;
  }
}

function makeDom() {
  const els = new Map();
  for (const id of ["back", "emu-menu", "p2"]) els.set(id, new El(id));
  for (const id of ["tools-panel", "link", "join", "native-menu", "error"]) els.set(id, new El(id, true));
  const listeners = [];
  const root = new El("html");
  const doc = {
    title: "",
    body: {},
    documentElement: root,
    events: [],
    getElementById: (id) => els.get(id) ?? null,
    addEventListener: (type, fn, capture) => listeners.push({ target: doc, type, fn, capture }),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.target === doc && l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: (ev) => (doc.events.push(ev.type), true),
  };
  const observers = [];
  const win = {
    listeners,
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
        this.live = true;
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.live = false;
      }
    },
    addEventListener: (type, fn, capture) => listeners.push({ target: win, type, fn, capture }),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.target === win && l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const fire = (target, type, ev) =>
    listeners.filter((l) => l.target === target && l.type === type).forEach((l) => l.fn(ev));
  const mutate = () => observers.filter((o) => o.live).forEach((o) => o.cb([]));
  return { els, doc, win, fire, mutate };
}

function makePlugin() {
  const calls = { start: [], stop: 0, setPadVisible: [] };
  const handlers = {};
  return {
    calls,
    emit: (name, payload) => (handlers[name] || []).forEach((h) => h(payload)),
    isAvailable: async () => ({ available: true, core: "supafaust", containers: ["zip"] }),
    hasRom: async () => ({ cached: true }),
    start: async (args) => (calls.start.push(args), {}),
    stop: async () => (calls.stop++, { sramSaved: false }),
    setPadVisible: async (args) => (calls.setPadVisible.push(args), {}),
    addListener: async (name, cb) => {
      (handlers[name] ||= []).push(cb);
      return { remove: async () => (handlers[name] = handlers[name].filter((h) => h !== cb)) };
    },
  };
}

// One shared environment: native-player.js reads `window` lazily, except for its stop-once-on-load
// step at import time, so a plugin must exist before the first import.
const dom = makeDom();
let plugin = makePlugin();
let platform = "ios";
const store = new Map();
globalThis.window = dom.win;
dom.win.Capacitor = { getPlatform: () => platform, Plugins: { NativePlayer: plugin } };
globalThis.document = dom.doc;
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null };
globalThis.location = { href: "https://app.test/player/play.html?id=g1" };

const { installNativeMode, autoOpenHostLink, resetNativeMode } = await import("./native-mode.js");

const PADS = { snes: [{ type: "zone", id: "dpad" }], nes: [] };
const GAME = { id: "g1", name: "Test Game", file: "test.sfc", core: "snes" };
const ROM = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function setup({ query = "?id=g1", plat = "ios" } = {}) {
  resetNativeMode();
  plugin = makePlugin();
  platform = plat;
  dom.win.Capacitor.Plugins.NativePlayer = plugin;
  dom.win.Capacitor.getPlatform = () => platform;
  delete dom.win.nbNative;
  dom.doc.events.length = 0;
  dom.doc.documentElement.classList.remove("native");
  for (const el of dom.els.values()) el.clicks = 0;
  for (const id of ["tools-panel", "link", "join", "native-menu", "error"]) dom.els.get(id).classList.add("hidden");
  const navigated = [];
  let fallbacks = 0;
  const ctx = {
    params: new URLSearchParams(query),
    game: GAME,
    rom: ROM,
    PADS,
    bootEmulator: () => fallbacks++,
    navigate: (url) => navigated.push(url),
  };
  return { ctx, navigated, fallbacks: () => fallbacks };
}

const click = (id) => {
  const ev = { target: dom.els.get(id), stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } };
  dom.fire(dom.doc, "click", ev);
  return ev;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("returns false on non-iOS and leaves the page alone", async () => {
  const { ctx } = setup({ plat: "android" });
  assert.equal(await installNativeMode(ctx), false);
  assert.equal(plugin.calls.start.length, 0);
  assert.equal(dom.win.listeners.length, 0);
  assert.equal(dom.doc.documentElement.classList.contains("native"), false);
});

test("returns false with ?ejs=1 (N0-f: ?join is no longer a gate; play.js never calls this for a guest)", async () => {
  const { ctx } = setup({ query: "?id=g1&ejs=1" });
  assert.equal(await installNativeMode(ctx), false);
  assert.equal(plugin.calls.start.length, 0);
});

test("true path: starts the plugin once with PADS[game.core] and takes the page over", async () => {
  const { ctx, fallbacks } = setup();
  assert.equal(await installNativeMode(ctx), true);
  assert.equal(plugin.calls.start.length, 1);
  assert.equal(plugin.calls.start[0].pad, PADS.snes);
  assert.equal(plugin.calls.start[0].gameId, "g1");
  assert.equal(plugin.calls.start[0].core, "supafaust");
  assert.equal(dom.doc.documentElement.classList.contains("native"), true);
  assert.equal(dom.win.nbNative.plugin, plugin);
  assert.equal(dom.win.nbNative.game, GAME);
  assert.equal(typeof dom.win.nbNative.onFallback, "function");
  assert.equal(fallbacks(), 0);
});

test("native error falls back to EmulatorJS exactly once", async () => {
  const { ctx, fallbacks } = setup();
  assert.equal(await installNativeMode(ctx), true);
  plugin.emit("error", { code: "core-load", message: "boom" });
  plugin.emit("error", { code: "internal", message: "again" });
  await settle();
  assert.equal(fallbacks(), 1);
  assert.equal(dom.doc.documentElement.classList.contains("native"), false);
  assert.equal(dom.win.nbNative, undefined);
  assert.equal(dom.win.listeners.length, 0, "page listeners are removed");
  // a late onFallback (e.g. from the native menu) must not boot a second emulator
  await settle();
  assert.equal(fallbacks(), 1);
});

test("a rejected start falls back once", async () => {
  const { ctx, fallbacks } = setup();
  plugin.start = async () => {
    throw { code: "rom-rejected", message: "no" };
  };
  assert.equal(await installNativeMode(ctx), true);
  assert.equal(fallbacks(), 1);
});

test("#back waits for stopNative, then navigates with the ad rule URL", async () => {
  const { ctx, navigated } = setup();
  await installNativeMode(ctx);
  const stopsBefore = plugin.calls.stop;
  const ev = click("back");
  assert.equal(ev.stopped, true, "play.js's own handler never sees the click");
  assert.deepEqual(navigated, [], "not before stop resolves");
  await settle();
  assert.equal(plugin.calls.stop, stopsBefore + 1);
  assert.deepEqual(navigated, ["../index.html?from=game"]);
});

test("#emu-menu dispatches nb:native-menu instead of the EmulatorJS menu", async () => {
  const { ctx } = setup();
  await installNativeMode(ctx);
  const ev = click("emu-menu");
  assert.equal(ev.stopped, true);
  assert.deepEqual(dom.doc.events, ["nb:native-menu"]);
});

test("#p2 in native mode stays native (N0-f): the click reaches play.js's host link, no stop, no reload", async () => {
  const { ctx, navigated } = setup();
  await installNativeMode(ctx);
  const stopsBefore = plugin.calls.stop;
  const ev = click("p2");
  assert.equal(ev.stopped, false, "setupHostLink's own listener gets the click");
  await settle();
  assert.deepEqual(navigated, [], "no ejs=1&p2=1 reload");
  assert.equal(plugin.calls.stop, stopsBefore, "the native session goes on; host-link holds it via lockstepHold");
  assert.equal(dom.doc.documentElement.classList.contains("native"), true);
  assert.equal(dom.win.nbNative.plugin, plugin, "host-link.js finds the session here");
});

test("nbNative.linked mirrors body.linked (host-link sets it while the guest is connected)", async () => {
  const { ctx } = setup();
  const set = new Set();
  dom.doc.body = { classList: { contains: (c) => set.has(c) } };
  try {
    await installNativeMode(ctx);
    assert.equal(dom.win.nbNative.linked, false);
    set.add("linked");
    dom.mutate();
    assert.equal(dom.win.nbNative.linked, true);
    set.delete("linked");
    dom.mutate();
    assert.equal(dom.win.nbNative.linked, false);
  } finally {
    dom.doc.body = {};
  }
});

test("pagehide stops the native session", async () => {
  const { ctx } = setup();
  await installNativeMode(ctx);
  const before = plugin.calls.stop;
  dom.fire(dom.win, "pagehide", {});
  await settle();
  assert.equal(plugin.calls.stop, before + 1);
});

test("any visible overlay hides the pad; closing them shows it again", async () => {
  const { ctx } = setup();
  await installNativeMode(ctx);
  plugin.calls.setPadVisible.length = 0;
  dom.els.get("tools-panel").classList.remove("hidden");
  dom.mutate();
  dom.els.get("error").classList.remove("hidden"); // a second overlay changes nothing yet
  dom.mutate();
  assert.deepEqual(plugin.calls.setPadVisible, [{ visible: false }]);
  dom.els.get("tools-panel").classList.add("hidden");
  dom.mutate();
  assert.equal(plugin.calls.setPadVisible.length, 1, "error is still visible");
  dom.els.get("error").classList.add("hidden");
  dom.mutate();
  assert.deepEqual(plugin.calls.setPadVisible, [{ visible: false }, { visible: true }]);
});

test("without native mode, #p2 and #back are left to play.js", async () => {
  const { ctx } = setup({ plat: "android" });
  await installNativeMode(ctx);
  assert.equal(click("p2").stopped, false);
  assert.equal(click("back").stopped, false);
});

test("autoOpenHostLink clicks #p2 once, only with p2=1", () => {
  resetNativeMode();
  dom.els.get("p2").clicks = 0;
  assert.equal(autoOpenHostLink({ params: new URLSearchParams("?id=g1&ejs=1") }), false);
  assert.equal(dom.els.get("p2").clicks, 0);
  assert.equal(autoOpenHostLink({ params: new URLSearchParams("?id=g1&ejs=1&p2=1") }), true);
  assert.equal(autoOpenHostLink({ params: new URLSearchParams("?id=g1&ejs=1&p2=1") }), false);
  assert.equal(dom.els.get("p2").clicks, 1);
});

// ---- fallback ordering and ZIP inner names ----
import { makeZip } from "./zip-fixture.mjs";

test("nbNative.onFallback stops the native session before EmulatorJS boots, exactly once", async () => {
  const log = [];
  const { ctx } = setup();
  ctx.bootEmulator = () => log.push("boot");
  const stop = plugin.stop;
  plugin.stop = async () => {
    log.push("stop");
    return stop();
  };
  assert.equal(await installNativeMode(ctx), true);
  const menuFallback = dom.win.nbNative.onFallback; // what the native menu holds on to
  const first = menuFallback();
  assert.equal(dom.doc.documentElement.classList.contains("native"), false, "page leaves native mode at once");
  assert.equal(dom.win.listeners.length, 0, "page listeners are removed at once");
  assert.deepEqual(log, [], "EmulatorJS has not started yet");
  await first;
  assert.deepEqual(log, ["stop", "boot"], "the session is stopped before EmulatorJS boots");
  await menuFallback(); // again: nothing happens
  plugin.emit("error", { code: "internal", message: "late" }); // its listener is gone
  await settle();
  assert.deepEqual(log, ["stop", "boot"]);
});

test("a plugin error also stops native before booting EmulatorJS, once", async () => {
  const log = [];
  const { ctx } = setup();
  ctx.bootEmulator = () => log.push("boot");
  const stop = plugin.stop;
  plugin.stop = async () => (log.push("stop"), stop());
  await installNativeMode(ctx);
  plugin.emit("error", { code: "core-load", message: "boom" });
  await settle();
  assert.equal(log.at(-1), "boot");
  assert.equal(log.filter((entry) => entry === "boot").length, 1);
  assert.ok(log.indexOf("stop") < log.indexOf("boot"));
});

test("a wedged plugin cannot keep EmulatorJS from starting", async () => {
  const { ctx, fallbacks } = setup();
  await installNativeMode(ctx);
  let release;
  plugin.stop = () => new Promise((resolve) => (release = resolve)); // answers only when released
  const done = dom.win.nbNative.onFallback();
  await done; // resolves after the stop timeout
  assert.equal(fallbacks(), 1);
  release({ sramSaved: false }); // native-player.js shares one pending stop; let it end for later tests
  await settle();
});

test("a ZIP with a .bin ROM passes the inner name as romName", async () => {
  const { ctx } = setup();
  const rom = makeZip([["roms/Sonic The Hedgehog.bin", new Uint8Array([1, 2, 3])]]);
  Object.assign(ctx, { rom, game: { id: "g1", name: "Sonic", file: "Sonic.zip", core: "segaMD" } });
  assert.equal(await installNativeMode(ctx), true);
  assert.equal(plugin.calls.start.length, 1);
  assert.equal(plugin.calls.start[0].romName, "Sonic The Hedgehog.bin");
  assert.equal(plugin.calls.start[0].gameId, "g1");
  assert.equal(dom.win.nbNative.game.file, "Sonic.zip", "the menu still sees the library record");
});

test("a ZIP without a ROM entry is declined before anything is touched", async () => {
  const { ctx, fallbacks } = setup();
  const rom = makeZip([["readme.txt", "hello"]]);
  Object.assign(ctx, { rom, game: { id: "g1", name: "Sonic", file: "Sonic.zip", core: "segaMD" } });
  assert.equal(await installNativeMode(ctx), false);
  assert.equal(plugin.calls.start.length, 0);
  assert.equal(dom.win.listeners.length, 0);
  assert.equal(dom.doc.documentElement.classList.contains("native"), false);
  assert.equal(dom.win.nbNative, undefined);
  assert.equal(fallbacks(), 0, "play.js boots EmulatorJS itself on false");
});

test("a raw ROM keeps its own file name", async () => {
  const { ctx } = setup();
  assert.equal(await installNativeMode(ctx), true);
  assert.equal(plugin.calls.start[0].romName, "test.sfc");
});

// ---- nbNative v2: options, pad preference, tools panel, late start ----

test("nbNative carries the options bootNative started with", async () => {
  const { ctx } = setup();
  await installNativeMode(ctx);
  assert.deepEqual(dom.win.nbNative.options, { scaling: "fit", showPad: true, showStats: true });
  const start = plugin.calls.start[0];
  assert.equal(start.scaling, dom.win.nbNative.options.scaling);
  assert.equal(start.showPad, dom.win.nbNative.options.showPad);
  assert.equal(start.showStats, dom.win.nbNative.options.showStats);
  assert.equal(typeof dom.win.nbNative.setPadPreference, "function");
});

test("setPadPreference(false) hides the pad and overlays cannot bring it back", async () => {
  const { ctx } = setup();
  await installNativeMode(ctx);
  plugin.calls.setPadVisible.length = 0;
  await dom.win.nbNative.setPadPreference(false);
  assert.deepEqual(plugin.calls.setPadVisible, [{ visible: false }]);
  // open and close an overlay: the pad stays off because the player turned it off
  dom.els.get("tools-panel").classList.remove("hidden");
  dom.mutate();
  dom.els.get("tools-panel").classList.add("hidden");
  dom.mutate();
  assert.equal(plugin.calls.setPadVisible.at(-1).visible, false);
  assert.ok(plugin.calls.setPadVisible.every((call) => call.visible === false));
});

test("setPadPreference(true) shows the pad again, but not under an open overlay", async () => {
  const { ctx } = setup();
  await installNativeMode(ctx);
  await dom.win.nbNative.setPadPreference(false);
  plugin.calls.setPadVisible.length = 0;
  dom.els.get("native-menu").classList.remove("hidden"); // the menu is open
  await dom.win.nbNative.setPadPreference(true);
  assert.deepEqual(plugin.calls.setPadVisible, [{ visible: false }], "preferred, but covered by the menu");
  dom.els.get("native-menu").classList.add("hidden"); // menu closes
  dom.mutate();
  assert.deepEqual(plugin.calls.setPadVisible.at(-1), { visible: true });
});

test("a plugin that rejects setPadVisible makes setPadPreference reject and keeps the old preference", async () => {
  const { ctx } = setup();
  await installNativeMode(ctx);
  const ok = plugin.setPadVisible;
  plugin.setPadVisible = async () => {
    throw { code: "internal", message: "no" };
  };
  await assert.rejects(() => dom.win.nbNative.setPadPreference(false));
  plugin.setPadVisible = ok;
  plugin.calls.setPadVisible.length = 0;
  dom.els.get("error").classList.remove("hidden");
  dom.mutate();
  dom.els.get("error").classList.add("hidden");
  dom.mutate();
  assert.deepEqual(plugin.calls.setPadVisible.at(-1), { visible: true }, "still preferred visible");
});

test("#emu-menu closes #tools-panel before it dispatches nb:native-menu", async () => {
  const { ctx } = setup();
  await installNativeMode(ctx);
  const panel = dom.els.get("tools-panel");
  panel.classList.remove("hidden");
  let hiddenAtDispatch = null;
  const dispatch = dom.doc.dispatchEvent;
  dom.doc.dispatchEvent = (ev) => {
    hiddenAtDispatch = panel.classList.contains("hidden");
    return dispatch(ev);
  };
  click("emu-menu");
  dom.doc.dispatchEvent = dispatch;
  assert.equal(hiddenAtDispatch, true);
  assert.deepEqual(dom.doc.events, ["nb:native-menu"]);
});

test("onFallback while plugin.start is still running stops the late session too", async () => {
  const log = [];
  const { ctx } = setup();
  ctx.bootEmulator = () => log.push("boot");
  let finishStart;
  plugin.start = () =>
    new Promise((resolve) => {
      log.push("start-called");
      finishStart = () => (log.push("start-done"), resolve({}));
    });
  const stop = plugin.stop;
  plugin.stop = async () => (log.push("stop"), stop());
  const installing = installNativeMode(ctx);
  await settle();
  assert.deepEqual(log, ["start-called"]);
  const fallback = dom.win.nbNative.onFallback(); // the menu, before the start finished
  await settle();
  assert.deepEqual(log, ["start-called", "stop"], "EmulatorJS waits for the start to end");
  finishStart();
  await fallback;
  await installing;
  assert.deepEqual(log, ["start-called", "stop", "start-done", "stop", "boot"]);
});

test("a start that already finished is not stopped twice by the menu's fallback", async () => {
  const log = [];
  const { ctx } = setup();
  ctx.bootEmulator = () => log.push("boot");
  const stop = plugin.stop;
  plugin.stop = async () => (log.push("stop"), stop());
  await installNativeMode(ctx);
  await dom.win.nbNative.onFallback();
  assert.deepEqual(log, ["stop", "boot"]);
});