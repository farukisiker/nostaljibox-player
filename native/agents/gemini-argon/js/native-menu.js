// SPDX-License-Identifier: GPL-3.0-or-later

import de from "./locales/de.json" with { type: "json" };
import en from "./locales/en.json" with { type: "json" };
import es from "./locales/es.json" with { type: "json" };
import fr from "./locales/fr.json" with { type: "json" };
import hi from "./locales/hi.json" with { type: "json" };
import id from "./locales/id.json" with { type: "json" };
import it from "./locales/it.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };
import ko from "./locales/ko.json" with { type: "json" };
import pt from "./locales/pt.json" with { type: "json" };
import ru from "./locales/ru.json" with { type: "json" };
import tr from "./locales/tr.json" with { type: "json" };
import zh from "./locales/zh.json" with { type: "json" };

const LOCALES = { de, en, es, fr, hi, id, it, ja, ko, pt, ru, tr, zh };
const SUPPORTED_CODES = ["en", "tr", "es", "pt", "fr", "de", "it", "ru", "ja", "ko", "zh", "hi", "id"];

export function pickLang() {
  try {
    const saved = globalThis.localStorage?.getItem?.("lang");
    if (saved && SUPPORTED_CODES.includes(saved)) {
      return saved;
    }
  } catch {}

  try {
    const nav = globalThis.navigator;
    const tags = nav?.languages || (nav?.language ? [nav.language] : []);
    for (const tag of tags) {
      const base = String(tag || "").toLowerCase().split("-")[0];
      if (SUPPORTED_CODES.includes(base)) {
        return base;
      }
    }
  } catch {}

  try {
    const docLang =
      globalThis.document?.documentElement?.lang ||
      globalThis.document?.documentElement?.getAttribute?.("lang");
    if (docLang) {
      const base = String(docLang).toLowerCase().split("-")[0];
      if (SUPPORTED_CODES.includes(base)) {
        return base;
      }
    }
  } catch {}

  return "en";
}

export function t(key, vars) {
  const current = pickLang();
  const dict = LOCALES[current] || {};
  const fallback = LOCALES["en"] || {};
  const text = dict[key] ?? fallback[key] ?? key;
  return vars ? String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : text;
}

let menuEl = null;
let padVisible = true;
let statsVisible = true;
let currentScaling = "fit";
let fallbackTriggered = false;
let boundDoc = null;

function isMenuOpen() {
  if (!menuEl) return false;
  return !menuEl.hidden && !menuEl.classList?.contains("hidden");
}

function getNoteEl() {
  return menuEl?.querySelector?.("#native-menu-state-note") || globalThis.document?.getElementById?.("native-menu-state-note");
}

function disableStateButtons() {
  const stateBtns = menuEl?.querySelectorAll?.("[data-action='save-state'], [data-action='load-state']") || [];
  for (const btn of stateBtns) {
    btn.disabled = true;
    btn.setAttribute?.("disabled", "");
  }
}

