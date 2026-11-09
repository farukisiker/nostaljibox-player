// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";

// ---- Lightweight DOM and Plugin stubs ----

function matchesSimpleSelector(el, sel) {
  sel = sel.trim();
  if (sel.startsWith("#")) {
    return el.id === sel.slice(1);
  }
  if (sel.startsWith(".")) {
    return el.classList?.contains?.(sel.slice(1));
  }
  if (sel.startsWith("[") && sel.endsWith("]")) {
    const inner = sel.slice(1, -1);
    const eqIdx = inner.indexOf("=");
    if (eqIdx >= 0) {
      const key = inner.slice(0, eqIdx).trim();
      let val = inner.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      return el.getAttribute?.(key) === val;
    }
    return el.hasAttribute?.(inner);
  }
  if (/^[a-zA-Z0-9]+$/.test(sel)) {
    return el.tagName?.toLowerCase() === sel.toLowerCase();
  }
  return false;
}

function matchesSelector(el, selector) {
  const parts = selector.split(",").map((s) => s.trim());
  return parts.some((part) => {
    // support compound selectors like button[data-action="resume"]
    const tagMatch = part.match(/^([a-zA-Z0-9]+)(\[.*\])$/);
    if (tagMatch) {
      return el.tagName?.toLowerCase() === tagMatch[1].toLowerCase() && matchesSimpleSelector(el, tagMatch[2]);
    }
    const multiAttr = part.match(/^\[(.*?)\]\[(.*?)\]$/);
    if (multiAttr) {
      return matchesSimpleSelector(el, `[${multiAttr[1]}]`) && matchesSimpleSelector(el, `[${multiAttr[2]}]`);
    }
    return matchesSimpleSelector(el, part);
  });
}

class FakeClassList {
  constructor(initial = []) {
    this._set = new Set(initial);
  }
  add(...classes) {
    for (const c of classes) if (c) this._set.add(c);
  }
  remove(...classes) {
    for (const c of classes) if (c) this._set.delete(c);
  }
  contains(c) {
    return this._set.has(c);
  }
  toggle(c, force) {
    if (force !== undefined) {
      if (force) this._set.add(c);
      else this._set.delete(c);
      return force;
    }
    if (this._set.has(c)) {
      this._set.delete(c);
      return false;
    }
    this._set.add(c);
    return true;
  }
  toString() {
    return Array.from(this._set).join(" ");
  }
}

