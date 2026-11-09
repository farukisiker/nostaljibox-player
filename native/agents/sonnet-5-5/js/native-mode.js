// SPDX-License-Identifier: GPL-3.0-or-later
// The play page's native mode (iOS): wires the page's buttons and panels to the native player and
// falls back to EmulatorJS when the plugin reports an error. Contract: docs/native-player/API.md
// §8; plan: PLAN.md §1.1 (pad visibility), §1.6, §2.3. The decision and the session itself live in
// ../../deepseek-v4/js/native-player.js; this file only adds the page behaviour around them.
//
// Every page-level listener sits on `document` / `window` in the CAPTURE phase and looks at
// `ev.target`, so none of them depends on the order in which play.js binds its own handlers
// (setupHostLink, the #back and #emu-menu listeners): a capturing ancestor always runs first.
import { useNative, bootNative, stopNative } from "../../deepseek-v4/js/native-player.js";
import { zipRomName } from "./zip-rom.js";

const BACK_URL = "../index.html?from=game";
// Panels and overlays that sit over the game; while any is visible the native pad is hidden.
export const OVERLAY_IDS = ["tools-panel", "link", "join", "native-menu", "error"];

let active = false; // native mode currently owns the page
let cleanup = null; // removes the listeners installed by the running native mode
let hostLinkOpened = false; // autoOpenHostLink runs once per page load
const STOP_WAIT_MS = 2500; // leaving the page must not hang on a plugin that never answers

// stopNative never rejects, but a wedged plugin must not trap the user on the play page.
function stopThenLeave(leave) {
  let timer;
  const wait = new Promise((resolve) => (timer = setTimeout(resolve, STOP_WAIT_MS)));
  return Promise.race([stopNative(), wait]).then(() => {
    clearTimeout(timer);
    leave();
  });
}

function isShown(el) {
  return !!el && !el.hidden && !el.classList?.contains("hidden") && el.style?.display !== "none";
}

function closestId(target, id) {
  const hit = target?.closest?.(`#${id}`);
  return hit || null;
}

function plugin() {
  return globalThis.window?.Capacitor?.Plugins?.NativePlayer ?? null;
}

/**
 * Takes the page over for the native player when the game can run there.
 *
 * ctx: {
 *   params,                // URLSearchParams of the page
 *   game, rom,             // the library record and the stored ROM bytes
 *   PADS,                  // play.js's PADS table; PADS[game.core] is passed to the plugin as is
 *   bootEmulator,          // () => void, starts EmulatorJS for this game (fallback path)
 *   lockOrientation?,      // (core) => void, play.js's orientation lock (best effort)
 *   navigate?,             // (url) => void, defaults to `location.href = url`
 * }
 *
 * Resolves true when native mode took over, so play.js must NOT start EmulatorJS itself; that
 * stays true even if the native start later fails, because `bootEmulator` is then called here.
 * Resolves false (nothing touched) on non-iOS, without the plugin, with `nb_native=off`,
 * `?ejs=1`, `?join`, or for a system/container the native side cannot open.
 */