async function handleAction(action, btn) {
  if (btn?.disabled) return;

  const nbNative = globalThis.window?.nbNative;
  const plugin = nbNative?.plugin ?? globalThis.window?.Capacitor?.Plugins?.NativePlayer;

  switch (action) {
    case "resume": {
      closeNativeMenu();
      break;
    }
    case "reset": {
      try {
        await plugin?.reset?.();
      } catch {}
      closeNativeMenu();
      break;
    }
    case "save-state": {
      const slot = Number(btn.getAttribute?.("data-slot") || btn.dataset?.slot);
      const noteEl = getNoteEl();
      if (!plugin?.saveState) {
        disableStateButtons();
        if (noteEl) {
          noteEl.hidden = false;
          noteEl.classList?.remove("hidden");
          noteEl.textContent = t("stateUnavailable");
        }
        return;
      }
      try {
        await plugin.saveState({ slot });
        if (noteEl) {
          noteEl.hidden = false;
          noteEl.classList?.remove("hidden");
          noteEl.textContent = t("stateSaved", { n: slot });
        }
      } catch (err) {
        if (err?.code === "unavailable") {
          disableStateButtons();
          if (noteEl) {
            noteEl.hidden = false;
            noteEl.classList?.remove("hidden");
            noteEl.textContent = t("stateUnavailable");
          }
        } else {
          if (noteEl) {
            noteEl.hidden = false;
            noteEl.classList?.remove("hidden");
            noteEl.textContent = err?.message || String(err);
          }
        }
      }
      break;
    }
    case "load-state": {
      const slot = Number(btn.getAttribute?.("data-slot") || btn.dataset?.slot);
      const noteEl = getNoteEl();
      if (!plugin?.loadState) {
        disableStateButtons();
        if (noteEl) {
          noteEl.hidden = false;
          noteEl.classList?.remove("hidden");
          noteEl.textContent = t("stateUnavailable");
        }
        return;
      }
      try {
        await plugin.loadState({ slot });
        if (noteEl) {
          noteEl.hidden = false;
          noteEl.classList?.remove("hidden");
          noteEl.textContent = t("stateLoaded", { n: slot });
        }
      } catch (err) {
        if (err?.code === "unavailable") {
          disableStateButtons();
          if (noteEl) {
            noteEl.hidden = false;
            noteEl.classList?.remove("hidden");
            noteEl.textContent = t("stateUnavailable");
          }
        } else if (err?.code === "no-state") {
          if (noteEl) {
            noteEl.hidden = false;
            noteEl.classList?.remove("hidden");
            noteEl.textContent = t("stateEmpty", { n: slot });
          }
        } else {
          if (noteEl) {
            noteEl.hidden = false;
            noteEl.classList?.remove("hidden");
            noteEl.textContent = err?.message || String(err);
          }
        }
      }
      break;
    }
    case "scaling": {
      const mode = btn.getAttribute?.("data-mode") || btn.dataset?.mode;
      try {
        if (typeof plugin?.setScaling === "function") {
          await plugin.setScaling({ mode });
        }
        currentScaling = mode;
        if (nbNative?.options) {
          nbNative.options.scaling = mode;
        }
        const scaleBtns = menuEl?.querySelectorAll?.("[data-action='scaling']") || [];
        for (const b of scaleBtns) {
          const bMode = b.getAttribute?.("data-mode") || b.dataset?.mode;
          const isActive = bMode === mode;
          b.classList?.toggle?.("active", isActive);
          b.setAttribute?.("aria-pressed", isActive ? "true" : "false");
        }
      } catch {}
      break;
    }
    case "toggle-pad": {
      if (typeof nbNative?.setPadPreference !== "function") {
        return;
      }
      const next = !padVisible;
      try {
        await nbNative.setPadPreference(next);
        padVisible = next;
        if (nbNative?.options) {
          nbNative.options.showPad = next;
        }
        btn.textContent = `${t("touchPad")}: ${padVisible ? t("on") : t("off")}`;
      } catch {}
      break;
    }
    case "toggle-stats": {
      const next = !statsVisible;
      try {
        if (typeof plugin?.setStatsVisible === "function") {
          await plugin.setStatsVisible({ visible: next });
        }
        statsVisible = next;
        if (nbNative?.options) {
          nbNative.options.showStats = next;
        }
        btn.textContent = `${t("stats")}: ${statsVisible ? t("on") : t("off")}`;
      } catch {}
      break;
    }
    case "fallback": {
      closeNativeMenu({ skipResume: true });
      if (fallbackTriggered) return;
      fallbackTriggered = true;
      await Promise.resolve(plugin?.stop?.()).catch(() => {});
      nbNative?.onFallback?.();
      break;
    }
    case "quit": {
      closeNativeMenu({ skipResume: true });
      const back = globalThis.document?.getElementById?.("back");
      if (back && typeof back.click === "function") {
        back.click();
      } else {
        try {
          await plugin?.stop?.();
        } catch {}
        if (typeof globalThis.location !== "undefined") {
          globalThis.location.href = "../index.html?from=game";
        }
      }
      break;
    }
  }
}

