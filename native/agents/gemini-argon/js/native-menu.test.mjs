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

  const toolsPanel = new El("div", "tools-panel");
  body.appendChild(toolsPanel);

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

  return { root, body, back, toolsPanel, doc, win };
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
  options: { scaling: "fit", showPad: true, showStats: true },
  setPadPreference: async () => {},
  onFallback: () => {},
};

// Import module under test
const {
  installNativeMenu,
  openNativeMenu,
  closeNativeMenu,
  resetNativeMenu,
  refreshMenuLabels,
  t,
  pickLang,
} = await import("./native-menu.js");

// ---- Test Suites ----

test("1. Opening via document.dispatchEvent('nb:native-menu') unhides #native-menu, hides #tools-panel, and calls plugin.pause()", async () => {
  resetNativeMenu();
  plugin = makePlugin();
  dom.win.nbNative = { plugin, game: { id: "test" }, onFallback: () => {} };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  // Ensure #tools-panel is present and not hidden initially
  dom.toolsPanel.classList.remove("hidden");
  assert.equal(dom.toolsPanel.classList.contains("hidden"), false);

  // Dispatch nb:native-menu on document
  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));

  const menuEl = dom.doc.getElementById("native-menu");
  assert.ok(menuEl, "#native-menu element should exist in DOM");
  assert.equal(menuEl.hidden, false, "menuEl.hidden must be false when opened");
  assert.equal(menuEl.classList.contains("hidden"), false, "menuEl must not have 'hidden' class");
  assert.equal(plugin.calls.pause, 1, "plugin.pause() must be called on open");
  assert.equal(dom.toolsPanel.classList.contains("hidden"), true, "#tools-panel must be defensively hidden on open");
});

