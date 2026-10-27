// SPDX-License-Identifier: MIT — part of nostaljibox-player/shared, usable outside the GPL player.
// App texts in 13 languages (locales/<code>.json). The phone's language is used unless the player
// picked one in the library; any other language gets English. EmulatorJS has its own menu
// translations, so each language also names the EmulatorJS file to load (Indonesian has none).
const files = import.meta.glob("./locales/*.json", { eager: true, import: "default" });
const dict = (code) => files[`./locales/${code}.json`] || {};

export const LANGUAGES = [
  { code: "en", name: "English", ejs: "en-US" },
  { code: "tr", name: "Türkçe", ejs: "tr-TR" },
  { code: "es", name: "Español", ejs: "es-ES" },
  { code: "pt", name: "Português (Brasil)", ejs: "pt-BR" },
  { code: "fr", name: "Français", ejs: "af-FR" },
  { code: "de", name: "Deutsch", ejs: "de-GER" },
  { code: "it", name: "Italiano", ejs: "it-IT" },
  { code: "ru", name: "Русский", ejs: "ru-RU" },
  { code: "ja", name: "日本語", ejs: "ja-JA" },
  { code: "ko", name: "한국어", ejs: "ko-KO" },
  { code: "zh", name: "简体中文", ejs: "zh-CN" },
  { code: "hi", name: "हिन्दी", ejs: "hi-HI" },
  { code: "id", name: "Bahasa Indonesia", ejs: "en-US" },
].filter((l) => files[`./locales/${l.code}.json`]);

const KEY = "lang";

function saved() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function pick() {
  const codes = LANGUAGES.map((l) => l.code);
  const choice = saved();
  if (codes.includes(choice)) return choice;
  for (const tag of navigator.languages || [navigator.language]) {
    const base = String(tag || "").toLowerCase().split("-")[0];
    if (codes.includes(base)) return base;
  }
  return "en";
}

export const lang = pick();
const texts = dict(lang);
const fallback = dict("en");

// t("addedMany", { n: 3 }) -> "3 games added"
export function t(key, vars) {
  const text = texts[key] ?? fallback[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : text;
}

export function ejsLanguage() {
  return LANGUAGES.find((l) => l.code === lang).ejs;
}

export function setLanguage(code) {
  try {
    localStorage.setItem(KEY, code);
  } catch {
    // private mode: the choice lasts until the page reloads
  }
}

// Fills elements marked data-i18n (text), data-i18n-html (our own markup: <b>, <i>),
// data-i18n-placeholder and data-i18n-label (aria-label).
export function translatePage(root = document) {
  document.documentElement.lang = lang;
  for (const e of root.querySelectorAll("[data-i18n]")) e.textContent = t(e.dataset.i18n);
  for (const e of root.querySelectorAll("[data-i18n-html]")) e.innerHTML = t(e.dataset.i18nHtml);
  for (const e of root.querySelectorAll("[data-i18n-placeholder]")) e.placeholder = t(e.dataset.i18nPlaceholder);
  for (const e of root.querySelectorAll("[data-i18n-label]")) e.setAttribute("aria-label", t(e.dataset.i18nLabel));
}