export async function installNativeMode(ctx) {
  const { params, game, rom, PADS, bootEmulator } = ctx || {};
  if (active) return false;
  if (!(await useNative(game, params, rom))) return false;
  // A ZIP must name its ROM for the native side. DeepSeek's bootNative finds the inner name only
  // for extensions detectSystem knows, so a Mega Drive `.bin` would reach the plugin as "x.zip".
  // Read the central directory here; no ROM-looking entry means EmulatorJS keeps the game.
  const inner = await zipRomName(game, rom);
  if (inner === null) return false;

  const doc = globalThis.document;
  const win = globalThis.window;
  const navigate = ctx.navigate || ((url) => (globalThis.location.href = url));
  active = true;
  let padVisible = true;
  let observer = null;
  const offs = [];
  const listen = (target, type, fn) => {
    target.addEventListener(type, fn, true);
    offs.push(() => target.removeEventListener(type, fn, true));
  };

  const swallow = (ev) => {
    ev.preventDefault?.();
    ev.stopPropagation?.();
    ev.stopImmediatePropagation?.();
  };

  // #back, #emu-menu and #p2 are handled before play.js's own listeners can see the click.
  listen(doc, "click", (ev) => {
    if (!active) return;
    const target = ev.target;
    if (closestId(target, "back")) {
      swallow(ev);
      stopThenLeave(() => navigate(BACK_URL)); // the ad rule stays in the library
    } else if (closestId(target, "emu-menu")) {
      swallow(ev);
      doc.dispatchEvent(new CustomEvent("nb:native-menu"));
    } else if (closestId(target, "p2")) {
      // Two-phone play runs on EmulatorJS: end the native session, reload on the EJS path.
      swallow(ev);
      stopThenLeave(() => {
        const url = new URL(globalThis.location.href);
        url.searchParams.set("ejs", "1");
        url.searchParams.set("p2", "1");
        navigate(url.toString());
      });
    }
  });
  listen(win, "pagehide", () => {
    if (active) stopNative();
  });

  // The native pad sits above the WebView, so any HTML panel must hide it (PLAN §1.1).
  const syncPad = (force = false) => {
    if (!active) return;
    const p = plugin();
    if (!p) return;
    const covered = OVERLAY_IDS.some((id) => isShown(doc.getElementById(id)));
    if (!force && covered === !padVisible) return;
    padVisible = !covered;
    try {
      Promise.resolve(p.setPadVisible({ visible: padVisible })).catch(() => {});
    } catch {
      // the session may not exist yet; the post-start sync below covers it
    }
  };
  const MO = win.MutationObserver || globalThis.MutationObserver;
  if (typeof MO === "function") {
    observer = new MO(() => syncPad());
    // The whole body: #native-menu is created later by the native menu (WP6).
    observer.observe(doc.body, { attributes: true, attributeFilter: ["class", "hidden", "style"], subtree: true, childList: true });
  }

  const leaveNativeMode = () => {
    active = false;
    observer?.disconnect();
    for (const off of offs.splice(0)) off();
    cleanup = null;
    doc.documentElement.classList.remove("native");
    delete win.nbNative;
  };
  cleanup = leaveNativeMode;

  // Exactly once, from every path (a plugin error, a rejected start, the native menu calling
  // `nbNative.onFallback()`): the page leaves native mode and the native session is stopped
  // (which also drops its error listener) BEFORE EmulatorJS starts, so the two never run together.
  let fallbackDone = null;
  const onFallback = () => {
    if (fallbackDone) return fallbackDone;
    leaveNativeMode();
    fallbackDone = stopThenLeave(() => {
      try {
        bootEmulator?.();
      } catch {
        // EmulatorJS reports its own failures through the page's error box
      }
    });
    return fallbackDone;
  };

  doc.title = `${game.name} · NostaljiBox`;
  try {
    ctx.lockOrientation?.(game.core);
  } catch {
    // orientation lock is best effort
  }
  // Extension point for the native menu (WP6): it listens for `nb:native-menu` and uses only these.
  win.nbNative = { plugin: plugin(), game, onFallback };

  // bootNative takes `romName` from `game.file` for a ZIP it cannot resolve itself; hand it the inner name.
  const bootGame = inner ? { ...game, file: inner } : game;
  await bootNative(bootGame, rom, { pad: PADS?.[game.core], onFallback });
  if (fallbackDone) await fallbackDone; // resolve after EmulatorJS has been started
  else syncPad(true); // a panel may have been opened while the session was starting
  return true;
}

/**
 * EJS path, called from EJS_onGameStart: after a native `#p2` tap reloaded the page with
 * `ejs=1&p2=1`, open the link panel once, exactly what a #p2 tap does. ctx: { params }.
 */
export function autoOpenHostLink(ctx) {
  if (hostLinkOpened || ctx?.params?.get?.("p2") !== "1") return false;
  const button = globalThis.document?.getElementById("p2");
  if (!button) return false;
  hostLinkOpened = true;
  button.click();
  return true;
}

/** Leaves native mode without touching the plugin (tests, hot reload). */
export function resetNativeMode() {
  cleanup?.();
  active = false;
  hostLinkOpened = false;
}
