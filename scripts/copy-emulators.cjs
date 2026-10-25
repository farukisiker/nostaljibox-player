// SPDX-License-Identifier: GPL-3.0-or-later
// Copies EmulatorJS and the bundled libretro cores into public/ejs so the app works offline.
// Only the single-threaded variants are copied (WebGL2 and legacy); threaded builds need
// cross-origin isolation, which the native WebViews do not provide.
//
// Every bundled core allows commercial distribution (GPL/AGPL/MPL). "npm" cores come from the
// @emulatorjs packages; "built" cores are compiled by the build-cores workflow into
// player/cores/dist because EmulatorJS does not publish them.
const fs = require("node:fs");
const path = require("node:path");

// Runs from the app repo root: node_modules/ and public/ live there.
const root = process.cwd();
const src = path.join(root, "node_modules/@emulatorjs");
const out = path.join(root, "public/ejs");
const { npm, built } = require("../cores.json");
const builtDir = path.join(__dirname, "../cores/dist");

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(src, "emulatorjs/data"), out, {
  recursive: true,
  filter: (p) => !p.includes(`${path.sep}cores${path.sep}`) || p.endsWith(`${path.sep}cores`),
});
fs.mkdirSync(path.join(out, "cores/reports"), { recursive: true });
function copyCore(core, dir, required) {
  for (const f of [`${core}-wasm.data`, `${core}-legacy-wasm.data`]) {
    const from = path.join(dir, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(out, "cores", f));
    else if (!f.includes("legacy")) {
      if (required) throw new Error(`missing core ${from}`);
      console.warn(`warning: ${core} is not built yet; run the build-cores workflow (its games will not start)`);
      return;
    }
  }
  const report = path.join(dir, `reports/${core}.json`);
  if (fs.existsSync(report)) fs.copyFileSync(report, path.join(out, `cores/reports/${core}.json`));
}
for (const core of npm) copyCore(core, path.join(src, `core-${core}`), true);
for (const core of built) copyCore(core, builtDir, false);
const cores = [...npm, ...built];
// The npm package ships unminified sources only. loader.js looks for emulator.min.js/.css,
// so bundle the sources in loader order (plain concatenation of classic scripts).
const order = ["emulator.js", "nipplejs.js", "shaders.js", "storage.js", "gamepad.js", "GameManager.js", "socket.io.min.js", "compression.js"];
let bundle = order.map((f) => fs.readFileSync(path.join(out, "src", f), "utf8")).join("\n;\n");

// Point systems at the commercially licensed cores we ship instead of EmulatorJS's defaults.
const coreMap = {
  '"snes": ["snes9x"]': '"snes": ["bsnes"]',
  '"segaMS": ["smsplus", "genesis_plus_gx", "picodrive"]': '"segaMS": ["gearsystem"]',
  '"segaMD": ["genesis_plus_gx", "picodrive"]': '"segaMD": ["clownmdemu"]',
  '"segaGG": ["genesis_plus_gx"]': '"segaGG": ["gearsystem"]',
};
for (const [from, to] of Object.entries(coreMap)) {
  if (!bundle.includes(from)) throw new Error(`EmulatorJS core table changed, cannot find ${from}`);
  bundle = bundle.replace(from, to);
}
fs.writeFileSync(path.join(out, "emulator.min.js"), bundle);
fs.copyFileSync(path.join(out, "emulator.css"), path.join(out, "emulator.min.css"));
console.log(`copied EmulatorJS + ${cores.length} cores to public/ejs`);
