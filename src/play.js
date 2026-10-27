// SPDX-License-Identifier: GPL-3.0-or-later
import { byCore } from "../shared/systems.js";
import { get, put } from "../shared/storage.js";
import { setupHostLink } from "./host-link.js";
import { setupGuestLink } from "./guest-link.js";
import { t, ejsLanguage, translatePage } from "../shared/i18n.js";
import "./play.css";

translatePage();

const params = new URLSearchParams(location.search);
const id = params.get("id");
const BROKEN_SHADERS = ["2xScaleHQ.glslp", "4xScaleHQ.glslp"];
// bsnes switches emscripten fibers while serializing, which crashes the core when a savestate is
// taken from JavaScript. Without savestates there are no save/load buttons and no two-phone play.
const NO_STATES = ["snes"];
const errorEl = document.getElementById("error");
let current = null;

function fail(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove("hidden");
}

document.getElementById("back").addEventListener("click", () => {
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
  const noStates = NO_STATES.includes(game.core);
  document.body.classList.toggle("no-link", noStates);

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
    ...(noStates && { EJS_Buttons: { saveState: false, loadState: false } }),
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
      if (onStart) onStart(emu);
    },
  });
  const script = document.createElement("script");
  script.src = "../ejs/loader.js";
  script.onerror = () => fail(t("emuLoadFailed"));
  document.body.append(script);
}

if (params.has("join")) {
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
