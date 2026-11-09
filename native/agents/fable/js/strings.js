// SPDX-License-Identifier: GPL-3.0-or-later
// Netplay texts, English and Turkish only for now. N1-d moves these keys into shared/locales/*.json
// (13 languages); keep the key names when doing so.
const TABLE = {
  en: {
    peerMismatch: "Two-phone play needs the same version of the NostaljiBox iPhone app on both phones (you: {mine}, other phone: {theirs}).",
    guestOutdated: "The other phone's app is out of date; update both apps.",
    connectionLost: "Connection lost",
    guestStartFailed: "The game could not start on the other phone",
    guestBootFailed: "The game could not open on this phone ({code})",
    startTimeout: "The other phone did not start the game in time",
    unstableLink: "Unstable link",
    resyncFailed: "The phones could not be re-synced ({code})",
    backendEjs: "classic player",
    backendOld: "older version",
  },
  tr: {
    peerMismatch: "İki telefonlu oyun için iki telefon da aynı sürüm NostaljiBox iPhone uygulamasını kullanmalı (sende {mine}, karşıda {theirs}).",
    guestOutdated: "Misafirin uygulaması eski; ikisini de güncelleyin.",
    connectionLost: "Bağlantı koptu",
    guestStartFailed: "Misafirde oyun açılamadı",
    guestBootFailed: "Oyun bu telefonda açılamadı ({code})",
    startTimeout: "Karşı telefon oyunu zamanında başlatamadı",
    unstableLink: "Bağlantı kararsız",
    resyncFailed: "Telefonlar yeniden eşitlenemedi ({code})",
    backendEjs: "klasik oynatıcı",
    backendOld: "eski sürüm",
  },
};

// Same choice as shared/i18n.js: the library's saved language, else the phone's, else English.
export function pickLang(win = globalThis) {
  try {
    const saved = win.localStorage?.getItem("lang");
    if (saved && TABLE[saved]) return saved;
  } catch {
    // storage blocked
  }
  const tags = win.navigator?.languages || [win.navigator?.language];
  for (const tag of tags || []) {
    const base = String(tag || "").toLowerCase().split("-")[0];
    if (TABLE[base]) return base;
  }
  return "en";
}

export function nt(key, vars, lang = pickLang()) {
  const text = TABLE[lang]?.[key] ?? TABLE.en[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : text;
}

export const NETPLAY_KEYS = Object.keys(TABLE.en);
