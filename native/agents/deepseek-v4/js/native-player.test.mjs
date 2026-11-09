// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/deepseek-v4/js/native-player.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { containerOf, fnv1a64Hex, useNative, NATIVE_CONTAINERS } from "./native-player.js";

const bytes = (...parts) => {
  const out = [];
  for (const part of parts) {
    if (typeof part === "string") out.push(...new TextEncoder().encode(part));
    else out.push(...part);
  }
  return new Uint8Array(out);
};

// Straightforward BigInt implementation of FNV-1a 64, used as the reference.
function fnvReference(data) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of data) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

test("containerOf: magic bytes win over the extension", () => {
  assert.equal(containerOf(bytes("PK\x03\x04rest"), "game.bin"), "zip");
  assert.equal(containerOf(bytes([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00]), "game.zip"), "7z");
});

test("containerOf: extension fallback", () => {
  assert.equal(containerOf(bytes("not really a zip"), "game.zip"), "zip");
  assert.equal(containerOf(bytes("nope"), "game.7z"), "7z");
  assert.equal(containerOf(bytes("rom data"), "game.sfc"), "raw");
  assert.equal(containerOf(bytes("rom data"), "folder/game.SMC"), "raw");
  assert.equal(containerOf(bytes("rom data"), "game"), "unknown");
  assert.equal(containerOf(bytes("rom data"), "game.rar"), "unknown");
  assert.equal(containerOf(new Uint8Array(0), ""), "unknown");
});

test("containerOf: archive table", () => {
  assert.equal(NATIVE_CONTAINERS.zip, true);
  assert.equal(NATIVE_CONTAINERS["7z"], false);
});

test("fnv1a64Hex: known vectors", () => {
  assert.equal(fnv1a64Hex(bytes("")), "cbf29ce484222325");
  assert.equal(fnv1a64Hex(bytes("a")), "af63dc4c8601ec8c");
  assert.equal(fnv1a64Hex(new Uint8Array(0)), "cbf29ce484222325");
});

test("fnv1a64Hex: matches the BigInt reference on varied inputs", () => {
  const samples = [
    bytes("hello"),
    bytes("NostaljiBox"),
    bytes([0x00]),
    bytes([0xff, 0xff, 0xff, 0xff, 0x00, 0x7f, 0x80]),
  ];
  const long = new Uint8Array(1000);
  for (let i = 0; i < long.length; i++) long[i] = (i * 37 + 11) & 0xff;
  samples.push(long);
  for (const sample of samples) {
    const hex = fnv1a64Hex(sample);
    assert.match(hex, /^[0-9a-f]{16}$/);
    assert.equal(hex, fnvReference(sample));
  }
});

test("fnv1a64Hex: accepts ArrayBuffer and views with offsets", () => {
  const all = bytes("xxhello");
  const view = new Uint8Array(all.buffer, 2, 5);
  assert.equal(fnv1a64Hex(view), fnv1a64Hex(bytes("hello")));
  assert.equal(fnv1a64Hex(bytes("hello").buffer), fnv1a64Hex(bytes("hello")));
});

test("useNative: false when there is no Capacitor", async () => {
  const saved = {
    window: globalThis.window,
    localStorage: globalThis.localStorage,
  };
  globalThis.window = {};
  globalThis.localStorage = { getItem: () => null };
  try {
    const game = { id: "g1", core: "snes", file: "game.sfc" };
    const rom = bytes("rom");
    assert.equal(await useNative(game, new URLSearchParams(), rom), false);
  } finally {
    globalThis.window = saved.window;
    globalThis.localStorage = saved.localStorage;
  }
});

test("useNative: false on other platforms, with the flag off or on the EmulatorJS params", async () => {
  const saved = {
    window: globalThis.window,
    localStorage: globalThis.localStorage,
  };
  const availability = { available: true, core: "supafaust", containers: ["zip"] };
  try {
    const rom = bytes("rom");
    const game = { id: "g1", core: "snes", file: "game.sfc" };

    globalThis.localStorage = { getItem: () => null };
    globalThis.window = { Capacitor: { getPlatform: () => "android", Plugins: { NativePlayer: { isAvailable: async () => availability } } } };
    assert.equal(await useNative(game, new URLSearchParams(), rom), false);

    globalThis.window = { Capacitor: { getPlatform: () => "ios", Plugins: { NativePlayer: { isAvailable: async () => availability } } } };
    assert.equal(await useNative(game, new URLSearchParams(), rom), true);
    assert.equal(await useNative(game, new URLSearchParams("ejs=1"), rom), false);
    // N0-f: ?join no longer forces EmulatorJS (the guest's own gate is guestBackend in peer-block.js).
    assert.equal(await useNative(game, new URLSearchParams("join"), rom), true);

    globalThis.localStorage = { getItem: (key) => (key === "nb_native" ? "off" : null) };
    assert.equal(await useNative(game, new URLSearchParams(), rom), false);

    globalThis.localStorage = { getItem: () => null };
    // .7z and unknown containers never go native, even though the system is available.
    assert.equal(await useNative({ ...game, file: "game.7z" }, new URLSearchParams(), rom), false);
    // Confirmed zip support comes from the plugin's `containers`.
    globalThis.window = { Capacitor: { getPlatform: () => "ios", Plugins: { NativePlayer: { isAvailable: async () => ({ ...availability, containers: [] }) } } } };
    assert.equal(await useNative({ ...game, file: "game.zip" }, new URLSearchParams(), bytes("PK\x03\x04zip")), false);
    // An unavailable system stays on EmulatorJS.
    globalThis.window = { Capacitor: { getPlatform: () => "ios", Plugins: { NativePlayer: { isAvailable: async () => ({ available: false, containers: ["zip"] }) } } } };
    assert.equal(await useNative(game, new URLSearchParams(), rom), false);
  } finally {
    globalThis.window = saved.window;
    globalThis.localStorage = saved.localStorage;
  }
});

test("useNative: a throwing plugin never breaks boot", async () => {
  const saved = {
    window: globalThis.window,
    localStorage: globalThis.localStorage,
  };
  globalThis.localStorage = { getItem: () => null };
  globalThis.window = {
    Capacitor: {
      getPlatform: () => "ios",
      Plugins: {
        NativePlayer: {
          isAvailable: async () => {
            throw new Error("kaput");
          },
        },
      },
    },
  };
  try {
    assert.equal(await useNative({ id: "g1", core: "snes", file: "game.sfc" }, new URLSearchParams(), bytes("rom")), false);
  } finally {
    globalThis.window = saved.window;
    globalThis.localStorage = saved.localStorage;
  }
});