class El {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.clicks = 0;
    this.children = [];
    this.parentNode = null;
    this._attributes = new Map();
    this.classList = new FakeClassList();
    this._listeners = [];
    this._textContent = "";
  }

  get className() {
    return this.classList.toString();
  }

  set className(val) {
    this.classList = new FakeClassList(String(val || "").split(/\s+/).filter(Boolean));
  }

  get lang() {
    return this.getAttribute("lang") || "";
  }

  set lang(val) {
    this.setAttribute("lang", val);
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(val) {
    this._textContent = String(val);
  }

  get dataset() {
    const ds = {};
    for (const [k, v] of this._attributes.entries()) {
      if (k.startsWith("data-")) {
        const prop = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        ds[prop] = v;
      }
    }
    return ds;
  }

  appendChild(child) {
    if (!child) return;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(k, v) {
    this._attributes.set(k, String(v));
    if (k === "disabled") {
      this.disabled = true;
    }
    if (k === "id") {
      this.id = String(v);
    }
    if (k === "class") {
      this.className = String(v);
    }
  }

  getAttribute(k) {
    return this._attributes.get(k) ?? null;
  }

  hasAttribute(k) {
    return this._attributes.has(k);
  }

  removeAttribute(k) {
    this._attributes.delete(k);
    if (k === "disabled") {
      this.disabled = false;
    }
  }

  closest(sel) {
    let curr = this;
    while (curr) {
      if (matchesSelector(curr, sel)) return curr;
      curr = curr.parentNode;
    }
    return null;
  }

  querySelector(sel) {
    for (const child of this.children) {
      if (matchesSelector(child, sel)) return child;
      const found = child.querySelector(sel);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(sel) {
    const results = [];
    for (const child of this.children) {
      if (matchesSelector(child, sel)) results.push(child);
      results.push(...child.querySelectorAll(sel));
    }
    return results;
  }

  addEventListener(type, fn, capture = false) {
    this._listeners.push({ type, fn, capture });
  }

  removeEventListener(type, fn, capture = false) {
    this._listeners = this._listeners.filter(
      (l) => !(l.type === type && l.fn === fn && l.capture === capture)
    );
  }

  dispatchEvent(ev) {
    ev.target = this;
    for (const l of [...this._listeners]) {
      if (l.type === ev.type) {
        l.fn(ev);
      }
    }
    return true;
  }

  click() {
    this.clicks++;
    this.dispatchEvent({
      type: "click",
      target: this,
      preventDefault: () => {},
      stopPropagation: () => {},
      stopImmediatePropagation: () => {},
    });
  }
}

class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
    this.target = null;
  }
}

function makeDom() {
  const root = new El("html");
  root.id = "html";
  const body = new El("body");
  root.appendChild(body);

  const back = new El("button", "back");
  body.appendChild(back);

  const docListeners = [];
  const winListeners = [];

  const doc = {
    title: "",
    documentElement: root,
    body,
    createElement: (tag) => new El(tag),
    getElementById: (id) => {
      if (id === "html") return root;
      if (id === "body") return body;
      return root.querySelector(`#${id}`);
    },
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    addEventListener: (type, fn, capture = false) => {
      docListeners.push({ type, fn, capture });
    },
    removeEventListener: (type, fn, capture = false) => {
      const idx = docListeners.findIndex(
        (l) => l.type === type && l.fn === fn && l.capture === capture
      );
      if (idx >= 0) docListeners.splice(idx, 1);
    },
    dispatchEvent: (ev) => {
      ev.target = doc;
      for (const l of [...docListeners]) {
        if (l.type === ev.type) l.fn(ev);
      }
      return true;
    },
  };

  const win = {
    location: { href: "http://localhost/play.html" },
    addEventListener: (type, fn, capture = false) => {
      winListeners.push({ type, fn, capture });
    },
    removeEventListener: (type, fn, capture = false) => {
      const idx = winListeners.findIndex(
        (l) => l.type === type && l.fn === fn && l.capture === capture
      );
      if (idx >= 0) winListeners.splice(idx, 1);
    },
    dispatchEvent: (ev) => {
      ev.target = win;
      for (const l of [...winListeners]) {
        if (l.type === ev.type) l.fn(ev);
      }
      return true;
    },
  };

  return { root, body, back, doc, win };
}

function makePlugin() {
  const calls = {
    pause: 0,
    resume: 0,
    reset: 0,
    stop: 0,
    saveState: [],
    loadState: [],
    setScaling: [],
    setPadVisible: [],
    setStatsVisible: [],
  };
  const handlers = {};
  return {
    calls,
    pause: async () => {
      calls.pause++;
      return {};
    },
    resume: async () => {
      calls.resume++;
      return {};
    },
    reset: async () => {
      calls.reset++;
      return {};
    },
    stop: async () => {
      calls.stop++;
      return {};
    },
    saveState: async (args) => {
      calls.saveState.push(args);
      return {};
    },
    loadState: async (args) => {
      calls.loadState.push(args);
      return {};
    },
    setScaling: async (args) => {
      calls.setScaling.push(args);
      return {};
    },
    setPadVisible: async (args) => {
      calls.setPadVisible.push(args);
      return {};
    },
    setStatsVisible: async (args) => {
      calls.setStatsVisible.push(args);
      return {};
    },
    addListener: async (name, cb) => {
      (handlers[name] ||= []).push(cb);
      return {
        remove: async () => {
          handlers[name] = handlers[name].filter((h) => h !== cb);
        },
      };
    },
    emit: (name, payload) => {
      (handlers[name] || []).forEach((h) => h(payload));
    },
  };
}

// Global setup before module import
const dom = makeDom();
let plugin = makePlugin();
const storageStore = new Map();
const localStorageStub = {
  getItem: (k) => storageStore.get(k) ?? null,
  setItem: (k, v) => storageStore.set(k, String(v)),
  removeItem: (k) => storageStore.delete(k),
  clear: () => storageStore.clear(),
};

globalThis.document = dom.doc;
globalThis.window = dom.win;
globalThis.localStorage = localStorageStub;
function setNavigator(nav) {
  Object.defineProperty(globalThis, "navigator", {
    value: nav,
    configurable: true,
    writable: true,
  });
}
setNavigator({ languages: ["en-US", "en"], language: "en-US" });
globalThis.CustomEvent = FakeCustomEvent;
globalThis.location = dom.win.location;

dom.win.Capacitor = {
  getPlatform: () => "ios",
  Plugins: { NativePlayer: plugin },
};
dom.win.nbNative = {
  plugin,
  game: { id: "test-game", name: "Test Game", core: "supafaust" },
  onFallback: () => {},
};

// Import module under test
const {
  installNativeMenu,
  openNativeMenu,
  closeNativeMenu,
  resetNativeMenu,
  t,
  pickLang,
} = await import("./native-menu.js");

// ---- Test Suites ----

test("1. Opening via document.dispatchEvent('nb:native-menu') unhides #native-menu and calls plugin.pause()", async () => {
  resetNativeMenu();
  plugin = makePlugin();
  dom.win.nbNative = { plugin, game: { id: "test" }, onFallback: () => {} };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  // Dispatch nb:native-menu on document
  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));

  const menuEl = dom.doc.getElementById("native-menu");
  assert.ok(menuEl, "#native-menu element should exist in DOM");
  assert.equal(menuEl.hidden, false, "menuEl.hidden must be false when opened");
  assert.equal(menuEl.classList.contains("hidden"), false, "menuEl must not have 'hidden' class");
  assert.equal(plugin.calls.pause, 1, "plugin.pause() must be called on open");
});

