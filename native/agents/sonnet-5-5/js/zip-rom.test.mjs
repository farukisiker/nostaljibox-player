// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/sonnet-5-5/js/zip-rom.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { zipRomName } from "./zip-rom.js";
import { makeZip } from "./zip-fixture.mjs";

const rom = new Uint8Array([1, 2, 3, 4]);
const md = { id: "g", name: "Sonic", file: "Sonic.zip", core: "segaMD" };

test("a Mega Drive ZIP holding a plain .bin gets its inner name", async () => {
  assert.equal(await zipRomName(md, makeZip([["Sonic The Hedgehog (W) [!].bin", rom]])), "Sonic The Hedgehog (W) [!].bin");
});

test("folders are dropped from the inner name", async () => {
  assert.equal(await zipRomName(md, makeZip([["roms/md/Sonic.bin", rom]])), "Sonic.bin");
  assert.equal(await zipRomName(md, makeZip([["a\\b\\Sonic.bin", rom]])), "Sonic.bin");
});

test("entries with the console's own extension win over .bin", async () => {
  const zip = makeZip([["extra.bin", rom], ["Sonic.md", rom]]);
  assert.equal(await zipRomName(md, zip), "Sonic.md");
  const snes = { id: "g", name: "x", file: "x.zip", core: "snes" };
  assert.equal(await zipRomName(snes, makeZip([["readme.txt", "hi"], ["Game.sfc", rom]])), "Game.sfc");
});

test("Master System and Game Gear ZIPs work with .sms / .gg and .bin", async () => {
  assert.equal(await zipRomName({ file: "a.zip", core: "segaMS" }, makeZip([["Alex.sms", rom]])), "Alex.sms");
  assert.equal(await zipRomName({ file: "a.zip", core: "segaGG" }, makeZip([["Sonic.bin", rom]])), "Sonic.bin");
  assert.equal(await zipRomName({ file: "a.zip", core: "nes" }, makeZip([["Game.rom", rom]])), "Game.rom");
});

test("a ZIP without a ROM-looking entry returns null (EmulatorJS keeps it)", async () => {
  assert.equal(await zipRomName(md, makeZip([["readme.txt", "hi"], ["cover.jpg", rom]])), null);
  assert.equal(await zipRomName(md, makeZip([])), null);
});

test("junk entries are skipped", async () => {
  const zip = makeZip([["__MACOSX/._Sonic.bin", rom], [".hidden.bin", rom], ["Real.bin", rom]]);
  assert.equal(await zipRomName(md, zip), "Real.bin");
  assert.equal(await zipRomName(md, makeZip([["__MACOSX/._Sonic.bin", rom]])), null);
});

test("an unreadable ZIP returns null", async () => {
  const bad = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
  assert.equal(await zipRomName(md, bad), null);
});

test("raw ROMs are not ZIPs: empty string, the caller keeps game.file", async () => {
  assert.equal(await zipRomName({ file: "Sonic.bin", core: "segaMD" }, rom), "");
  assert.equal(await zipRomName({ file: "Sonic.md", core: "segaMD" }, new Uint8Array(0)), "");
});

test("ArrayBuffer and Blob inputs work like Uint8Array", async () => {
  const zip = makeZip([["Sonic.bin", rom]]);
  assert.equal(await zipRomName(md, zip.buffer), "Sonic.bin");
  assert.equal(await zipRomName(md, new Blob([zip])), "Sonic.bin");
});
