// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/fable/js/
// N0-f guest side: the native start sequence, failure without an EmulatorJS reboot, stop/cleanup,
// and the mixed-pair refusal that guestBackend + pairingProblem give before any answer goes out.
import test from "node:test";
import assert from "node:assert/strict";
import { fakePlugin, fakeIO } from "./fake-plugin.mjs";
import { toBase64, LockstepNative } from "./lockstep-native.js";
import { guestBackend, pairingProblem, BACKEND_NATIVE, BACKEND_EJS } from "./peer-block.js";
import { fnv1a64Hex } from "../../deepseek-v4/js/native-player.js";
import { createLockstep } from "../../../../src/lockstep.js";
import { bootNativeGuest, stopNativeGuest, nativeGuestActive, startGuestGame, LINK_GAME_ID } from "./native-guest.js";

const tick = () => new Promise((r) => setTimeout(r, 0));
const GAME = { name: "Test Game", file: "test.sfc", core: "snes" };
const BYTES = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) & 255);
const PAD = [{ type: "zone", id: "dpad" }];

// The netplay fake plus the session methods the guest start uses; every call is recorded in order.
function guestPlugin(opts = {}) {
  const plugin = fakePlugin(opts);
  const isAvailable = plugin.isAvailable;
  plugin.isAvailable = (args) => (plugin.calls.push({ method: "isAvailable", args }), isAvailable(args).then((r) => ({ ...r, core: "supafaust" })));
  plugin.deleteGame = (args) => (plugin.calls.push({ method: "deleteGame", args }), plugin.fail.deleteGame ? Promise.reject(plugin.fail.deleteGame) : Promise.resolve({ removedBytes: 0 }));
  plugin.start = (args) => {
    plugin.calls.push({ method: "start", args });
    if (plugin.fail.start) {
      plugin.emit("error", plugin.fail.start); // the plugin tears down, rejects AND emits (API.md §3)
      return Promise.reject(plugin.fail.start);
    }
    return Promise.resolve({ width: 256, height: 224, fps: 50 });
  };
  plugin.stop = (args) => (plugin.calls.push({ method: "stop", args }), Promise.resolve({ sramSaved: false }));
  plugin.setPadVisible = (args) => (plugin.calls.push({ method: "setPadVisible", args }), Promise.resolve({}));
  return plugin;
}

function env(plugin, { platform = "ios" } = {}) {
  const classes = new Set();
  const winListeners = [];
  const win = {
    Capacitor: { getPlatform: () => platform, Plugins: { NativePlayer: plugin } },
    addEventListener: (type, fn) => winListeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = winListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) winListeners.splice(i, 1);
    },
    fire: (type) => winListeners.filter((l) => l.type === type).forEach((l) => l.fn({})),
    listeners: winListeners,
  };
  const doc = {
    documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } },
    body: null, // no MutationObserver in these tests
    getElementById: () => null,
  };
  return { win, doc, classes };
}

test("guest start sequence: deleteGame(link) → start(link, persistSRAM:false, coreVersion, romBase64) → lockstepHold(true) → onStarted", async () => {
  const plugin = guestPlugin();
  const { win, doc, classes } = env(plugin);
  const order = [];
  let startedWith = null;
  const ok = await bootNativeGuest(GAME, BYTES, {
    pad: PAD,
    win,
    doc,
    onStarted: (p) => {
      startedWith = p;
      order.push(...plugin.names().slice(order.length), "onStarted");
    },
    onError: () => order.push("onError"),
  });
  assert.equal(ok, true);
  assert.equal(startedWith, plugin);
  assert.deepEqual(order, ["deleteGame", "isAvailable", "start", "lockstepHold", "onStarted"]);
  assert.deepEqual(plugin.calls[0].args, { gameId: LINK_GAME_ID });
  const start = plugin.calls[2].args;
  assert.equal(start.gameId, LINK_GAME_ID);
  assert.equal(start.persistSRAM, false);
  assert.equal(start.coreVersion, "642d1d1");
  assert.equal(start.system, "snes");
  assert.equal(start.core, "supafaust");
  assert.equal(start.romName, "test.sfc");
  assert.equal(start.romBase64, toBase64(BYTES), "always sent: hasRom is skipped, deleteGame ran first");
  assert.equal(start.hash, fnv1a64Hex(BYTES));
  assert.equal(start.pad, PAD);
  assert.deepEqual(plugin.calls[3].args, { hold: true });
  assert.equal(plugin.hold, true, "frozen until the host's state is loaded");
  assert.equal(classes.has("native"), true);
  assert.equal(nativeGuestActive(), true);
  await stopNativeGuest();
});

