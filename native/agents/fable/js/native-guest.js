// SPDX-License-Identifier: GPL-3.0-or-later
// Guest side of native two-phone play (NETPLAY.md §5, N0-f): the game the host sent is opened in
// the native player instead of EmulatorJS, under the throw-away id `nostaljibox-link`, with the
// cartridge RAM kept out of this phone's saves (`persistSRAM: false`), frozen as soon as it runs
// (`lockstepHold(true)`) until the host's savestate arrives. guest-link.js calls `bootNativeGuest`
// through its `hooks.bootNative` seam and `stopNativeGuest` when the link ends; play.js wires both.
//
// Unlike the host path (sonnet-5-5/js/native-mode.js → deepseek-v4/js/native-player.js) there is no
// EmulatorJS fallback: a native host only pairs with a native guest (§1.1), so a failure here ends
// the session (`onError` → guest-link's abort → library). The ROM is always sent to the plugin
// (`hasRom` is skipped): `deleteGame` runs first, so there is never a cached copy.
import { fnv1a64Hex } from "../../deepseek-v4/js/native-player.js";
import { zipRomName } from "../../sonnet-5-5/js/zip-rom.js";
import { OVERLAY_IDS } from "../../sonnet-5-5/js/native-mode.js";
import { toBase64 } from "./lockstep-native.js";
import { once } from "./guards.js";

export const LINK_GAME_ID = "nostaljibox-link";

let session = null; // { plugin, cleanup } while a native guest session runs

function pluginOf(win) {
  return win?.Capacitor?.Plugins?.NativePlayer ?? null;
}

function isShown(el) {
  return !!el && !el.hidden && !el.classList?.contains("hidden") && el.style?.display !== "none";
}

// The native pad sits above the WebView: hide it while a page panel (tools, error…) is open.
function watchOverlays(plugin, doc, win) {
  const MO = win?.MutationObserver || globalThis.MutationObserver;
  if (typeof MO !== "function" || !doc?.body) return () => {};
  let visible = true;
  const sync = () => {
    const want = !OVERLAY_IDS.some((id) => isShown(doc.getElementById(id)));
    if (want === visible) return;
    visible = want;
    try {
      Promise.resolve(plugin.setPadVisible({ visible: want })).catch(() => {});
    } catch {
      // no session any more
    }
  };
  const observer = new MO(sync);
  observer.observe(doc.body, { attributes: true, attributeFilter: ["class", "hidden", "style"], subtree: true, childList: true });
  sync();
  return () => observer.disconnect();
}

// The tools panel's "game menu" button opens EmulatorJS's menu, which does not exist on a native
// guest page (no native menu either: it is the host page's, N0-f OPEN 2). Hide it while the native
// guest runs; the inline style wins over play.css's `display: flex`. Returns the restore function.
function hideMenuButton(doc) {
  const button = doc?.getElementById?.("emu-menu");
  if (!button || !button.style) return () => {};
  const before = button.style.display;
  button.style.display = "none";
  return () => {
    button.style.display = before;
  };
}

/**
 * Opens the host's game in the native player as the guest.
 *
 * Order (tested): error listener → deleteGame(nostaljibox-link) → start({ gameId: nostaljibox-link,
 * romBase64, persistSRAM: false, coreVersion }) → lockstepHold(true) → onStarted(plugin).
 * `onError(code, message)` fires at most once, for a failed start or a later plugin `error`;
 * the plugin has torn the session down by then (API.md §3 `start`). Resolves true when the game
 * runs, false otherwise; never rejects.
 */
