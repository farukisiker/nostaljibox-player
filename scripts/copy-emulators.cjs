// Copies EmulatorJS and the bundled libretro cores into public/ejs so the app works offline.
// Only the single-threaded variants are copied (WebGL2 and legacy); threaded builds need
// cross-origin isolation, which the native WebViews do not provide.
const fs = require("node:fs");
const path = require("node:path");

// Runs from the app repo root: node_modules/ and public/ live there.
const root = process.cwd();
const src = path.join(root, "node_modules/@emulatorjs");
const out = path.join(root, "public/ejs");
const { cores } = require("../cores.json");

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(src, "emulatorjs/data"), out, {
  recursive: true,
  filter: (p) => !p.includes(`${path.sep}cores${path.sep}`) || p.endsWith(`${path.sep}cores`),
});
fs.mkdirSync(path.join(out, "cores/reports"), { recursive: true });
for (const core of cores) {
  const dir = path.join(src, `core-${core}`);
  for (const f of [`${core}-wasm.data`, `${core}-legacy-wasm.data`]) {
    fs.copyFileSync(path.join(dir, f), path.join(out, "cores", f));
  }
  fs.copyFileSync(path.join(dir, `reports/${core}.json`), path.join(out, `cores/reports/${core}.json`));
}
// The npm package ships unminified sources only. loader.js looks for emulator.min.js/.css,
// so bundle the sources in loader order (plain concatenation of classic scripts).
const order = ["emulator.js", "nipplejs.js", "shaders.js", "storage.js", "gamepad.js", "GameManager.js", "socket.io.min.js", "compression.js"];
fs.writeFileSync(path.join(out, "emulator.min.js"), order.map((f) => fs.readFileSync(path.join(out, "src", f), "utf8")).join("\n;\n"));
fs.copyFileSync(path.join(out, "emulator.css"), path.join(out, "emulator.min.css"));
console.log(`copied EmulatorJS + ${cores.length} cores to public/ejs`);