test("after onStarted the guest-link sequence follows: hold, booted, state → load → ready → lockstepStart(role 1) → hold(false)", async () => {
  const plugin = guestPlugin();
  const { win, doc } = env(plugin);
  const io = fakeIO();
  let sync = null;
  await bootNativeGuest(GAME, BYTES, {
    win,
    doc,
    onStarted: (target) => {
      // What guest-link.js's `started` does with the plugin it is handed (no window.nbNative on the guest page).
      sync = createLockstep(target, io, false, () => {});
      assert.ok(sync instanceof LockstepNative, "a native guest gets the native lockstep");
      sync.attach();
      sync.setHold(true);
      io.send({ t: "booted" });
    },
  });
  assert.deepEqual(io.sent, [{ t: "booted" }]);
  const state = Uint8Array.from([9, 8, 7]);
  await sync.onMessage({ t: "state", epoch: 1, size: 3 }, state);
  assert.deepEqual(plugin.names(), ["deleteGame", "isAvailable", "start", "lockstepHold", "lockstepHold", "loadStateBase64", "lockstepStart", "lockstepHold"]);
  assert.deepEqual(plugin.loaded, [toBase64(state)]);
  assert.deepEqual(io.sent[1], { t: "ready", epoch: 1 });
  assert.equal(plugin.calls[6].args.role, 1);
  assert.equal(plugin.calls[6].args.epoch, 1);
  assert.deepEqual(plugin.calls[7].args, { hold: false });
  assert.equal(plugin.hold, false);
  assert.equal(io.armed, 1, "heartbeat armed at lockstepStart (§7.1)");
  sync.detach();
  await stopNativeGuest();
});

test("a failed native start: onError once with the code, no onStarted, html.native dropped, session not active", async () => {
  const plugin = guestPlugin();
  plugin.fail.start = { code: "rom-rejected", message: "retro_load_game false" };
  const { win, doc, classes } = env(plugin);
  const errors = [];
  let started = 0;
  const ok = await bootNativeGuest(GAME, BYTES, { win, doc, onStarted: () => started++, onError: (code, message) => errors.push([code, message]) });
  await tick();
  assert.equal(ok, false);
  assert.equal(started, 0);
  assert.deepEqual(errors, [["rom-rejected", "retro_load_game false"]], "the error event and the rejection report once");
  assert.equal(classes.has("native"), false);
  assert.equal(nativeGuestActive(), false);
  assert.ok(!plugin.names().includes("lockstepHold"), "nothing after the failed start");
});

test("no native core for the system / no plugin: onError, nothing started", async () => {
  const plugin = guestPlugin({ available: false });
  const { win, doc } = env(plugin);
  const errors = [];
  assert.equal(await bootNativeGuest(GAME, BYTES, { win, doc, onError: (code) => errors.push(code) }), false);
  assert.deepEqual(errors, ["unavailable"]);
  assert.ok(!plugin.names().includes("start"));

  const none = env(null);
  const errors2 = [];
  assert.equal(await bootNativeGuest(GAME, BYTES, { win: none.win, doc: none.doc, onError: (code) => errors2.push(code) }), false);
  assert.deepEqual(errors2, ["unavailable"]);
});

test("a plugin error during the game reports onError once; stopNativeGuest stops and deletes the link copy", async () => {
  const plugin = guestPlugin();
  const { win, doc, classes } = env(plugin);
  const errors = [];
  await bootNativeGuest(GAME, BYTES, { win, doc, onError: (code) => errors.push(code) });
  plugin.emit("error", { code: "core-load", message: "crash" });
  plugin.emit("error", { code: "internal", message: "again" });
  assert.deepEqual(errors, ["core-load"]);
  await stopNativeGuest(); // what guest-link's end() → hooks.stopNative does
  assert.deepEqual(plugin.names().slice(-2), ["stop", "deleteGame"]);
  assert.equal(classes.has("native"), false);
  assert.equal(nativeGuestActive(), false);
  await stopNativeGuest(); // idempotent
  assert.deepEqual(plugin.names().slice(-2), ["stop", "deleteGame"]);
});

