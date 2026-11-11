// SPDX-License-Identifier: GPL-3.0-or-later
// NostaljiBox's own game screen UI on top of EmulatorJS: the loading splash, the game menu behind
// the ☰ button and the look of the on-screen controls. EmulatorJS still runs the game, but none of
// its own menus, buttons or loading screens are shown.
import { get, put } from "../shared/storage.js";
import { t } from "../shared/i18n.js";
import { toast } from "./host-link.js";

const $ = (s) => document.querySelector(s);

// EJS_Buttons: switch off every button of EmulatorJS's bottom menu bar (its settings menu opens
// only from there). The bar itself is never opened: copy-emulators.cjs removes its automatic
// opening and play.css hides its corner toggle.
export const EJS_BUTTONS = Object.fromEntries(
  [
    "playPause", "restart", "mute", "settings", "fullscreen", "saveState", "loadState", "screenRecord",
    "gamepad", "cheat", "volume", "saveSavFiles", "loadSavFiles", "quickSave", "quickLoad", "screenshot",
    "cacheManager", "exitEmulation", "netplay", "diskButton",
  ].map((name) => [name, false]),
);

// EmulatorJS reads buttonOpts.rightClick when the game area gets a right click or long press,
// but EJS_Buttons drops keys it doesn't know, so set it on the built config instead.
export function disableContextMenu(emu) {
  emu.config.buttonOpts.rightClick = false;
}

/* ---------- loading splash ---------- */

// Shows the game and console name until the game runs. The progress bar follows EmulatorJS's
// (hidden) loading text: each new step fills half of what is left, and a percentage in the text
// moves the bar within the step, so it only ever grows.
export function showSplash(game, sys) {
  $("#splash-game").textContent = game.name;
  $("#splash-system").textContent = sys ? sys.name : game.core;
  $("#splash").classList.remove("hidden");
  const bar = $("#splash-progress");
  let step = -1;
  let label = "";
  let shown = 0;
  const update = (text) => {
    const pct = /(\d+)%/.exec(text);
    const name = text.replace(/[\d.]+\s*(%|MB)/g, "").trim();
    if (name !== label) {
      label = name;
      step++;
    }
    const from = 1 - 0.5 ** step;
    const to = 1 - 0.5 ** (step + 1);
    shown = Math.max(shown, from + (to - from) * (pct ? pct[1] / 100 : 0));
    bar.style.width = `${Math.round(8 + shown * 90)}%`;
  };
  // EmulatorJS creates its loading text right after the loader script runs.
  const watch = new MutationObserver(() => {
    const text = document.querySelector("#game .ejs_loading_text");
    if (!text) return;
    if (text.classList.contains("ejs_error_text")) return failed();
    update(text.textContent);
  });
  watch.observe($("#game"), { subtree: true, childList: true, characterData: true, attributes: true });
  const failed = () => {
    watch.disconnect();
    $("#splash-status").textContent = t("gameStartFailed");
    $("#splash").classList.add("failed");
  };
  return () => {
    watch.disconnect();
    bar.style.width = "100%";
    $("#splash").classList.add("hidden");
  };
}

/* ---------- game menu ---------- */

// Picture filters from EmulatorJS's shader list: SABR (smooth edges, the default), a light CRT
// look that phones can afford, and no shader at all (RetroArch runs with video_smooth off, so
// that is sharp square pixels).
const FILTERS = [
  { shader: "sabr", label: "filterSmooth" },
  { shader: "crt-zfast", label: "filterCrt" },
  { shader: "disabled", label: "filterSharp" },
];

// Two-phone play shares one game between two emulators, so anything that jumps the game
// (save state, load state, restart, fast forward) is hidden then (body.linked / body.guest).
const together = () => document.body.classList.contains("linked") || document.body.classList.contains("guest");

// One quick save state per game, stored with the library in IndexedDB.
const stateKey = (gameId) => `state:${gameId}`;

// EmulatorJS's getState never frees the buffer the core writes the state into (see lockstep.js);
// copy the state out and free it.
function takeState(gm) {
  const [size, start, ok] = gm.functions.saveStateInfo().split("|");
  if (ok !== "1") throw new Error(size);
  const state = gm.Module.HEAPU8.slice(+start, +start + +size);
  gm.Module._free(+start);
  return state;
}

