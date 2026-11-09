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

// A wedged plugin must not trap the user on the play page: wait for `promise`, but not for ever.
function within(promise, ms = STOP_WAIT_MS) {
  let timer;
  const wait = new Promise((resolve) => (timer = setTimeout(resolve, ms)));
  return Promise.race([Promise.resolve(promise).catch(() => {}), wait]).then(() => clearTimeout(timer));
}

// stopNative never rejects, but it may never answer either.
function stopThenLeave(leave) {
  return within(stopNative()).then(leave);
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
 * `?ejs=1`, or for a system/container the native side cannot open. (`?join` pages never call
 * this: the guest's native start is native/agents/fable/js/native-guest.js, N0-f.)
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
  let padVisible = true; // what the plugin was last told
  let preferred = true; // the player's own choice (menu toggle); overlays can only hide on top of it
  let observer = null;
  // What bootNative started the session with (deepseek-v4/js/native-player.js: scaling "fit",
  // showPad true, showStats true). The menu keeps this object up to date.
  const options = { scaling: "fit", showPad: true, showStats: true };
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

  // #back and #emu-menu are handled before play.js's own listeners can see the click. #p2 is NOT
  // touched (N0-f, NETPLAY.md §9): two-phone play runs on the native lockstep, so the click goes
  // to play.js's setupHostLink, which finds the session through window.nbNative.plugin; the host
  // keeps its native session and nothing reloads.
  listen(doc, "click", (ev) => {
    if (!active) return;
    const target = ev.target;
    if (closestId(target, "back")) {
      swallow(ev);
      stopThenLeave(() => navigate(BACK_URL)); // the ad rule stays in the library
    } else if (closestId(target, "emu-menu")) {
      swallow(ev);
      // play.js's closeTools never sees this click, so close the tools panel here, or it would
      // keep counting as an overlay over the pad.
      doc.getElementById("tools-panel")?.classList?.add("hidden");
      doc.dispatchEvent(new CustomEvent("nb:native-menu"));
    }
  });
  listen(win, "pagehide", () => {
    if (active) stopNative();
  });

  // The native pad sits above the WebView, so any HTML panel must hide it (PLAN §1.1).
  const wantPadVisible = () => preferred && !OVERLAY_IDS.some((id) => isShown(doc.getElementById(id)));
  const syncPad = (force = false) => {
    if (!active) return;
    const p = plugin();
    if (!p) return;
    const want = wantPadVisible();
    if (!force && want === padVisible) return;
    padVisible = want;
    try {
      Promise.resolve(p.setPadVisible({ visible: want })).catch(() => {});
    } catch {
      // the session may not exist yet; the post-start sync below covers it
    }
  };
  // The menu stores the touch-pad choice here and never calls setPadVisible itself. Rejects when
  // the plugin does, so the menu keeps its old state (and so do we).
  const setPadPreference = async (visible) => {
    const p = plugin();
    if (!active || !p) throw new Error("no native session");
    const before = preferred;
    preferred = Boolean(visible);
    const want = wantPadVisible();
    try {
      await p.setPadVisible({ visible: want });
      padVisible = want;
    } catch (e) {
      preferred = before;
      throw e;
    }
  };
  // Two-phone play (host-link.js sets body.linked while the guest is connected): mirrored on
  // nbNative.linked so the native menu can hide/disable save, load and reset meanwhile (N0-f;
  // setOption/reset are refused natively with `busy` while the lockstep runs).
  const syncLinked = () => {
    if (win.nbNative) win.nbNative.linked = !!doc.body?.classList?.contains?.("linked");
  };
  const MO = win.MutationObserver || globalThis.MutationObserver;
  if (typeof MO === "function") {
    observer = new MO(() => {
      syncPad();
      syncLinked();
    });
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
  let bootSettled = false;
  let booting = null; // bootNative's promise, to wait for a start that is still running
  const fallBack = (guardPendingStart) => {
    if (fallbackDone) return fallbackDone;
    // A caller that is not bootNative (the menu) may arrive while plugin.start is still in flight:
    // that start would finish after our stop and leave a session running behind EmulatorJS.
    const startPending = guardPendingStart && !bootSettled && booting !== null;
    leaveNativeMode();
    fallbackDone = (async () => {
      await stopThenLeave(() => {});
      if (startPending) {
        await within(booting);
        await stopThenLeave(() => {}); // stop what the late start created
      }
      try {
        bootEmulator?.();
      } catch {
        // EmulatorJS reports its own failures through the page's error box
      }
    })();
    return fallbackDone;
  };
  const onFallback = () => fallBack(true); // nbNative.onFallback: the menu's "classic player"

  doc.title = `${game.name} · NostaljiBox`;
  try {
    ctx.lockOrientation?.(game.core);
  } catch {
    // orientation lock is best effort
  }
  // Extension point for the native menu (WP6): it listens for `nb:native-menu` and uses only these.
  win.nbNative = { plugin: plugin(), game, onFallback, options, setPadPreference, linked: false };
  syncLinked();

  // bootNative takes `romName` from `game.file` for a ZIP it cannot resolve itself; hand it the inner name.
  const bootGame = inner ? { ...game, file: inner } : game;
  booting = bootNative(bootGame, rom, { pad: PADS?.[game.core], onFallback: () => fallBack(false) })
    .finally(() => (bootSettled = true));
  await booting;
  if (fallbackDone) await fallbackDone; // resolve after EmulatorJS has been started
  else syncPad(true); // a panel may have been opened while the session was starting
  return true;
}

/**
 * EJS path, called from EJS_onGameStart: a page loaded with `ejs=1&p2=1` (older builds reloaded
 * like this on a native `#p2` tap; the URL may still be bookmarked or in history) opens the link
 * panel once, exactly what a #p2 tap does. ctx: { params }.
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
