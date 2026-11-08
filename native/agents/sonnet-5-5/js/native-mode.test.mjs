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

test("returns false with ?ejs=1 and with ?join", async () => {
  for (const query of ["?id=g1&ejs=1", "?join"]) {
    const { ctx } = setup({ query });
    assert.equal(await installNativeMode(ctx), false, query);
    assert.equal(plugin.calls.start.length, 0, query);
  }
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

test("#p2 stops native and reloads with ejs=1&p2=1", async () => {
  const { ctx, navigated } = setup();
  await installNativeMode(ctx);
  const ev = click("p2");
  assert.equal(ev.stopped, true);
  await settle();
  assert.equal(navigated.length, 1);
  const url = new URL(navigated[0]);
  assert.equal(url.searchParams.get("ejs"), "1");
  assert.equal(url.searchParams.get("p2"), "1");
  assert.equal(url.searchParams.get("id"), "g1");
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