function buildMenuContent(root) {
  const doc = globalThis.document;
  if (!doc || typeof doc.createElement !== "function") return;

  root.hidden = true;
  root.classList?.add("hidden");

  root.addEventListener?.("click", (e) => {
    if (e.target === root) {
      closeNativeMenu();
    }
  });

  const panel = doc.createElement("div");
  panel.className = "native-menu-panel";

  const title = doc.createElement("h3");
  title.className = "native-menu-title";
  title.textContent = t("menuTitle");
  panel.appendChild(title);

  const note = doc.createElement("div");
  note.id = "native-menu-state-note";
  note.className = "native-menu-note hidden";
  note.hidden = true;
  panel.appendChild(note);

  // Resume
  const btnResume = doc.createElement("button");
  btnResume.type = "button";
  btnResume.className = "primary";
  btnResume.setAttribute("data-action", "resume");
  btnResume.textContent = t("resume");
  btnResume.addEventListener?.("click", (e) => {
    e.stopPropagation?.();
    handleAction("resume", btnResume);
  });
  panel.appendChild(btnResume);

  // Reset
  const btnReset = doc.createElement("button");
  btnReset.type = "button";
  btnReset.setAttribute("data-action", "reset");
  btnReset.textContent = t("reset");
  btnReset.addEventListener?.("click", (e) => {
    e.stopPropagation?.();
    handleAction("reset", btnReset);
  });
  panel.appendChild(btnReset);

  // Save states
  const saveLabel = doc.createElement("div");
  saveLabel.className = "native-menu-label";
  saveLabel.setAttribute("data-label", "save");
  saveLabel.textContent = t("saveState");
  panel.appendChild(saveLabel);

  const saveGroup = doc.createElement("div");
  saveGroup.className = "native-menu-btn-group";
  for (let slot = 1; slot <= 3; slot++) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-action", "save-state");
    btn.setAttribute("data-slot", String(slot));
    btn.textContent = t("slot", { n: slot });
    btn.addEventListener?.("click", (e) => {
      e.stopPropagation?.();
      handleAction("save-state", btn);
    });
    saveGroup.appendChild(btn);
  }
  panel.appendChild(saveGroup);

  // Load states
  const loadLabel = doc.createElement("div");
  loadLabel.className = "native-menu-label";
  loadLabel.setAttribute("data-label", "load");
  loadLabel.textContent = t("loadState");
  panel.appendChild(loadLabel);

  const loadGroup = doc.createElement("div");
  loadGroup.className = "native-menu-btn-group";
  for (let slot = 1; slot <= 3; slot++) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-action", "load-state");
    btn.setAttribute("data-slot", String(slot));
    btn.textContent = t("slot", { n: slot });
    btn.addEventListener?.("click", (e) => {
      e.stopPropagation?.();
      handleAction("load-state", btn);
    });
    loadGroup.appendChild(btn);
  }
  panel.appendChild(loadGroup);

  // Scaling
  const scaleLabel = doc.createElement("div");
  scaleLabel.className = "native-menu-label";
  scaleLabel.setAttribute("data-label", "scaling");
  scaleLabel.textContent = t("scaling");
  panel.appendChild(scaleLabel);

  const scaleGroup = doc.createElement("div");
  scaleGroup.className = "native-menu-btn-group";
  for (const mode of ["fit", "integer", "stretch"]) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-action", "scaling");
    btn.setAttribute("data-mode", mode);
    const isActive = mode === currentScaling;
    if (isActive) btn.classList?.add("active");
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    const modeKey = mode === "fit" ? "scalingFit" : mode === "integer" ? "scalingInteger" : "scalingStretch";
    btn.textContent = t(modeKey);
    btn.addEventListener?.("click", (e) => {
      e.stopPropagation?.();
      handleAction("scaling", btn);
    });
    scaleGroup.appendChild(btn);
  }
  panel.appendChild(scaleGroup);

  // Toggle pad
  const btnPad = doc.createElement("button");
  btnPad.type = "button";
  btnPad.setAttribute("data-action", "toggle-pad");
  btnPad.textContent = `${t("touchPad")}: ${padVisible ? t("on") : t("off")}`;
  const nbNative = globalThis.window?.nbNative;
  if (typeof nbNative?.setPadPreference !== "function") {
    btnPad.disabled = true;
    btnPad.setAttribute?.("disabled", "");
  }
  btnPad.addEventListener?.("click", (e) => {
    e.stopPropagation?.();
    handleAction("toggle-pad", btnPad);
  });
  panel.appendChild(btnPad);

  // Toggle stats
  const btnStats = doc.createElement("button");
  btnStats.type = "button";
  btnStats.setAttribute("data-action", "toggle-stats");
  btnStats.textContent = `${t("stats")}: ${statsVisible ? t("on") : t("off")}`;
  btnStats.addEventListener?.("click", (e) => {
    e.stopPropagation?.();
    handleAction("toggle-stats", btnStats);
  });
  panel.appendChild(btnStats);

  // Fallback
  const btnFallback = doc.createElement("button");
  btnFallback.type = "button";
  btnFallback.setAttribute("data-action", "fallback");
  btnFallback.textContent = t("useClassicPlayer");
  btnFallback.addEventListener?.("click", (e) => {
    e.stopPropagation?.();
    handleAction("fallback", btnFallback);
  });
  panel.appendChild(btnFallback);

  // Quit
  const btnQuit = doc.createElement("button");
  btnQuit.type = "button";
  btnQuit.className = "danger";
  btnQuit.setAttribute("data-action", "quit");
  btnQuit.textContent = t("quit");
  btnQuit.addEventListener?.("click", (e) => {
    e.stopPropagation?.();
    handleAction("quit", btnQuit);
  });
  panel.appendChild(btnQuit);

  root.appendChild(panel);
  root._built = true;
}

