// SPDX-License-Identifier: MIT — used by shared/link.js, so it stays usable outside the GPL player.
// Pairing version block (NETPLAY.md §1.1): the invite and the answer each say which backend the phone
// will play on and, for the native player, which core build and app version. Two phones pair only
// when the blocks agree; the guest decides before answering, the host verifies the answer.
//
// Compact code (NB3) layout, right after the inbox block (which the new encoder always writes):
//   0x50 + version (one tag byte; v1 = 0x51), backend, system, coreVersion[7] (ASCII, 0-padded),
//   appLen, appVersion bytes. Old decoders stop after the inbox block and never see the tag.
// Long form (NB1 JSON) carries the same thing as `p: { b, s, c, a }`.

export const PEER_TAG = 0x50;
export const PEER_VERSION = 1;
export const BACKEND_EJS = 0;
export const BACKEND_NATIVE = 1;
const CORE_VERSION_LEN = 7;

// One byte per system (shared/systems.js order); 0 = unknown.
const SYSTEMS = [
  "", "nes", "snes", "n64", "gb", "gba", "nds", "psx", "segaMD", "segaMS", "segaGG", "pce",
  "atari2600", "atari7800", "lynx", "ngp", "ws", "vb",
];

export const systemCode = (name) => Math.max(0, SYSTEMS.indexOf(name || ""));
export const systemName = (code) => SYSTEMS[code] || "";

const ascii = (s, max) => [...String(s || "")].map((c) => c.charCodeAt(0) & 0x7f).slice(0, max);

// The peer this phone announces: native when a native session (plugin) is active, EJS otherwise.
export async function localPeer({ plugin, system }) {
  if (plugin) {
    const info = (await plugin.isAvailable({ system }).catch(() => null)) || {};
    return { backend: BACKEND_NATIVE, system, coreVersion: String(info.version || ""), appVersion: String(info.appVersion || "") };
  }
  return { backend: BACKEND_EJS, system, coreVersion: "", appVersion: "" };
}

export function packPeer(peer) {
  const core = ascii(peer.coreVersion, CORE_VERSION_LEN);
  while (core.length < CORE_VERSION_LEN) core.push(0);
  const app = ascii(peer.appVersion, 255);
  return [PEER_TAG + PEER_VERSION, peer.backend ? 1 : 0, systemCode(peer.system), ...core, app.length, ...app];
}

// { peer, end } when a v1 block starts at bytes[i]; null for anything else (old or foreign tail).
export function unpackPeer(bytes, i) {
  // tag, backend, system, coreVersion[7], appLen = 11 bytes before the app string
  if (bytes[i] !== PEER_TAG + PEER_VERSION || i + 4 + CORE_VERSION_LEN > bytes.length) return null;
  const backend = bytes[i + 1] ? BACKEND_NATIVE : BACKEND_EJS;
  const system = systemName(bytes[i + 2]);
  const core = bytes.subarray(i + 3, i + 3 + CORE_VERSION_LEN);
  const coreVersion = String.fromCharCode(...core).replace(/\0+$/, "");
  let j = i + 3 + CORE_VERSION_LEN;
  const appLen = bytes[j++];
  if (j + appLen > bytes.length) return null;
  const appVersion = String.fromCharCode(...bytes.subarray(j, j + appLen));
  return { peer: { backend, system, coreVersion, appVersion }, end: j + appLen };
}

export const peerToLong = (peer) => ({ b: peer.backend ? 1 : 0, s: peer.system || "", c: peer.coreVersion || "", a: peer.appVersion || "" });

export function peerFromLong(p) {
  if (!p || typeof p !== "object") return null;
  return { backend: p.b ? BACKEND_NATIVE : BACKEND_EJS, system: String(p.s || ""), coreVersion: String(p.c || ""), appVersion: String(p.a || "") };
}

// null = the pair can play; "mismatch" = different backend or native version; "legacy" = the other
// side sent no block (old app) while this side is native. Two EJS phones always pair, as today.
export function pairingProblem(mine, theirs) {
  if (!theirs) return mine && mine.backend === BACKEND_NATIVE ? "legacy" : null;
  if ((mine?.backend ?? BACKEND_EJS) !== theirs.backend) return "mismatch";
  if (theirs.backend === BACKEND_EJS) return null;
  return mine.coreVersion === theirs.coreVersion && mine.appVersion === theirs.appVersion ? null : "mismatch";
}

// Short text for the refusal message: "iPhone 1.2.3+45 (642d1d1)", "classic player", "older version".
export function describePeer(peer, words = {}) {
  if (!peer) return words.old || "older version";
  if (peer.backend === BACKEND_NATIVE) return `iPhone ${peer.appVersion || "?"} (${peer.coreVersion || "?"})`;
  return words.ejs || "classic player";
}

// The guest's own backend for the host's invite (NETPLAY.md §1.1 / R2-3): `window.nbNative` is not
// set yet at `?join`, so the native player's gates are applied directly: iOS, `nb_native` not "off",
// no `?ejs`, `isAvailable({ system })`. `canBootNative` is whether the page can start a native guest
// session at all (N0-f hook); without it the guest is an EJS peer, exactly as today. Never throws.
export async function guestBackend(peer, { canBootNative = false, win = globalThis.window, params } = {}) {
  const system = peer?.system || "";
  const ejs = { backend: BACKEND_EJS, system, coreVersion: "", appVersion: "" };
  try {
    if (!canBootNative || !win) return ejs;
    const cap = win.Capacitor;
    if (!cap || cap.getPlatform?.() !== "ios") return ejs;
    const plugin = cap.Plugins?.NativePlayer;
    if (!plugin) return ejs;
    let flag = "auto";
    try {
      flag = win.localStorage?.getItem("nb_native") || "auto";
    } catch {
      // storage blocked: treat as auto
    }
    if (flag === "off") return ejs;
    const search = params || new URLSearchParams(win.location?.search || "");
    if (search.has("ejs")) return ejs;
    const info = await plugin.isAvailable({ system });
    if (!info || !info.available) return ejs;
    return { backend: BACKEND_NATIVE, system, coreVersion: String(info.version || ""), appVersion: String(info.appVersion || "") };
  } catch {
    return ejs;
  }
}