test("2. Closing the menu hides #native-menu and calls plugin.resume() (and does NOT call plugin.resume() if paused before open)", async () => {
  // Part A: Normal close resumes
  resetNativeMenu();
  plugin = makePlugin();
  dom.win.nbNative = { plugin, game: { id: "test" }, onFallback: () => {} };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  const menuEl = dom.doc.getElementById("native-menu");
  assert.equal(menuEl.hidden, false);
  assert.equal(plugin.calls.pause, 1);

  // Close menu
  closeNativeMenu();
  assert.equal(menuEl.hidden, true, "menuEl.hidden must be true when closed");
  assert.equal(menuEl.classList.contains("hidden"), true, "menuEl must have 'hidden' class when closed");
  assert.equal(plugin.calls.resume, 1, "plugin.resume() must be called on normal close");

  // Part B: Paused before open (via plugin state event) does NOT call resume on close
  resetNativeMenu();
  plugin = makePlugin();
  dom.win.nbNative = { plugin, game: { id: "test" }, onFallback: () => {} };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;
  installNativeMenu();

  // User pauses externally before opening the menu
  plugin.emit("state", { state: "paused", reasons: ["user"] });

  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  assert.equal(menuEl.hidden, false);

  const resumeBefore = plugin.calls.resume;
  closeNativeMenu();
  assert.equal(menuEl.hidden, true);
  assert.equal(plugin.calls.resume, resumeBefore, "plugin.resume() must NOT be called if user paused before open");

  // Part C: Paused before open via nbNative.userPaused does NOT call resume on close
  resetNativeMenu();
  plugin = makePlugin();
  dom.win.nbNative = { plugin, game: { id: "test" }, userPaused: true, onFallback: () => {} };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  assert.equal(menuEl.hidden, false);

  const resumeCount = plugin.calls.resume;
  closeNativeMenu();
  assert.equal(menuEl.hidden, true);
  assert.equal(plugin.calls.resume, resumeCount, "plugin.resume() must NOT be called when nbNative.userPaused is true");

  // Part D: Resume button forces resume even if paused before open
  resetNativeMenu();
  plugin = makePlugin();
  dom.win.nbNative = { plugin, game: { id: "test" }, userPaused: true, onFallback: () => {} };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  const resumeBtn = menuEl.querySelector('[data-action="resume"]');
  assert.ok(resumeBtn, "Resume button must exist");

  const resumeCountBefore = plugin.calls.resume;
  resumeBtn.click();
  assert.equal(menuEl.hidden, true);
  assert.equal(plugin.calls.resume, resumeCountBefore + 1, "Resume button must force resume plugin");
});

