// SPDX-License-Identifier: GPL-3.0-or-later
import { byCore } from "../shared/systems.js";
import { get, put } from "../shared/storage.js";
import { setupHostLink, onHold } from "./host-link.js";
import { setupGuestLink } from "./guest-link.js";
import { t, ejsLanguage, translatePage } from "../shared/i18n.js";
import "./play.css";

translatePage();

const params = new URLSearchParams(location.search);
const id = params.get("id");
const BROKEN_SHADERS = ["2xScaleHQ.glslp", "4xScaleHQ.glslp"];
// Every console gets the same controller: a sliding stick on the left, four face buttons in a
// diamond on the right, shoulder buttons where the console has them and a row of small buttons in
// the middle. Input ids follow EmulatorJS (RetroPad): B 0, Y 1, Select 2, Start 3, directions
// 4-7, A 8, X 9, L 10, R 11, L2 12, R2 13, right analog stick 20-23.
// `face` is [top, left, right, bottom], each [text, input id] or null for an inert blank button.
// COMBO presses the right and bottom buttons together (bindComboButton adds the bottom one, 0).
const COMBO = "combo";
const DIAMOND = [{ left: 40, top: 0 }, { left: 0, top: 40 }, { left: 81, top: 40 }, { left: 40, top: 80 }];
function pad({ face, shoulders, center = [], analog = false }) {
  const buttons = face.map((b, i) => {
    const at = { type: "button", location: "right", bold: true, ...DIAMOND[i] };
    if (!b) return { ...at, text: "", id: `blank${i}`, input_value: 15 };
    if (b[0] === COMBO) return { ...at, text: b[1], id: "ab", fontSize: 18, input_value: face[2][1] };
    return { ...at, text: b[0], id: `face${i}`, input_value: b[1], ...(b[2] && { joystickInput: true }) };
  });
  const n = center.length;
  return [
    analog
      ? { type: "zone", id: "stick", location: "left", left: "50%", top: "50%", joystickInput: true, inputValues: [16, 17, 18, 19], color: "#ffffff" }
      : { type: "zone", id: "dpad", location: "left", left: "50%", top: "50%", joystickInput: false, inputValues: [4, 5, 6, 7], color: "#ffffff" },
    ...buttons,
    ...(shoulders
      ? [
          { type: "button", text: shoulders[0][0], id: "l", location: "left", left: 3, top: -55, bold: true, block: true, input_value: shoulders[0][1] },
          { type: "button", text: shoulders[1][0], id: "r", location: "right", right: 3, top: -45, bold: true, block: true, input_value: shoulders[1][1] },
        ]
      : []),
    // Centred under the picture, 65px apart.
    ...center.map(([text, value, analogInput], i) => ({
      type: "button", text, id: `center${i}`, location: "center", left: 30 + 65 * (i - (n - 1) / 2), fontSize: 15, block: true, input_value: value,
      ...(analogInput && { joystickInput: true }),
    })),
  ];
}
const START_SELECT = [["Select", 2], ["Start", 3]];
const twoButtons = (b, a, combo, center) => pad({ face: [[COMBO, combo], null, [a, 8], [b, 0]], center });
const PADS = {
  nes: twoButtons("B", "A", "A+B", START_SELECT),
  gb: twoButtons("B", "A", "A+B", START_SELECT),
  gba: pad({ face: [[COMBO, "A+B"], null, ["A", 8], ["B", 0]], shoulders: [["L", 10], ["R", 11]], center: START_SELECT }),
  snes: pad({ face: [["X", 9], ["Y", 1], ["A", 8], ["B", 0]], shoulders: [["L", 10], ["R", 11]], center: START_SELECT }),
  nds: pad({ face: [["X", 9], ["Y", 1], ["A", 8], ["B", 0]], shoulders: [["L", 10], ["R", 11]], center: START_SELECT }),
  n64: pad({
    analog: true,
    face: [["C↑", 23, true], ["B", 1], ["C→", 20, true], ["A", 0]],
    shoulders: [["Z", 12], ["R", 11]],
    center: [["L", 10], ["C←", 21, true], ["Start", 3], ["C↓", 22, true]],
  }),
  psx: pad({ face: [["△", 9], ["□", 1], ["○", 8], ["✕", 0]], shoulders: [["L1", 10], ["R1", 11]], center: [["L2", 12], ["Select", 2], ["Start", 3], ["R2", 13]] }),
  segaMD: pad({ face: [["Y", 9], ["A", 1], ["C", 8], ["B", 0]], shoulders: [["X", 10], ["Z", 11]], center: [["Mode", 2], ["Start", 3]] }),
  segaMS: twoButtons("1", "2", "1+2", []),
  segaGG: twoButtons("1", "2", "1+2", [["Start", 3]]),
  pce: twoButtons("II", "I", "I+II", [["Select", 2], ["Run", 3]]),
  atari2600: pad({ face: [null, null, null, ["●", 0]], center: [["Select", 2], ["Reset", 3]] }),
  atari7800: twoButtons("1", "2", "1+2", [["Reset", 9], ["Select", 2], ["Pause", 3]]),
  lynx: twoButtons("B", "A", "A+B", [["Opt 1", 10], ["Start", 3], ["Opt 2", 11]]),
  ngp: twoButtons("A", "B", "A+B", [["Option", 3]]),
  // The WonderSwan's second cross pad (Y1-Y4) sits in the middle row.
  ws: twoButtons("B", "A", "A+B", [["Y↑", 13], ["Y↓", 12], ["Y←", 10], ["Y→", 11], ["Start", 3]]),
  // The Virtual Boy's right cross pad sits in the middle row.
  vb: pad({ face: [[COMBO, "A+B"], null, ["A", 8], ["B", 0]], shoulders: [["L", 10], ["R", 11]], center: [["R↑", 19], ["R↓", 18], ["Select", 2], ["Start", 3], ["R←", 17], ["R→", 16]] }),
};

