// SPDX-License-Identifier: GPL-3.0-or-later
// Finds the ROM inside a ZIP for the native player (PLAN §1.6: Swift needs the inner file name,
// with its extension, because cores choose by it). shared/systems.js `detectSystem` only reports an
// inner name for extensions it maps to a console, so a Mega Drive / Master System ZIP that holds a
// plain `.bin` comes back without one; this reads the central directory itself.
import { listZipEntries } from "../../../../shared/unzip.js";
import { byCore } from "../../../../shared/systems.js";
import { containerOf } from "../../deepseek-v4/js/native-player.js";

// Generic ROM extensions the console tables do not claim (`bin` is how many Mega Drive, Master
// System and Game Gear sets ship).
const GENERIC_ROM_EXTS = ["bin", "rom"];

const baseName = (path) => String(path).split(/[\\/]/).pop();
const extOf = (path) => {
  const base = baseName(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

async function toBytes(value) {
  if (!value) return new Uint8Array(0);
  if (typeof Blob !== "undefined" && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(0);
}

/**
 * The name of the ROM to hand to the plugin for this game.
 *   - not a ZIP:            "" (the caller keeps game.file)
 *   - a ZIP with a ROM:     the entry's file name, without folders (`roms/Sonic.bin` → `Sonic.bin`)
 *   - a ZIP without one:    null (unreadable archive or only .txt/.jpg files: let EmulatorJS handle it)
 * Entries with one of the game's console extensions win over generic `.bin`/`.rom` ones;
 * macOS `__MACOSX/` resource forks and dot files are skipped.
 */
export async function zipRomName(game, rom) {
  const bytes = await toBytes(rom);
  if (containerOf(bytes, game?.file || game?.name) !== "zip") return "";
  let entries;
  try {
    entries = listZipEntries(bytes);
  } catch {
    return null;
  }
  const usable = entries.filter((entry) => !/(^|[\\/])__MACOSX[\\/]/.test(entry) && !baseName(entry).startsWith("."));
  const own = byCore[game?.core]?.exts ?? [];
  const pick = (exts) => usable.find((entry) => exts.includes(extOf(entry)));
  const found = pick(own) ?? pick(GENERIC_ROM_EXTS);
  return found ? baseName(found) : null;
}