export async function bootNativeGuest(game, bytes, { onStarted, onError, pad, win = globalThis.window, doc = globalThis.document } = {}) {
  const plugin = pluginOf(win);
  const fail = once((code, message) => {
    doc?.documentElement?.classList?.remove("native");
    try {
      onError?.(String(code || "internal"), message);
    } catch {
      // a failing callback must not reject the boot
    }
  });
  if (!plugin) {
    fail("unavailable", "native player missing");
    return false;
  }
  if (session) await stopNativeGuest(); // a second `rom` on the same page: one session at a time

  let errorHandle = null;
  try {
    errorHandle = (await plugin.addListener("error", (ev) => fail(ev?.code, ev?.message))) || null;
  } catch {
    errorHandle = null;
  }
  let unwatch = () => {};
  let showMenu = () => {};
  const cleanup = () => {
    unwatch();
    unwatch = () => {};
    showMenu();
    showMenu = () => {};
    doc?.documentElement?.classList?.remove("native");
    Promise.resolve(errorHandle)
      .then((h) => h && h.remove && h.remove())
      .catch(() => {});
    errorHandle = null;
  };
  session = { plugin, cleanup };
  const onPageHide = () => stopNativeGuest();
  win?.addEventListener?.("pagehide", onPageHide);

  try {
    // Whatever a killed app left behind under this id goes first (§5 disk reality).
    await Promise.resolve(plugin.deleteGame({ gameId: LINK_GAME_ID })).catch(() => {});
    const inner = await zipRomName(game, bytes);
    if (inner === null) throw { code: "rom-rejected", message: "no ROM inside the archive" };
    const info = (await Promise.resolve(plugin.isAvailable({ system: game.core })).catch(() => null)) || {};
    if (!info.available) throw { code: "unavailable", message: `no native core for ${game.core}` };
    doc?.documentElement?.classList?.add("native");
    await plugin.start({
      gameId: LINK_GAME_ID,
      system: game.core,
      core: info.core || game.core,
      romName: inner || game.file || game.name || "game",
      romBase64: toBase64(bytes),
      hash: fnv1a64Hex(bytes),
      pad,
      scaling: "fit",
      showPad: true,
      showStats: true,
      persistSRAM: false, // never touch this phone's .srm for the host's game (§7 SRAM)
      coreVersion: String(info.version || ""), // the pairing already matched it (§1.1)
    });
    if (fail.done || session?.plugin !== plugin) return false; // an error event or a stop raced the start
    // Freeze before anything else: the guest must not run a frame until the host's state is loaded.
    try {
      Promise.resolve(plugin.lockstepHold({ hold: true })).catch(() => {});
    } catch {
      // the error listener reports a dead session
    }
    unwatch = watchOverlays(plugin, doc, win);
    showMenu = hideMenuButton(doc);
    onStarted?.(plugin);
    return true;
  } catch (e) {
    win?.removeEventListener?.("pagehide", onPageHide);
    if (session?.plugin === plugin) session = null;
    cleanup();
    fail(e?.code, e?.message ?? String(e));
    return false;
  }
}

/** Ends the native guest session (link lost, abort, pagehide): stop, then drop the link copy. */
export function stopNativeGuest() {
  const current = session;
  session = null;
  if (!current) return Promise.resolve();
  current.cleanup();
  const { plugin } = current;
  return Promise.resolve()
    .then(() => plugin.stop())
    .catch(() => {})
    .then(() => plugin.deleteGame({ gameId: LINK_GAME_ID }))
    .catch(() => {});
}

/** True while a native guest session is running (tests). */
export function nativeGuestActive() {
  return session !== null;
}

/**
 * The guest's `rom` handler (guest-link.js), as one function so it can be tested without the page:
 * a native guest boots through `bootNative` and never through EmulatorJS; a failure there reports
 * `onError(code)` (abort → library) instead of rebooting on EmulatorJS. An EJS guest boots as today.
 */
export function startGuestGame({ native, game, bytes, boot, bootNative, onStarted, onError, onEjsStarted }) {
  if (!native) {
    boot(game, new Blob([bytes]), (emu) => {
      onStarted(emu);
      onEjsStarted?.();
    });
    return Promise.resolve(false);
  }
  const report = once((code) => onError(String(code)));
  return Promise.resolve()
    .then(() => bootNative(game, bytes, { onStarted, onError: report }))
    .catch((e) => report(e?.code || e));
}