function bindComboButton(emu) {
  const el = document.querySelector(".ejs_virtualGamepad_button.b_ab");
  if (!el) return;
  // Button 8 comes from EmulatorJS; add button 0. Look the game manager up on each touch:
  // two-phone play wraps simulateInput after start.
  el.addEventListener("touchstart", () => emu.gameManager.simulateInput(0, 0, 1));
  const release = () => setTimeout(() => emu.gameManager.simulateInput(0, 0, 0));
  el.addEventListener("touchend", release);
  el.addEventListener("touchcancel", release);
}
const errorEl = document.getElementById("error");
let current = null;

function fail(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove("hidden");
}

onHold(document.getElementById("back"), () => {
  location.href = "../index.html?from=game";
});

async function lockOrientation(core) {
  if (!window.Capacitor?.isNativePlatform?.()) return;
  try {
    const { ScreenOrientation } = await import("@capacitor/screen-orientation");
    // The DS shows two stacked screens, so it plays best upright.
    await ScreenOrientation.lock({ orientation: core === "nds" ? "portrait" : "landscape" });
  } catch {
    // orientation lock is best effort
  }
}

// Starts EmulatorJS with a game; onStart gets the emulator once the game runs.
function boot(game, rom, onStart, gameId = id) {
  current = { game, rom };
  const sys = byCore[game.core];
  document.title = `${game.name} · NostaljiBox`;
  lockOrientation(game.core);

  // Stretch the picture over the whole screen: read the device's screen size and give RetroArch
  // that exact aspect ratio (aspect_ratio_index 20 = "Config", i.e. use video_aspect_ratio).
  const portrait = game.core === "nds";
  const w = Math.max(screen.width, innerWidth);
  const h = Math.max(screen.height, innerHeight);
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const aspect = portrait ? short / long : long / short;
  const fullScreenCfg = `video_aspect_ratio_auto = "false"\naspect_ratio_index = "20"\nvideo_aspect_ratio = "${aspect.toFixed(4)}"\nvideo_scale_integer = "false"\n`;

  // EmulatorJS reads its configuration from globals, then loader.js boots it.
  Object.assign(window, {
    EJS_player: "#game",
    EJS_core: game.core,
    EJS_gameUrl: new File([rom], game.file),
    EJS_gameName: game.name,
    EJS_gameID: gameId,
    EJS_pathtodata: "../ejs/",
    EJS_startOnLoaded: true,
    EJS_color: sys ? sys.color : "#e8452c",
    EJS_backgroundColor: "#000",
    EJS_language: ejsLanguage(),
    // ROMs and cores are already local; skip EmulatorJS's own IndexedDB caches of them.
    EJS_disableDatabases: true,
    // SABR is an xBR-family edge-directed upscaler: smooths the pixel staircase while keeping
    // edges sharp. Players can switch it in the menu (Ayarlar > Tonlayıcılar).
    EJS_defaultOptions: { shader: "sabr" },
    ...(PADS[game.core] && { EJS_VirtualGamepadSettings: PADS[game.core] }),
    // "ready" fires before the core is downloaded, i.e. before RetroArch reads its config.
    EJS_ready: () => {
      const proto = window.EJS_GameManager.prototype;
      const base = proto.getRetroArchCfg;
      proto.getRetroArchCfg = function () {
        return base.call(this) + fullScreenCfg;
      };
      // ScaleHQ shifts the picture right on some phones (an 8-pixel strip of the backdrop shows
      // on the left), so keep it out of the shader menu. The menu is built after this event.
      const shaders = window.EJS_emulator.config.shaders || {};
      for (const name of BROKEN_SHADERS) delete shaders[name];
    },
    // Runs after saved settings are applied: move players who had picked ScaleHQ back to SABR.
    EJS_onGameStart: () => {
      const emu = window.EJS_emulator;
      if (BROKEN_SHADERS.includes(emu.getSettingValue("shader"))) emu.changeSettingOption("shader", "sabr");
      bindComboButton(emu);
      if (onStart) onStart(emu);
    },
  });
  const script = document.createElement("script");
  script.src = "../ejs/loader.js";
  script.onerror = () => fail(t("emuLoadFailed"));
  document.body.append(script);
}

const reloaded = performance.getEntriesByType("navigation")[0]?.type === "reload";
if (params.has("join") && reloaded) {
  // iOS reloads the page when it kills the web view's process; the link to the host is gone by
  // then, so go back to the library instead of reopening the camera to join again.
  location.replace("../index.html");
} else if (params.has("join")) {
  // Second phone: the game comes from the host phone over the link.
  setupGuestLink((game, rom, onStart) => boot(game, rom, onStart, "nostaljibox-link"));
} else {
  setupHostLink(() => current);
  (async () => {
    const game = id && (await get("games", id));
    const rom = game && (await get("roms", id));
    if (!game || !rom) return fail(t("gameNotFound"));
    put("games", id, { ...game, played: Date.now() }).catch(() => {});
    boot(game, rom);
  })().catch((e) => fail(t("error", { msg: e.message || e })));
}