test("3. Save state / Load state rejecting with { code: 'unavailable' } disables all save/load state buttons and displays note", async () => {
  resetNativeMenu();
  plugin = makePlugin();
  plugin.saveState = async () => {
    const err = new Error("Unavailable");
    err.code = "unavailable";
    throw err;
  };
  dom.win.nbNative = { plugin, game: { id: "test" }, onFallback: () => {} };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  const menuEl = dom.doc.getElementById("native-menu");
  const saveBtn1 = menuEl.querySelector('[data-action="save-state"][data-slot="1"]');
  assert.ok(saveBtn1, "Save state slot 1 button must exist");

  // Clicking unavailable save state should not throw
  await assert.doesNotReject(async () => {
    saveBtn1.click();
    // Allow microtasks to settle
    await new Promise((r) => setTimeout(r, 10));
  });

  const stateBtns = menuEl.querySelectorAll('[data-action="save-state"], [data-action="load-state"]');
  assert.equal(stateBtns.length, 6, "Must have exactly 6 save/load state buttons");
  for (const btn of stateBtns) {
    assert.equal(btn.disabled, true, "All 6 save/load buttons must be disabled");
    assert.ok(btn.getAttribute("disabled") !== null, "All 6 save/load buttons must have disabled attribute");
  }

  const noteEl = dom.doc.getElementById("native-menu-state-note");
  assert.ok(noteEl, "State note element must exist");
  assert.equal(noteEl.hidden, false, "State note element must be unhidden");
  assert.equal(noteEl.classList.contains("hidden"), false, "State note element must not have 'hidden' class");
  assert.equal(noteEl.textContent, t("stateUnavailable"), "State note must display stateUnavailable text");

  // Test loadState rejecting with { code: 'no-state' }
  resetNativeMenu();
  plugin = makePlugin();
  plugin.loadState = async () => {
    const err = new Error("No state");
    err.code = "no-state";
    throw err;
  };
  dom.win.nbNative = { plugin, game: { id: "test" }, onFallback: () => {} };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  const loadBtn2 = menuEl.querySelector('[data-action="load-state"][data-slot="2"]');
  assert.ok(loadBtn2);

  await assert.doesNotReject(async () => {
    loadBtn2.click();
    await new Promise((r) => setTimeout(r, 10));
  });

  // Buttons must NOT be disabled on no-state
  assert.equal(loadBtn2.disabled, false, "Buttons must not be disabled on no-state");
  assert.equal(noteEl.hidden, false);
  assert.equal(noteEl.textContent, t("stateEmpty", { n: 2 }), "Must display stateEmpty with slot number");
});

test("4. Clicking 'Use the classic player' calls nbNative.onFallback once (even if clicked twice) and does not resume", async () => {
  resetNativeMenu();
  plugin = makePlugin();
  let fallbackCalls = 0;
  dom.win.nbNative = {
    plugin,
    game: { id: "test" },
    onFallback: () => {
      fallbackCalls++;
    },
  };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  const menuEl = dom.doc.getElementById("native-menu");
  const fallbackBtn = menuEl.querySelector('[data-action="fallback"]');
  assert.ok(fallbackBtn, "Fallback button must exist");

  const resumeCountBefore = plugin.calls.resume;

  // Click twice
  fallbackBtn.click();
  fallbackBtn.click();

  assert.equal(fallbackCalls, 1, "onFallback must be called exactly once even when clicked repeatedly");
  assert.equal(menuEl.hidden, true, "Menu must be closed after fallback");
  assert.equal(plugin.calls.resume, resumeCountBefore, "Plugin must not resume on fallback");
});

