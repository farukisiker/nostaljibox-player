// SPDX-License-Identifier: GPL-3.0-or-later
// JS side of the iOS native player bridge: decides whether a game can run in the native
// player and boots it. Contract: docs/native-player/API.md §3, §4, §5, §8; plan: PLAN.md
// §1.6, §2.3. Plain ES module, no dependencies, no build step.
import { detectSystem } from "../shared/systems.js";

// Archive types the native side can open. Kept in step with the plugin's `containers`.
export const NATIVE_CONTAINERS = { zip: true, "7z": false };

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"
const SEVEN_ZIP_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]; // "7z\xBC\xAF\x27\x1C"
// Archives the native side cannot open; anything not listed here is treated as a raw ROM.
const OTHER_ARCHIVES = new Set(["7z", "gz", "tgz", "rar", "tar", "bz2", "tbz", "xz", "txz", "zst", "lz", "lzma", "z", "cab", "arj", "ace"]);

function asBytes(value) {
  if (!value) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(0);
}

// ROMs are stored in IndexedDB as ArrayBuffers, but a Blob is handled as well.
async function toBytes(value) {
  if (value && typeof Blob !== "undefined" && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return asBytes(value);
}

function extensionOf(name) {
  const base = String(name || "").split(/[\\/]/).pop();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function startsWith(bytes, magic) {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

/** "zip" | "7z" | "raw" | "unknown" — magic bytes first, then the file extension. */
export function containerOf(bytes, name) {
  const b = asBytes(bytes);
  if (startsWith(b, ZIP_MAGIC)) return "zip";
  if (startsWith(b, SEVEN_ZIP_MAGIC)) return "7z";
  const ext = extensionOf(name);
  if (ext === "zip") return "zip";
  if (ext === "7z") return "7z";
  if (!ext || OTHER_ARCHIVES.has(ext)) return "unknown";
  return "raw";
}

const U32 = 0x100000000;
const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_HI = 0x00000100;
const FNV_PRIME_LO = 0x000001b3;

// 32 × 32 → 64-bit product as [hi, lo], both unsigned 32-bit Numbers. Doubles hold every
// intermediate exactly (< 2^53), so no BigInt is needed: hashing 6 MB stays a few tens of ms.
function mul32(a, b) {
  const a0 = a & 0xffff, a1 = a >>> 16;
  const b0 = b & 0xffff, b1 = b >>> 16;
  const low = a0 * b0; // < 2^32
  const mid = a1 * b0 + a0 * b1; // < 2^33
  const high = a1 * b1; // < 2^32
  const sum = low + (mid % 0x10000) * 0x10000; // < 2^33
  const carry = Math.floor(sum / U32);
  return [(high + Math.floor(mid / 0x10000) + carry) % U32, sum - carry * U32];
}

function hex8(n) {
  return (n >>> 0).toString(16).padStart(8, "0");
}

/** FNV-1a 64 of the bytes, lowercase hex, 16 chars (the `hash` the plugin caches ROMs by). */
export function fnv1a64Hex(bytes) {
  const b = asBytes(bytes);
  let hi = FNV_OFFSET_HI;
  let lo = FNV_OFFSET_LO;
  for (let i = 0; i < b.length; i++) {
    lo = (lo ^ b[i]) >>> 0;
    const byLow = mul32(lo, FNV_PRIME_LO);
    const byHi = mul32(hi, FNV_PRIME_LO);
    const shifted = mul32(lo, FNV_PRIME_HI);
    lo = byLow[1];
    hi = (byLow[0] + byHi[1] + shifted[1]) % U32;
  }
  return hex8(hi) + hex8(lo);
}

function capacitor() {
  return globalThis.window?.Capacitor ?? null;
}

function nativePlugin() {
  return capacitor()?.Plugins?.NativePlayer ?? null;
}

function flag() {
  try {
    return globalThis.localStorage?.getItem("nb_native") || "auto";
  } catch {
    return "auto";
  }
}

// Per PLAN §1.5 (2): a WebContent reload leaves the last native session orphaned, so every
// page load stops it once. bootNative waits for this before starting a new one.
const orphanCleanup = (() => {
  const plugin = nativePlugin();
  if (!plugin) return Promise.resolve();
  try {
    return Promise.resolve(plugin.stop()).catch(() => {});
  } catch {
    return Promise.resolve();
  }
})();

/**
 * True when this game should run in the native player. Never throws; on anything unexpected
 * it answers false and EmulatorJS stays in charge. "on" behaves like "auto": a container the
 * native side cannot open (or a system it lacks) still goes to EmulatorJS.
 */
export async function useNative(game, params, rom) {
  try {
    if (!game || !rom) return false;
    const cap = capacitor();
    if (!cap || cap.getPlatform?.() !== "ios") return false;
    const plugin = nativePlugin();
    if (!plugin) return false;
    if (flag() === "off") return false;
    if (params?.has?.("ejs") || params?.has?.("join")) return false;
    const bytes = await toBytes(rom);
    const container = containerOf(bytes, game.file || game.name);
    if (container !== "raw" && !NATIVE_CONTAINERS[container]) return false;
    const info = await plugin.isAvailable({ system: game.core });
    if (!info || !info.available) return false;
    if (container === "zip" && !(info.containers || []).includes("zip")) return false;
    return true;
  } catch {
    return false;
  }
}

// base64 in chunks that are a multiple of 3 bytes, so the pieces can simply be concatenated.
function toBase64(bytes, chunkSize = 3 * 8192) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    parts.push(btoa(String.fromCharCode.apply(null, slice)));
  }
  return parts.join("");
}

// ZIPs are stored raw; the native side wants the inner ROM's name (PLAN §1.6). detectSystem
// already knows how to read the central directory and map the extension to a system.
async function romNameOf(game, bytes) {
  const name = game.file || game.name || "game";
  if (containerOf(bytes, name) !== "zip") return name;
  try {
    const { inner } = await detectSystem(name, bytes);
    if (inner) return inner.split(/[\\/]/).pop();
  } catch {
    // fall through
  }
  return name;
}

let errorHandle = null;
let stopping = null;

async function removeErrorListener() {
  const handle = errorHandle;
  errorHandle = null;
  try {
    await handle?.remove?.();
  } catch {
    // the plugin may already be gone
  }
}

/** Stops the native session, if any. Idempotent and never throws; always drops `html.native`. */
export function stopNative() {
  if (typeof document !== "undefined") document.documentElement?.classList?.remove("native");
  const plugin = nativePlugin();
  if (!plugin) return Promise.resolve();
  if (stopping) return stopping;
  stopping = Promise.resolve()
    .then(() => removeErrorListener())
    .then(() => plugin.stop())
    .catch(() => {})
    .then(() => {
      stopping = null;
    });
  return stopping;
}

/**
 * Hands the game to the native player. On a plugin `error` (or a rejected `start`) it tears the
 * session down, drops `html.native` and calls `onFallback()` exactly once.
 */
export async function bootNative(game, rom, { pad, onFallback } = {}) {
  const plugin = nativePlugin();
  if (!plugin) {
    try {
      onFallback?.();
    } catch {
      // nothing to do
    }
    return false;
  }
  if (typeof document !== "undefined") document.documentElement.classList.add("native");

  let fellBack = false;
  const fallBack = async (code, message) => {
    if (fellBack) return;
    fellBack = true;
    if (typeof document !== "undefined") document.documentElement.classList.remove("native");
    await removeErrorListener();
    await stopNative();
    try {
      onFallback?.(code, message);
    } catch {
      // a failing fallback must not reject this one
    }
  };
  const onError = (ev) => {
    fallBack(ev?.code, ev?.message);
  };

  try {
    try {
      errorHandle = (await plugin.addListener("error", onError)) || null;
    } catch {
      errorHandle = null;
    }

    const bytes = await toBytes(rom);
    const hash = fnv1a64Hex(bytes);
    const romName = await romNameOf(game, bytes);

    await orphanCleanup;

    const info = await plugin.isAvailable({ system: game.core }).catch(() => null);
    const core = info?.core || game.core;

    // Only send the ROM when the plugin does not have it cached under this hash (PLAN §1.6).
    let romBase64;
    try {
      const cached = await plugin.hasRom({ gameId: game.id, size: bytes.length, hash });
      if (!cached?.cached) romBase64 = toBase64(bytes);
    } catch {
      romBase64 = toBase64(bytes);
    }

    await plugin.start({
      gameId: game.id,
      system: game.core,
      core,
      romName,
      ...(romBase64 ? { romBase64 } : {}),
      hash,
      pad,
      scaling: "fit",
      showPad: true,
      // M1 test build: the stats label is how the device test reads fps, footprint and thermal.
      showStats: true,
    });
    return true;
  } catch (e) {
    await fallBack(e?.code, e?.message ?? String(e));
    return false;
  }
}