export function refreshMenuLabels() {
  if (!menuEl) return;
  const title = menuEl.querySelector?.(".native-menu-title");
  if (title) title.textContent = t("menuTitle");

  const btnResume = menuEl.querySelector?.('[data-action="resume"]');
  if (btnResume) btnResume.textContent = t("resume");

  const btnReset = menuEl.querySelector?.('[data-action="reset"]');
  if (btnReset) btnReset.textContent = t("reset");

  const saveLabel = menuEl.querySelector?.('[data-label="save"]');
  if (saveLabel) saveLabel.textContent = t("saveState");

  for (let slot = 1; slot <= 3; slot++) {
    const sBtn = menuEl.querySelector?.(`[data-action="save-state"][data-slot="${slot}"]`);
    if (sBtn) sBtn.textContent = t("slot", { n: slot });
    const lBtn = menuEl.querySelector?.(`[data-action="load-state"][data-slot="${slot}"]`);
    if (lBtn) lBtn.textContent = t("slot", { n: slot });
  }

  const loadLabel = menuEl.querySelector?.('[data-label="load"]');
  if (loadLabel) loadLabel.textContent = t("loadState");

  const scaleLabel = menuEl.querySelector?.('[data-label="scaling"]');
  if (scaleLabel) scaleLabel.textContent = t("scaling");

  for (const mode of ["fit", "integer", "stretch"]) {
    const modeKey = mode === "fit" ? "scalingFit" : mode === "integer" ? "scalingInteger" : "scalingStretch";
    const scBtn = menuEl.querySelector?.(`[data-action="scaling"][data-mode="${mode}"]`);
    if (scBtn) {
      scBtn.textContent = t(modeKey);
      const isActive = mode === currentScaling;
      scBtn.classList?.toggle?.("active", isActive);
      scBtn.setAttribute?.("aria-pressed", isActive ? "true" : "false");
    }
  }

  const btnPad = menuEl.querySelector?.('[data-action="toggle-pad"]');
  if (btnPad) {
    btnPad.textContent = `${t("touchPad")}: ${padVisible ? t("on") : t("off")}`;
    const nbNative = globalThis.window?.nbNative;
    if (typeof nbNative?.setPadPreference !== "function") {
      btnPad.disabled = true;
      btnPad.setAttribute?.("disabled", "");
    } else {
      btnPad.disabled = false;
      btnPad.removeAttribute?.("disabled");
    }
  }

  const btnStats = menuEl.querySelector?.('[data-action="toggle-stats"]');
  if (btnStats) {
    btnStats.textContent = `${t("stats")}: ${statsVisible ? t("on") : t("off")}`;
  }

  const btnFallback = menuEl.querySelector?.('[data-action="fallback"]');
  if (btnFallback) btnFallback.textContent = t("useClassicPlayer");

  const btnQuit = menuEl.querySelector?.('[data-action="quit"]');
  if (btnQuit) btnQuit.textContent = t("quit");
}