test("pagehide stops the native guest session", async () => {
  const plugin = guestPlugin();
  const { win, doc } = env(plugin);
  await bootNativeGuest(GAME, BYTES, { win, doc });
  win.fire("pagehide");
  await tick();
  await tick();
  assert.ok(plugin.names().includes("stop"));
  assert.equal(nativeGuestActive(), false);
});

test("startGuestGame: a native failure never reboots on EmulatorJS; the EJS guest boots as today", async () => {
  let ejsBoots = 0;
  const errors = [];
  await startGuestGame({
    native: true,
    game: GAME,
    bytes: BYTES,
    boot: () => ejsBoots++,
    bootNative: async (game, bytes, { onError }) => {
      onError("core-load");
      throw { code: "core-load" }; // a hook that both reports and rejects still counts once
    },
    onStarted: () => assert.fail("not started"),
    onError: (code) => errors.push(code),
  });
  assert.deepEqual(errors, ["core-load"]);
  assert.equal(ejsBoots, 0, "no EmulatorJS after pairing on the native backend");

  // A hook that only rejects is reported too.
  errors.length = 0;
  await startGuestGame({ native: true, game: GAME, bytes: BYTES, boot: () => ejsBoots++, bootNative: async () => { throw new Error("boom"); }, onStarted: () => {}, onError: (code) => errors.push(code) });
  assert.equal(errors.length, 1);
  assert.equal(ejsBoots, 0);

  // EJS guest (Android, or an EJS host): boot(game, Blob, onStart) exactly as before N0-f.
  const log = [];
  await startGuestGame({
    native: false,
    game: GAME,
    bytes: BYTES,
    boot: (game, blob, onStart) => {
      assert.equal(game, GAME);
      assert.ok(blob instanceof Blob);
      assert.equal(blob.size, BYTES.length);
      log.push("boot");
      onStart({ gameManager: {} });
    },
    bootNative: () => assert.fail("native hook must not run for an EJS guest"),
    onStarted: () => log.push("started"),
    onEjsStarted: () => log.push("armed"),
    onError: () => assert.fail("no error"),
  });
  assert.deepEqual(log, ["boot", "started", "armed"]);
});

test("mixed pair is refused before answering: Android guest vs native host → mismatch; same-version iPhones pair; EJS–EJS pairs", async () => {
  const hostPeer = { backend: BACKEND_NATIVE, system: "snes", coreVersion: "642d1d1", appVersion: "1.0.0+1" };
  const plugin = guestPlugin();
  const android = env(plugin, { platform: "android" }).win;
  android.localStorage = { getItem: () => null };
  android.location = { search: "?join" };
  const androidGuest = await guestBackend(hostPeer, { canBootNative: true, win: android });
  assert.equal(androidGuest.backend, BACKEND_EJS, "Android has no native player");
  assert.equal(pairingProblem(androidGuest, hostPeer), "mismatch");

  const iphone = env(plugin).win;
  iphone.localStorage = { getItem: () => null };
  iphone.location = { search: "?join" };
  const iphoneGuest = await guestBackend(hostPeer, { canBootNative: true, win: iphone });
  assert.deepEqual(iphoneGuest, { ...hostPeer });
  assert.equal(pairingProblem(iphoneGuest, hostPeer), null);

  // A different app build on the other iPhone is refused as well.
  assert.equal(pairingProblem(iphoneGuest, { ...hostPeer, appVersion: "1.0.1+2" }), "mismatch");
  // Without the N0-f hook (no way to boot natively) the guest is EJS and a native host refuses it.
  const noHook = await guestBackend(hostPeer, { canBootNative: false, win: iphone });
  assert.equal(pairingProblem(noHook, hostPeer), "mismatch");
  // Android host (no block) + any guest: EJS–EJS, today's path.
  const ejsGuest = await guestBackend(null, { canBootNative: true, win: iphone });
  assert.equal(pairingProblem(ejsGuest, null), null);
});
