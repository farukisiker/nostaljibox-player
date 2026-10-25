// SPDX-License-Identifier: MIT — part of nostaljibox-player/shared, usable outside the GPL player.
import { listZipEntries } from "./unzip.js";

// Consoles NostaljiBox can run. `core` is the EmulatorJS system key (see player/cores.json for the
// bundled libretro cores). Order is the display order in the library.
export const SYSTEMS = [
  { core: "nes", name: "Nintendo (NES)", short: "NES", color: "#e4002b", exts: ["nes", "fds", "unf", "unif"] },
  { core: "snes", name: "Super Nintendo", short: "SNES", color: "#6b4fbb", exts: ["smc", "sfc", "swc", "fig", "bs"] },
  { core: "n64", name: "Nintendo 64", short: "N64", color: "#009e49", exts: ["n64", "z64", "v64"] },
  { core: "gb", name: "Game Boy / Color", short: "GB", color: "#8b9a2a", exts: ["gb", "gbc", "dmg"] },
  { core: "gba", name: "Game Boy Advance", short: "GBA", color: "#4b3fa0", exts: ["gba", "agb"] },
  { core: "nds", name: "Nintendo DS", short: "NDS", color: "#5a6270", exts: ["nds"] },
  { core: "psx", name: "PlayStation", short: "PS1", color: "#2f5dab", exts: ["cue", "chd", "pbp", "iso", "img", "ccd", "m3u", "toc", "mds"] },
  { core: "segaMD", name: "Sega Mega Drive / Genesis", short: "MD", color: "#1b1b1b", exts: ["md", "gen", "smd", "68k", "sgd"] },
  { core: "segaMS", name: "Sega Master System", short: "SMS", color: "#c8102e", exts: ["sms"] },
  { core: "segaGG", name: "Sega Game Gear", short: "GG", color: "#2a2a2a", exts: ["gg"] },
  { core: "pce", name: "PC Engine / TurboGrafx-16", short: "PCE", color: "#e87722", exts: ["pce", "sgx"] },
  { core: "atari2600", name: "Atari 2600", short: "2600", color: "#a0522d", exts: ["a26"] },
  { core: "atari7800", name: "Atari 7800", short: "7800", color: "#8b4513", exts: ["a78"] },
  { core: "lynx", name: "Atari Lynx", short: "LYNX", color: "#d2691e", exts: ["lnx"] },
  { core: "ngp", name: "Neo Geo Pocket", short: "NGP", color: "#004b8d", exts: ["ngp", "ngc"] },
  { core: "ws", name: "WonderSwan", short: "WS", color: "#0091d0", exts: ["ws", "wsc"] },
  { core: "vb", name: "Virtual Boy", short: "VB", color: "#b5121b", exts: ["vb", "vboy"] },
];

export const byCore = Object.fromEntries(SYSTEMS.map((s) => [s.core, s]));

const extMap = new Map();
for (const s of SYSTEMS) for (const e of s.exts) extMap.set(e, s.core);

export const ACCEPT = [...extMap.keys(), "zip", "7z", "bin"].map((e) => "." + e).join(",");

const extOf = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");

function ascii(bytes, start, len) {
  return String.fromCharCode(...bytes.subarray(start, start + len));
}

// A raw .bin can be a Mega Drive cartridge, a PlayStation disc track or an Atari 2600 cartridge.
function sniffBin(bytes) {
  const sync = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
  if (sync.every((b, i) => bytes[i] === b)) return "psx";
  if (bytes.length > 0x110 && ascii(bytes, 0x100, 4) === "SEGA") return "segaMD";
  if (bytes.length > 0x8000 + 6 && ascii(bytes, 0x8001, 5) === "CD001") return "psx";
  if (bytes.length >= 4 * 1024 * 1024) return "psx";
  if (bytes.length <= 64 * 1024) return "atari2600";
  return "segaMD";
}

// Header checks for files whose extension is missing or wrong.
function sniffHeader(bytes) {
  if (ascii(bytes, 0, 4) === "NES\x1a") return "nes";
  if (bytes.length > 0x110 && ascii(bytes, 0x100, 4) === "SEGA") return "segaMD";
  if (bytes.length > 0xc0 && bytes[0xb2] === 0x96) return "gba";
  const n64 = bytes[0] === 0x80 && bytes[1] === 0x37 && bytes[2] === 0x12 && bytes[3] === 0x40;
  if (n64) return "n64";
  return null;
}

/**
 * Guess the console for a file. Returns { core, inner } where inner is the ROM name inside a zip,
 * or { core: null } when it cannot tell (the UI then asks the player).
 */
export async function detectSystem(name, bytes) {
  let ext = extOf(name);
  if (ext === "zip") {
    let entries = [];
    try {
      entries = listZipEntries(bytes);
    } catch {
      return { core: null };
    }
    for (const entry of entries) {
      const core = extMap.get(extOf(entry));
      if (core) return { core, inner: entry };
    }
    if (entries.some((e) => extOf(e) === "bin")) {
      // Multi-track discs ship as .bin files without a recognised index file.
      return { core: "psx" };
    }
    return { core: null };
  }
  if (ext === "bin") return { core: sniffBin(bytes) };
  if (extMap.has(ext)) return { core: extMap.get(ext) };
  return { core: sniffHeader(bytes) };
}