function getOrCreateMenuEl() {
  const doc = globalThis.document;
  if (!doc) return null;

  if (!menuEl) {
    menuEl = doc.getElementById?.("native-menu");
  }

  if (!menuEl && typeof doc.createElement === "function") {
    menuEl = doc.createElement("div");
    menuEl.id = "native-menu";
    menuEl.hidden = true;
    menuEl.classList?.add("hidden");
    doc.body?.appendChild?.(menuEl);
  }

  if (menuEl && !menuEl._built) {
    buildMenuContent(menuEl);
  }

  return menuEl;
}

export function openNativeMenu() {
  const nbNative = globalThis.window?.nbNative;
  const plugin = nbNative?.plugin ?? globalThis.window?.Capacitor?.Plugins?.NativePlayer;
  if (!plugin && !nbNative) return false;

  currentScaling = nbNative?.options?.scaling ?? "fit";
  padVisible = nbNative?.options?.showPad ?? true;
  statsVisible = nbNative?.options?.showStats ?? true;

  globalThis.document?.getElementById?.("tools-panel")?.classList?.add?.("hidden");

  const el = getOrCreateMenuEl();
  if (!el) return false;

  refreshMenuLabels();

  el.hidden = false;
  el.classList?.remove("hidden");

  try {
    Promise.resolve(plugin?.pause?.()).catch(() => {});
  } catch {}

  return true;
}

export function closeNativeMenu({ skipResume = false } = {}) {
  const el = getOrCreateMenuEl();
  if (el) {
    el.hidden = true;
    el.classList?.add("hidden");
  }

  const nbNative = globalThis.window?.nbNative;
  const plugin = nbNative?.plugin ?? globalThis.window?.Capacitor?.Plugins?.NativePlayer;

  if (!skipResume) {
    try {
      Promise.resolve(plugin?.resume?.()).catch(() => {});
    } catch {}
  }
}

function handleMenuEvent() {
  const nbNative = globalThis.window?.nbNative;
  const plugin = nbNative?.plugin ?? globalThis.window?.Capacitor?.Plugins?.NativePlayer;
  if (!plugin && !nbNative) return;

  if (isMenuOpen()) {
    closeNativeMenu();
  } else {
    openNativeMenu();
  }
}

export function installNativeMenu() {
  const doc = globalThis.document;
  if (doc && typeof doc.addEventListener === "function") {
    if (boundDoc !== doc) {
      doc.addEventListener("nb:native-menu", handleMenuEvent);
      boundDoc = doc;
    }
  }
}

export function resetNativeMenu() {
  closeNativeMenu({ skipResume: true });
  if (menuEl) {
    menuEl.hidden = true;
    menuEl.classList?.add("hidden");
    const noteEl = menuEl.querySelector?.("#native-menu-state-note");
    if (noteEl) {
      noteEl.hidden = true;
      noteEl.classList?.add("hidden");
      noteEl.textContent = "";
    }
    const stateBtns = menuEl.querySelectorAll?.("[data-action='save-state'], [data-action='load-state']") || [];
    for (const btn of stateBtns) {
      btn.disabled = false;
      btn.removeAttribute?.("disabled");
    }
  }
  menuEl = null;
  padVisible = true;
  statsVisible = true;
  currentScaling = "fit";
  fallbackTriggered = false;
}

// Automatically install listener on module load
installNativeMenu();