test("5. Reset, scaling, touch pad toggle, stats toggle, Quit, and Turkish / English i18n rendering", async () => {
  resetNativeMenu();
  plugin = makePlugin();
  dom.win.nbNative = { plugin, game: { id: "test" }, onFallback: () => {} };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  const menuEl = dom.doc.getElementById("native-menu");

  // ---- 5a. Reset ----
  const resetBtn = menuEl.querySelector('[data-action="reset"]');
  assert.ok(resetBtn, "Reset button must exist");
  const resumeBeforeReset = plugin.calls.resume;
  resetBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(plugin.calls.reset, 1, "plugin.reset() must be called");
  assert.equal(menuEl.hidden, true, "Menu must be closed on reset");
  assert.equal(plugin.calls.resume, resumeBeforeReset + 1, "plugin.resume() must be called with forceResume on reset");

  // Re-open menu for subsequent tests
  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));

  // ---- 5b. Scaling (fit / integer / stretch) ----
  const integerBtn = menuEl.querySelector('[data-action="scaling"][data-mode="integer"]');
  const fitBtn = menuEl.querySelector('[data-action="scaling"][data-mode="fit"]');
  const stretchBtn = menuEl.querySelector('[data-action="scaling"][data-mode="stretch"]');
  assert.ok(integerBtn && fitBtn && stretchBtn, "All 3 scaling buttons must exist");

  integerBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(plugin.calls.setScaling.at(-1)?.mode, "integer", "plugin.setScaling({ mode: 'integer' }) called");
  assert.ok(integerBtn.classList.contains("active"), "integer button marked active");
  assert.equal(integerBtn.getAttribute("aria-pressed"), "true");
  assert.equal(fitBtn.classList.contains("active"), false, "fit button not active");
  assert.equal(fitBtn.getAttribute("aria-pressed"), "false");

  stretchBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(plugin.calls.setScaling.at(-1)?.mode, "stretch", "plugin.setScaling({ mode: 'stretch' }) called");
  assert.ok(stretchBtn.classList.contains("active"), "stretch button marked active");
  assert.equal(stretchBtn.getAttribute("aria-pressed"), "true");

  fitBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(plugin.calls.setScaling.at(-1)?.mode, "fit");
  assert.ok(fitBtn.classList.contains("active"));

  // ---- 5c. Touch pad toggle ----
  const padBtn = menuEl.querySelector('[data-action="toggle-pad"]');
  assert.ok(padBtn, "Toggle pad button must exist");
  padBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(plugin.calls.setPadVisible.at(-1)?.visible, false, "Touch pad toggled to false");
  assert.ok(padBtn.textContent.includes(t("off")), "Touch pad label reflects Off");

  padBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(plugin.calls.setPadVisible.at(-1)?.visible, true, "Touch pad toggled back to true");
  assert.ok(padBtn.textContent.includes(t("on")), "Touch pad label reflects On");

  // ---- 5d. Stats toggle ----
  const statsBtn = menuEl.querySelector('[data-action="toggle-stats"]');
  assert.ok(statsBtn, "Toggle stats button must exist");
  statsBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(plugin.calls.setStatsVisible.at(-1)?.visible, true, "Stats toggled to true");
  assert.ok(statsBtn.textContent.includes(t("on")), "Stats label reflects On");

  statsBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(plugin.calls.setStatsVisible.at(-1)?.visible, false, "Stats toggled back to false");
  assert.ok(statsBtn.textContent.includes(t("off")), "Stats label reflects Off");

  // ---- 5e. Quit ----
  const quitBtn = menuEl.querySelector('[data-action="quit"]');
  assert.ok(quitBtn, "Quit button must exist");
  const backEl = dom.doc.getElementById("back");
  backEl.clicks = 0;
  quitBtn.click();
  assert.equal(menuEl.hidden, true, "Menu hidden after quit");
  assert.equal(backEl.clicks, 1, "#back click triggered on quit");

  // ---- 5f. Turkish (tr) / English (en) i18n rendering ----
  // 1. Priority 1: localStorage
  localStorageStub.setItem("lang", "tr");
  assert.equal(pickLang(), "tr", "pickLang should pick 'tr' from localStorage");

  // 2. Priority 2: navigator.languages
  localStorageStub.clear();
  setNavigator({ languages: ["tr-TR", "tr"], language: "tr-TR" });
  assert.equal(pickLang(), "tr", "pickLang should pick 'tr' from navigator.languages");

  // 3. Priority 3: document.documentElement.lang
  setNavigator({ languages: ["xx"], language: "xx" });
  dom.doc.documentElement.setAttribute("lang", "tr");
  assert.equal(pickLang(), "tr", "pickLang should pick 'tr' from document.documentElement.lang");

  // 4. Fallback: en
  dom.doc.documentElement.removeAttribute("lang");
  setNavigator({ languages: [], language: "" });
  assert.equal(pickLang(), "en", "pickLang should fallback to 'en'");

  // Verification of Turkish special characters: ğ, ş, ı, İ
  localStorageStub.setItem("lang", "tr");
  assert.equal(pickLang(), "tr");

  const trFit = t("fit"); // "Sığdır"
  const trStats = t("stats"); // "İstatistikler"
  const trEmpty = t("stateEmpty", { n: 1 }); // "Yuva 1 boş"
  const trUnavail = t("stateUnavailable"); // "Anlık kayıt bu sürümde henüz kullanılamıyor."

  assert.ok(trFit.includes("ğ"), "Turkish 'ğ' must be rendered correctly");
  assert.ok(trEmpty.includes("ş"), "Turkish 'ş' must be rendered correctly");
  assert.ok(trFit.includes("ı") || trUnavail.includes("ı"), "Turkish 'ı' must be rendered correctly");
  assert.ok(trStats.includes("İ"), "Turkish capital 'İ' must be rendered correctly");

  const combinedTr = `${trFit} ${trStats} ${trEmpty} ${trUnavail}`;
  for (const ch of ["ğ", "ş", "ı", "İ"]) {
    assert.ok(combinedTr.includes(ch), `Turkish text must include character '${ch}'`);
  }

  // Verification of English fallback
  localStorageStub.setItem("lang", "en");
  assert.equal(pickLang(), "en");
  assert.equal(t("fit"), "Fit");
  assert.equal(t("resume"), "Resume");
  assert.equal(t("stateEmpty", { n: 3 }), "Slot 3 is empty");
});