function currentFilter(emu) {
  const i = FILTERS.findIndex((f) => f.shader === (emu.getSettingValue("shader") || "sabr"));
  return i < 0 ? null : i;
}

// Updates the tiles that show a state: fast forward on, sound off, the filter's name, a saved state.
async function refreshMenu(emu, gameId) {
  $("#fast-forward").classList.toggle("on", !!emu.isFastForward);
  $("#sound").classList.toggle("on", !emu.muted);
  $("#sound-icon").textContent = emu.muted ? "🔇" : "🔊";
  const f = currentFilter(emu);
  $("#filter-name").textContent = f === null ? "" : t(FILTERS[f].label);
  const saved = gameId ? await get("kv", stateKey(gameId)).catch(() => null) : null;
  $("#load-state").disabled = !saved;
}

function setFastForward(emu, on) {
  emu.isFastForward = on;
  emu.gameManager.toggleFastForward(on ? 1 : 0);
}

// Wires the menu's tiles to the running emulator. gameId is the library id (null for player 2).
export function setupGameMenu(emu, gameId) {
  const gm = emu.gameManager;
  document.body.classList.add("game-running");
  if (!gm.supportsStates()) for (const id of ["#save-state", "#load-state"]) $(id).classList.add("hidden");
  const tile = (sel, fn) =>
    $(sel).addEventListener("click", (ev) => {
      // Toggles keep the menu open so the change shows; the other tiles close it (play.js).
      if ($(sel).classList.contains("keep-open")) ev.stopPropagation();
      Promise.resolve(fn())
        .catch((e) => toast(t("error", { msg: e.message || e })))
        .finally(() => refreshMenu(emu, gameId));
    });

  tile("#save-state", async () => {
    if (together() || !gameId) return;
    await put("kv", stateKey(gameId), takeState(gm));
    toast(t("stateSaved"));
  });
  tile("#load-state", async () => {
    if (together() || !gameId) return;
    const state = await get("kv", stateKey(gameId));
    if (!state) return toast(t("noSavedState"));
    gm.loadState(state);
    toast(t("stateLoaded"));
  });
  tile("#restart", () => {
    if (together()) return;
    gm.restart();
  });
  tile("#fast-forward", () => {
    if (together()) return;
    setFastForward(emu, !emu.isFastForward);
  });
  tile("#filter", () => {
    const f = currentFilter(emu);
    // changeSettingOption saves the choice with EmulatorJS's per-game settings.
    emu.changeSettingOption("shader", FILTERS[f === null ? 0 : (f + 1) % FILTERS.length].shader);
  });
  tile("#sound", () => {
    if (emu.muted) emu.setVolume(emu.volume || 0.5);
    else emu.setVolume(0);
    // setVolume saves the settings before it updates `muted`; save again so the choice sticks.
    emu.saveSettings();
  });

  // Back to normal speed when two-phone play starts: both phones must run frame by frame.
  new MutationObserver(() => {
    if (together() && emu.isFastForward) setFastForward(emu, false);
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  $("#tools-toggle").addEventListener("click", () => refreshMenu(emu, gameId));
  refreshMenu(emu, gameId);
}

/* ---------- on-screen controls ---------- */

// The console's colour for the controls and the splash (play.css --pad), plus a lighter ink of it
// for outlines. Very dark console colours (Mega Drive black) would vanish on the see-through
// buttons, so they get NostaljiBox pink instead.
export function setPadColor(sys) {
  const hex = sys && /^#[0-9a-f]{6}$/i.test(sys.color) ? sys.color : "#ff3d7f";
  let rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  if (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 40) rgb = [255, 61, 127];
  const ink = rgb.map((c) => Math.round(c + (255 - c) * 0.45));
  document.body.style.setProperty("--pad", `rgb(${rgb})`);
  document.body.style.setProperty("--pad-ink", `rgb(${ink})`);
}

// Puts each button's label in a span, so the label can sit upright on a tilted key (play.css).
// The span ignores touches, so taps still land on EmulatorJS's button element and its own touch
// handling stays as it is.
export function labelPadButtons() {
  for (const b of document.querySelectorAll("#game .ejs_virtualGamepad_button")) {
    if (b.querySelector(".pad-label")) continue;
    const label = document.createElement("span");
    label.className = "pad-label";
    label.textContent = b.textContent;
    b.textContent = "";
    b.append(label);
  }
}
