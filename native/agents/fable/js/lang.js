// SPDX-License-Identifier: GPL-3.0-or-later
// The one language choice for this folder, the same rule as shared/i18n.js pick(): the library's
// saved language (localStorage "lang") when it is one of the app's 13, else the first of the
// phone's languages (navigator.languages, then navigator.language) that is, else English.
// `win` is injectable for the tests. Never throws.
// The codes are exactly the files in shared/locales/*.json (checked by strings.test.mjs).
export const APP_LANGS = ["de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "pt", "ru", "tr", "zh"];

export function pickLang(win = globalThis) {
  let saved = null;
  try {
    saved = win?.localStorage?.getItem("lang") ?? null;
  } catch {
    // storage blocked (private mode): the phone decides
  }
  if (APP_LANGS.includes(saved)) return saved;
  const tags = win?.navigator?.languages || [win?.navigator?.language];
  for (const tag of tags || []) {
    const base = String(tag || "").toLowerCase().split("-")[0];
    if (APP_LANGS.includes(base)) return base;
  }
  return "en";
}

// Same substitution as shared/i18n.js t(): "{mine}" → vars.mine; a placeholder with no value stays.
export function fill(text, vars) {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : text;
}