test("2. Closing the menu hides #native-menu and calls plugin.resume() unless skipResume is true", async () => {
  // Part A: Normal close resumes
  resetNativeMenu();
  plugin = makePlugin();
  dom.win.nbNative = { plugin, game: { id: "test" }, onFallback: () => {} };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  const menuEl = dom.doc.getElementById("native-menu");
  assert.equal(menuEl.hidden, false);
  assert.equal(plugin.calls.pause, 1);

  // Close menu normally -> calls plugin.resume()
  closeNativeMenu();
  assert.equal(menuEl.hidden, true, "menuEl.hidden must be true when closed");
  assert.equal(menuEl.classList.contains("hidden"), true, "menuEl must have 'hidden' class when closed");
  assert.equal(plugin.calls.resume, 1, "plugin.resume() must be called on normal close");

  // Part B: Backdrop click closes menu and calls resume
  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  assert.equal(menuEl.hidden, false);
  menuEl.click(); // Clicking root element triggers backdrop close
  assert.equal(menuEl.hidden, true);
  assert.equal(plugin.calls.resume, 2, "Backdrop close must call plugin.resume()");

  // Part C: Resume button click closes menu and calls resume
  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  const resumeBtn = menuEl.querySelector('[data-action="resume"]');
  assert.ok(resumeBtn);
  resumeBtn.click();
  assert.equal(menuEl.hidden, true);
  assert.equal(plugin.calls.resume, 3, "Resume button click must call plugin.resume()");

  // Part D: closeNativeMenu({ skipResume: true }) does NOT call resume
  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  assert.equal(menuEl.hidden, false);
  closeNativeMenu({ skipResume: true });
  assert.equal(menuEl.hidden, true);
  assert.equal(plugin.calls.resume, 3, "plugin.resume() must NOT be called when skipResume is true");
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

test("4. Item 2: 'Use the classic player' awaits plugin.stop() before calling nbNative.onFallback() once, handles stop() rejection, and does not resume", async () => {
  // Case A: Awaits plugin.stop() before calling nbNative.onFallback()
  resetNativeMenu();
  plugin = makePlugin();
  let stopSettled = false;
  let fallbackCalledAfterStop = false;
  plugin.stop = async () => {
    await new Promise((r) => setTimeout(r, 20));
    stopSettled = true;
  };
  dom.win.nbNative = {
    plugin,
    game: { id: "test" },
    onFallback: () => {
      fallbackCalledAfterStop = stopSettled;
    },
  };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  const menuEl = dom.doc.getElementById("native-menu");
  const fallbackBtn = menuEl.querySelector('[data-action="fallback"]');
  assert.ok(fallbackBtn, "Fallback button must exist");

  const resumeBefore = plugin.calls.resume;
  fallbackBtn.click();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(stopSettled, true, "plugin.stop() must have settled");
  assert.equal(fallbackCalledAfterStop, true, "nbNative.onFallback() must be called AFTER plugin.stop() settles");
  assert.equal(menuEl.hidden, true, "Menu must be closed after fallback");
  assert.equal(plugin.calls.resume, resumeBefore, "Plugin must not resume on fallback");

  // Case B: Even if plugin.stop() rejects, awaits settlement and still calls onFallback()
  resetNativeMenu();
  plugin = makePlugin();
  plugin.stop = async () => {
    await new Promise((r) => setTimeout(r, 10));
    throw new Error("Simulated stop failure");
  };
  let fallbackInvoked = false;
  dom.win.nbNative = {
    plugin,
    game: { id: "test" },
    onFallback: () => {
      fallbackInvoked = true;
    },
  };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  const fallbackBtnB = menuEl.querySelector('[data-action="fallback"]');

  await assert.doesNotReject(async () => {
    fallbackBtnB.click();
    await new Promise((r) => setTimeout(r, 40));
  });

  assert.equal(fallbackInvoked, true, "onFallback must be called even if plugin.stop() rejects");
  assert.equal(menuEl.hidden, true);
  assert.equal(plugin.calls.resume, 0, "Plugin must not resume on fallback error");

  // Case C: Calling repeatedly invokes stop() and onFallback() only once
  resetNativeMenu();
  plugin = makePlugin();
  let stopCount = 0;
  let fallbackCount = 0;
  plugin.stop = async () => {
    stopCount++;
  };
  dom.win.nbNative = {
    plugin,
    game: { id: "test" },
    onFallback: () => {
      fallbackCount++;
    },
  };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  dom.doc.dispatchEvent(new FakeCustomEvent("nb:native-menu"));
  const fallbackBtnC = menuEl.querySelector('[data-action="fallback"]');

  fallbackBtnC.click();
  fallbackBtnC.click();
  fallbackBtnC.click();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(stopCount, 1, "plugin.stop() called exactly once");
  assert.equal(fallbackCount, 1, "nbNative.onFallback() called exactly once");
});

test("5. Item 1: Touch pad toggle calls nbNative.setPadPreference(v) (never plugin.setPadVisible), updates nbNative.options.showPad, and is disabled when setPadPreference is absent", async () => {
  // Case A: setPadPreference is present
  resetNativeMenu();
  plugin = makePlugin();
  let receivedPreference = null;
  const options = { showPad: true };
  dom.win.nbNative = {
    plugin,
    game: { id: "test" },
    options,
    setPadPreference: async (v) => {
      receivedPreference = v;
    },
  };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  openNativeMenu();
  const menuEl = dom.doc.getElementById("native-menu");
  const padBtn = menuEl.querySelector('[data-action="toggle-pad"]');
  assert.ok(padBtn, "Pad toggle button must exist");
  assert.equal(padBtn.disabled, false, "Pad button must be enabled when setPadPreference is a function");
  assert.equal(padBtn.getAttribute("disabled"), null);

  // Click 1: toggle pad to false
  padBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(receivedPreference, false, "nbNative.setPadPreference(false) called");
  assert.equal(options.showPad, false, "nbNative.options.showPad updated to false");
  assert.equal(plugin.calls.setPadVisible.length, 0, "plugin.setPadVisible must NEVER be called");
  assert.ok(padBtn.textContent.includes(t("off")), "Button text reflects Off");

  // Click 2: toggle pad back to true
  padBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(receivedPreference, true, "nbNative.setPadPreference(true) called");
  assert.equal(options.showPad, true, "nbNative.options.showPad updated to true");
  assert.equal(plugin.calls.setPadVisible.length, 0, "plugin.setPadVisible must NEVER be called");
  assert.ok(padBtn.textContent.includes(t("on")), "Button text reflects On");

  // Case B: setPadPreference is absent / not a function -> button disabled
  resetNativeMenu();
  plugin = makePlugin();
  const optionsB = { showPad: true };
  dom.win.nbNative = {
    plugin,
    game: { id: "test" },
    options: optionsB,
    // setPadPreference absent
  };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  openNativeMenu();
  assert.equal(padBtn.disabled, true, "Pad button must be disabled when setPadPreference is absent");
  assert.ok(padBtn.getAttribute("disabled") !== null, "Pad button must have disabled attribute");

  // Clicking disabled button must return early without doing anything
  padBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(optionsB.showPad, true, "options.showPad unchanged when disabled");
  assert.equal(plugin.calls.setPadVisible.length, 0, "plugin.setPadVisible must NEVER be called");
});

test("6. Item 3: data-label='save|load|scaling' labels refresh properly across language changes without overwriting each other", async () => {
  resetNativeMenu();
  plugin = makePlugin();
  dom.win.nbNative = { plugin, game: { id: "test" } };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  openNativeMenu();
  const menuEl = dom.doc.getElementById("native-menu");

  const saveLabel = menuEl.querySelector('[data-label="save"]');
  const loadLabel = menuEl.querySelector('[data-label="load"]');
  const scaleLabel = menuEl.querySelector('[data-label="scaling"]');

  assert.ok(saveLabel, "saveLabel with data-label='save' must exist");
  assert.ok(loadLabel, "loadLabel with data-label='load' must exist");
  assert.ok(scaleLabel, "scaleLabel with data-label='scaling' must exist");

  // 1. English
  localStorageStub.setItem("lang", "en");
  refreshMenuLabels();
  assert.equal(saveLabel.textContent, "Save state");
  assert.equal(loadLabel.textContent, "Load state");
  assert.equal(scaleLabel.textContent, "Screen scaling");

  // 2. Turkish
  localStorageStub.setItem("lang", "tr");
  refreshMenuLabels();
  assert.equal(saveLabel.textContent, "Durumu kaydet");
  assert.equal(loadLabel.textContent, "Durumu yükle");
  assert.equal(scaleLabel.textContent, "Ekran ölçekleme");

  // 3. German
  localStorageStub.setItem("lang", "de");
  refreshMenuLabels();
  assert.equal(saveLabel.textContent, "Spielstand speichern");
  assert.equal(loadLabel.textContent, "Spielstand laden");
  assert.equal(scaleLabel.textContent, "Bildschirmskalierung");

  // 4. Spanish
  localStorageStub.setItem("lang", "es");
  refreshMenuLabels();
  assert.equal(saveLabel.textContent, "Guardar estado");
  assert.equal(loadLabel.textContent, "Cargar estado");
  assert.equal(scaleLabel.textContent, "Escalado de pantalla");

  // Verify none overwrite each other
  assert.notEqual(saveLabel.textContent, loadLabel.textContent);
  assert.notEqual(saveLabel.textContent, scaleLabel.textContent);
  assert.notEqual(loadLabel.textContent, scaleLabel.textContent);
});

test("7. Item 4: Menu seeds scaling, showPad, showStats from nbNative.options (with defaults scaling: 'fit', showPad: true, showStats: true) and writes back after successful calls", async () => {
  // Case A: Defaults when options is absent
  resetNativeMenu();
  plugin = makePlugin();
  dom.win.nbNative = { plugin, game: { id: "test" }, setPadPreference: async () => {} };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  openNativeMenu();
  const menuEl = dom.doc.getElementById("native-menu");
  const fitBtn = menuEl.querySelector('[data-action="scaling"][data-mode="fit"]');
  const integerBtn = menuEl.querySelector('[data-action="scaling"][data-mode="integer"]');
  const stretchBtn = menuEl.querySelector('[data-action="scaling"][data-mode="stretch"]');
  const padBtn = menuEl.querySelector('[data-action="toggle-pad"]');
  const statsBtn = menuEl.querySelector('[data-action="toggle-stats"]');

  assert.ok(fitBtn.classList.contains("active"), "Default scaling button is fit");
  assert.equal(fitBtn.getAttribute("aria-pressed"), "true");
  assert.equal(integerBtn.classList.contains("active"), false);
  assert.equal(stretchBtn.classList.contains("active"), false);
  assert.ok(padBtn.textContent.includes(t("on")), "Default showPad is true");
  assert.ok(statsBtn.textContent.includes(t("on")), "Default showStats is true");

  // Case B: Seeding custom options
  resetNativeMenu();
  plugin = makePlugin();
  const customOpts = {
    scaling: "stretch",
    showPad: false,
    showStats: false,
  };
  dom.win.nbNative = {
    plugin,
    game: { id: "test" },
    options: customOpts,
    setPadPreference: async () => {},
  };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  openNativeMenu();
  assert.ok(stretchBtn.classList.contains("active"), "Seeded scaling button is stretch");
  assert.equal(stretchBtn.getAttribute("aria-pressed"), "true");
  assert.equal(fitBtn.classList.contains("active"), false);
  assert.equal(fitBtn.getAttribute("aria-pressed"), "false");
  assert.ok(padBtn.textContent.includes(t("off")), "Seeded showPad is false");
  assert.ok(statsBtn.textContent.includes(t("off")), "Seeded showStats is false");

  // Case C: Successful write-backs
  // 1. Scaling change
  integerBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(plugin.calls.setScaling.at(-1)?.mode, "integer");
  assert.equal(customOpts.scaling, "integer", "nbNative.options.scaling updated to integer");
  assert.ok(integerBtn.classList.contains("active"));
  assert.equal(stretchBtn.classList.contains("active"), false);

  // 2. Stats change
  statsBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(plugin.calls.setStatsVisible.at(-1)?.visible, true);
  assert.equal(customOpts.showStats, true, "nbNative.options.showStats updated to true");
  assert.ok(statsBtn.textContent.includes(t("on")));

  // 3. Pad change
  padBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(customOpts.showPad, true, "nbNative.options.showPad updated to true");
  assert.ok(padBtn.textContent.includes(t("on")));

  // Case D: Failure avoids write-back
  plugin.setScaling = async () => {
    throw new Error("scaling error");
  };
  fitBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(customOpts.scaling, "integer", "scaling option must NOT change on failure");

  plugin.setStatsVisible = async () => {
    throw new Error("stats error");
  };
  statsBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(customOpts.showStats, true, "showStats option must NOT change on failure");
});

test("8. Reset, quit, scaling modes, stats toggle, and Turkish / English i18n rendering", async () => {
  resetNativeMenu();
  plugin = makePlugin();
  dom.win.nbNative = { plugin, game: { id: "test" }, onFallback: () => {} };
  dom.win.Capacitor.Plugins.NativePlayer = plugin;

  openNativeMenu();
  const menuEl = dom.doc.getElementById("native-menu");

  // ---- 8a. Reset ----
  const resetBtn = menuEl.querySelector('[data-action="reset"]');
  assert.ok(resetBtn, "Reset button must exist");
  const resumeBeforeReset = plugin.calls.resume;
  resetBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(plugin.calls.reset, 1, "plugin.reset() must be called");
  assert.equal(menuEl.hidden, true, "Menu must be closed on reset");
  assert.equal(plugin.calls.resume, resumeBeforeReset + 1, "plugin.resume() must be called on reset");

  // Re-open menu for subsequent tests
  openNativeMenu();

  // ---- 8b. Quit ----
  const quitBtn = menuEl.querySelector('[data-action="quit"]');
  assert.ok(quitBtn, "Quit button must exist");
  const backEl = dom.doc.getElementById("back");
  backEl.clicks = 0;
  quitBtn.click();
  assert.equal(menuEl.hidden, true, "Menu hidden after quit");
  assert.equal(backEl.clicks, 1, "#back click triggered on quit");

  // ---- 8c. Turkish (tr) / English (en) i18n rendering ----
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

  const trFit = t("scalingFit"); // "Sığdır"
  const trStats = t("stats"); // "İstatistikler"
  const trTouch = t("touchPad"); // "Dokunmatik tuşlar"
  const trReset = t("reset"); // "Oyunu sıfırla"
  const trEmpty = t("stateEmpty", { n: 1 }); // "Yuva 1 boş"
  const trUnavail = t("stateUnavailable"); // "Anlık kayıt bu sürümde henüz kullanılamıyor."

  assert.ok(trFit.includes("ğ"), "Turkish 'ğ' must be rendered correctly");
  assert.ok(trTouch.includes("ş"), "Turkish 'ş' must be rendered correctly");
  assert.ok(trReset.includes("ı") || trFit.includes("ı"), "Turkish 'ı' must be rendered correctly");
  assert.ok(trStats.includes("İ"), "Turkish capital 'İ' must be rendered correctly");

  const combinedTr = `${trFit} ${trStats} ${trTouch} ${trReset} ${trEmpty} ${trUnavail}`;
  for (const ch of ["ğ", "ş", "ı", "İ"]) {
    assert.ok(combinedTr.includes(ch), `Turkish text must include character '${ch}'`);
  }

  // Verification of English fallback
  localStorageStub.setItem("lang", "en");
  assert.equal(pickLang(), "en");
  assert.equal(t("scalingFit"), "Fit");
  assert.equal(t("scalingInteger"), "Integer");
  assert.equal(t("scalingStretch"), "Stretch");
  assert.equal(t("resume"), "Resume");
  assert.equal(t("useClassicPlayer"), "Use the classic player");
  assert.equal(t("stateEmpty", { n: 3 }), "Slot 3 is empty");
});
