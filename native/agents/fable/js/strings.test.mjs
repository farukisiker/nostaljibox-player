// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/fable/js/
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nt, textsFor, NETPLAY_KEYS, pickLang, APP_LANGS } from "./strings.js";
import { fill } from "./lang.js";
import { hintLang, hintText } from "./paused-hint.js";

const LANGS = ["de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "pt", "ru", "tr", "zh"];
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("languages: exactly the 13 codes of shared/locales/*.json", () => {
  assert.deepEqual([...APP_LANGS].sort(), LANGS);
  const dir = fileURLToPath(new URL("../../../../shared/locales/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(files, LANGS);
});

test("every key exists in all 13 languages, no empty strings, no extra keys", () => {
  assert.ok(NETPLAY_KEYS.length >= 9);
  for (const lang of LANGS) {
    const texts = textsFor(lang);
    assert.deepEqual(Object.keys(texts).sort(), [...NETPLAY_KEYS].sort(), `${lang}: key set`);
    for (const k of NETPLAY_KEYS) {
      assert.equal(typeof texts[k], "string", `${lang}.${k}: not a string`);
      assert.notEqual(texts[k].trim(), "", `${lang}.${k}: empty`);
      assert.equal(texts[k], texts[k].trim(), `${lang}.${k}: stray whitespace`);
      assert.equal(nt(k, null, lang), texts[k]);
      assert.notEqual(nt(k, null, lang), k, `${lang}.${k}: falls back to the key`);
    }
  }
  assert.deepEqual(textsFor("xx"), textsFor("en")); // unknown code: English
});

test("placeholders: each language keeps exactly the English ones, and they are filled", () => {
  for (const lang of LANGS) {
    for (const k of NETPLAY_KEYS) {
      const want = placeholders(nt(k, null, "en"));
      assert.deepEqual(placeholders(nt(k, null, lang)), want, `${lang}.${k}: placeholders`);
      const vars = Object.fromEntries(want.map((p) => [p, `<${p}>`]));
      const out = nt(k, vars, lang);
      assert.doesNotMatch(out, /\{\w+\}/, `${lang}.${k}: unfilled placeholder`);
      for (const p of want) assert.ok(out.includes(`<${p}>`), `${lang}.${k}: ${p} missing after fill`);
    }
  }
  assert.deepEqual(placeholders(nt("peerMismatch", null, "en")), ["mine", "theirs"]);
  assert.deepEqual(placeholders(nt("guestBootFailed", null, "en")), ["code"]);
  assert.equal(fill("a {x} {y}", { x: 1 }), "a 1 {y}"); // a missing value leaves the placeholder, as shared/i18n.js t()
  assert.equal(nt("nope", null, "ja"), "nope");
});

test("English and Turkish are unchanged", () => {
  assert.equal(nt("connectionLost", null, "en"), "Connection lost");
  assert.equal(nt("connectionLost", null, "tr"), "Bağlantı koptu");
  assert.equal(nt("guestOutdated", null, "tr"), "Misafirin uygulaması eski; ikisini de güncelleyin.");
  assert.equal(nt("backendEjs", null, "tr"), "klasik oynatıcı");
  assert.equal(nt("pausedHint", null, "en"), "Paused — tap to resume");
  assert.equal(nt("pausedHint", null, "tr"), "Duraklatıldı — devam etmek için dokun");
});

test("real UTF-8: Turkish, Japanese, Hindi (and the other scripts) use their own characters", () => {
  const all = (lang) => NETPLAY_KEYS.map((k) => nt(k, null, lang)).join("\n");
  for (const lang of LANGS) {
    assert.ok(!all(lang).includes(String.fromCharCode(0xfffd)), `${lang}: replacement character`);
    assert.doesNotMatch(all(lang), /\?\?/, `${lang}: lost characters`);
  }
  assert.match(all("tr"), /[ğşıİçöüĞŞÇÖÜ]/);
  assert.match(all("ja"), /\p{Script=Hiragana}|\p{Script=Katakana}/u); // kana
  assert.match(all("ja"), /\p{Script=Han}/u); // kanji
  assert.match(all("hi"), /\p{Script=Devanagari}/u);
  assert.match(all("zh"), /\p{Script=Han}/u);
  assert.match(all("ko"), /\p{Script=Hangul}/u);
  assert.match(all("ru"), /\p{Script=Cyrillic}/u);
  for (const lang of ["ja", "hi", "zh", "ko", "ru"]) {
    assert.doesNotMatch(nt("connectionLost", null, lang), /^[\x00-\x7f]*$/, `${lang}: ASCII-only text`);
  }
  for (const lang of ["tr", "de", "es", "fr", "pt", "it"]) {
    assert.match(all(lang), /[^\x00-\x7f]/, `${lang}: no accented letters at all`);
  }
});

test("language pick: same rule as shared/i18n.js for all 13 languages, one helper everywhere", () => {
  assert.equal(hintLang, pickLang);
  for (const lang of LANGS) {
    assert.equal(pickLang({ navigator: { language: `${lang}-XX` } }), lang);
    assert.equal(pickLang({ navigator: { languages: ["xx", lang] } }), lang);
    assert.equal(pickLang({ localStorage: { getItem: () => lang }, navigator: { language: "en-US" } }), lang);
    assert.equal(hintText(lang), nt("pausedHint", null, lang));
  }
  assert.equal(pickLang({ navigator: { languages: ["de-DE", "tr"] } }), "de");
  assert.equal(pickLang({ localStorage: { getItem: () => "xx" }, navigator: { language: "ja-JP" } }), "ja"); // unknown saved value: the phone decides
  assert.equal(pickLang({ localStorage: { getItem: () => { throw new Error("blocked"); } }, navigator: { language: "hi" } }), "hi");
  assert.equal(pickLang({ navigator: { language: "xx-YY" } }), "en");
  assert.equal(pickLang({}), "en");
  assert.equal(pickLang(null), "en");
  assert.equal(hintText("xx"), "Paused — tap to resume");
});
