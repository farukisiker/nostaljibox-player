// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/fable/js/
// The "Paused — tap to resume" hint: when it shows (non-user pause, no native menu), what a tap
// does, when it hides (running, stopped, pagehide), its language, and that it never counts as a
// pad-hiding overlay.
import test from "node:test";
import assert from "node:assert/strict";
import { fakePlugin } from "./fake-plugin.mjs";
import { OVERLAY_IDS } from "../../sonnet-5-5/js/native-mode.js";
import { installPausedHint, hintLang, hintText, wantsHint, PAUSED_HINT_ID } from "./paused-hint.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

// A plugin with the session methods the hint uses, every call recorded.
function hintPlugin(opts = {}) {
  const plugin = fakePlugin(opts);
  plugin.resume = (args) => {
    plugin.calls.push({ method: "resume", args });
    return plugin.fail.resume ? Promise.reject(plugin.fail.resume) : Promise.resolve({});
  };
  return plugin;
}

// The smallest DOM the hint needs: elements with id/hidden/style/classList/listeners, a body that
// keeps children, getElementById over everything created, plus a window with storage and language.
function dom({ lang = "en-US", saved = null, menuShown = false } = {}) {
  const all = [];
  const element = (tag) => {
    const classes = new Set();
    const handlers = new Map();
    const el = {
      tag,
      id: "",
      hidden: false,
      textContent: "",
      attrs: {},
      style: {},
      children: [],
      parentNode: null,
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      setAttribute: (k, v) => (el.attrs[k] = v),
      addEventListener: (type, fn) => (handlers.has(type) ? handlers.get(type) : handlers.set(type, new Set()).get(type)).add(fn),
      removeEventListener: (type, fn) => handlers.get(type)?.delete(fn),
      fire: (type, ev = {}) => [...(handlers.get(type) || [])].forEach((fn) => fn(ev)),
      appendChild: (child) => {
        el.children.push(child);
        child.parentNode = el;
      },
      remove: () => {
        if (!el.parentNode) return;
        const i = el.parentNode.children.indexOf(el);
        if (i >= 0) el.parentNode.children.splice(i, 1);
        el.parentNode = null;
      },
      listenerCount: (type) => handlers.get(type)?.size || 0,
    };
    all.push(el);
    return el;
  };
  const body = element("body");
  const menu = element("div");
  menu.id = "native-menu";
  menu.hidden = !menuShown;
  if (!menuShown) menu.classList.add("hidden");
  body.appendChild(menu);
  const doc = {
    body,
    documentElement: element("html"),
    createElement: element,
    getElementById: (id) => all.find((e) => e.id === id && e.parentNode) || null, // attached elements only, like the real one
  };
  const winHandlers = new Map();
  const win = {
    localStorage: { getItem: (k) => (k === "lang" ? saved : null) },
    navigator: { language: lang, languages: [lang] },
    addEventListener: (type, fn) => (winHandlers.has(type) ? winHandlers.get(type) : winHandlers.set(type, new Set()).get(type)).add(fn),
    removeEventListener: (type, fn) => winHandlers.get(type)?.delete(fn),
    fire: (type) => [...(winHandlers.get(type) || [])].forEach((fn) => fn({})),
    listenerCount: (type) => winHandlers.get(type)?.size || 0,
  };
  return { doc, win, body, menu, hint: () => doc.getElementById(PAUSED_HINT_ID) };
}

test("the hint's id is not one of native-mode's pad-hiding overlays", () => {
  assert.ok(!OVERLAY_IDS.includes(PAUSED_HINT_ID));
  assert.notEqual(PAUSED_HINT_ID, "native-menu");
});

test("without a plugin (Android, desktop) nothing is created and every method is a no-op", () => {
  const { doc, win, body } = dom();
  for (const plugin of [null, undefined, {}]) {
    const h = installPausedHint({ plugin, document: doc, window: win });
    assert.equal(h.isShown(), false);
    assert.equal(h.element, null);
    h.hide();
    h.dispose();
  }
  assert.equal(body.children.length, 1); // only the menu stub
  assert.equal(win.listenerCount("pagehide"), 0);
  // and with no document at all
  const h = installPausedHint({ plugin: hintPlugin(), document: null, window: win });
  assert.equal(h.isShown(), false);
});

test("wantsHint: any paused state, except when only configChange/background (they flash)", () => {
  assert.equal(wantsHint({ state: "paused", reasons: ["interruption"] }), true);
  assert.equal(wantsHint({ state: "paused", reasons: ["route"] }), true);
  assert.equal(wantsHint({ state: "paused", reasons: ["background", "user"] }), true);
  // an interruption that ended without shouldResume leaves only "user": the guest has no menu to tap
  assert.equal(wantsHint({ state: "paused", reasons: ["user"] }), true);
  assert.equal(wantsHint({ state: "paused", reasons: ["configChange", "user"] }), true);
  assert.equal(wantsHint({ state: "paused", reasons: ["background", "interruption"] }), true);
  assert.equal(wantsHint({ state: "paused", reasons: [] }), true); // paused with nothing listed is still stuck
  assert.equal(wantsHint({ state: "paused" }), true);
  // paused → running a moment later: no flash
  assert.equal(wantsHint({ state: "paused", reasons: ["configChange"] }), false);
  assert.equal(wantsHint({ state: "paused", reasons: ["background"] }), false);
  assert.equal(wantsHint({ state: "paused", reasons: ["background", "configChange"] }), false);
  assert.equal(wantsHint({ state: "running", reasons: [] }), false);
  assert.equal(wantsHint({ state: "running", reasons: ["route"] }), false);
  assert.equal(wantsHint(null), false);
  assert.equal(wantsHint({ state: "paused", reasons: "user" }), true); // a malformed list is not a reason to hide
});

test("configChange/background pauses do not flash the pill; the menu's user pause is covered by the menu", () => {
  const plugin = hintPlugin();
  const { doc, win, menu, hint } = dom();
  const h = installPausedHint({ plugin, document: doc, window: win });
  plugin.emit("state", { state: "paused", reasons: ["configChange"] }); // headphones plugged in
  assert.equal(h.isShown(), false);
  assert.equal(hint(), null);
  plugin.emit("state", { state: "running", reasons: [] });
  plugin.emit("state", { state: "paused", reasons: ["background"] }); // Control Center
  assert.equal(h.isShown(), false);
  plugin.emit("state", { state: "running", reasons: [] });
  assert.equal(hint(), null); // never even created

  // the host opens the menu: #native-menu is shown before pause() is called
  menu.hidden = false;
  menu.classList.remove("hidden");
  plugin.emit("state", { state: "paused", reasons: ["user"] });
  assert.equal(h.isShown(), false);
  // the guest after an interruption that ended without shouldResume: only "user", no menu anywhere
  menu.hidden = true;
  menu.classList.add("hidden");
  plugin.emit("state", { state: "paused", reasons: ["user"] });
  assert.equal(h.isShown(), true);
  hint().fire("click");
  assert.deepEqual(plugin.names(), ["resume"]);
  assert.equal(h.isShown(), false);
});

test("shows on a pause, stays hidden for a transient one, hides on running", () => {
  const plugin = hintPlugin();
  const { doc, win, hint } = dom();
  const h = installPausedHint({ plugin, document: doc, window: win });
  assert.equal(plugin.listenerCount("state"), 1);
  assert.equal(plugin.listenerCount("stopped"), 1);
  assert.equal(hint(), null); // created lazily: nothing in the DOM until it is needed

  plugin.emit("state", { state: "paused", reasons: ["configChange"] });
  assert.equal(h.isShown(), false);
  assert.equal(hint(), null);

  plugin.emit("state", { state: "paused", reasons: ["interruption"] });
  assert.equal(h.isShown(), true);
  const el = hint();
  assert.ok(el);
  assert.equal(el.textContent, "Paused — tap to resume");
  assert.equal(el.parentNode, doc.body);
  assert.match(el.attrs.style, /position:fixed/);
  assert.match(el.attrs.style, /left:50%;top:50%/);
  assert.match(el.attrs.style, /z-index:15;/); // above the game, below the play.css sheets (.overlay 20) and #native-menu (60)
  assert.match(el.attrs.style, /max-width:min\(240px,32vw\)/); // clear of the pad's touch areas in landscape
  assert.doesNotMatch(el.attrs.style, /white-space:\s*nowrap/); // the text wraps inside that width
  assert.equal(el.attrs.role, "button");

  plugin.emit("state", { state: "running", reasons: [] });
  assert.equal(h.isShown(), false);
  assert.equal(el.hidden, true);
  assert.equal(el.style.display, "none");

  plugin.emit("state", { state: "paused", reasons: ["route", "user"] }); // menu pause on top of a route loss
  assert.equal(h.isShown(), true);
  assert.equal(hint(), el); // the same element is reused
  assert.equal(el.style.display, "");
});

test("not shown while #native-menu is visible; shown once it is hidden again", () => {
  const plugin = hintPlugin();
  const { doc, win, menu } = dom({ menuShown: true });
  const h = installPausedHint({ plugin, document: doc, window: win });
  plugin.emit("state", { state: "paused", reasons: ["interruption"] });
  assert.equal(h.isShown(), false);
  menu.hidden = true;
  menu.classList.add("hidden");
  plugin.emit("state", { state: "paused", reasons: ["interruption"] });
  assert.equal(h.isShown(), true);
  // a menu that is "hidden" only through the class or only through the attribute counts as hidden too
  menu.hidden = false;
  plugin.emit("state", { state: "paused", reasons: ["interruption"] });
  assert.equal(h.isShown(), true);
  menu.classList.remove("hidden");
  plugin.emit("state", { state: "paused", reasons: ["interruption"] });
  assert.equal(h.isShown(), false);
});

test("a tap hides the hint and calls plugin.resume once; a rejected resume is swallowed", async () => {
  const plugin = hintPlugin();
  const { doc, win, hint } = dom();
  const h = installPausedHint({ plugin, document: doc, window: win });
  plugin.emit("state", { state: "paused", reasons: ["route"] });
  const el = hint();
  let prevented = 0;
  el.fire("click", { preventDefault: () => prevented++, stopPropagation: () => {} });
  assert.equal(h.isShown(), false);
  assert.deepEqual(plugin.names(), ["resume"]);
  assert.equal(prevented, 1);

  plugin.fail.resume = { code: "internal", message: "gone" };
  plugin.emit("state", { state: "paused", reasons: ["interruption"] });
  el.fire("click");
  await tick();
  assert.equal(h.isShown(), false);
  assert.deepEqual(plugin.names(), ["resume", "resume"]);
  // the session stays paused (the interruption is still on): the next state event re-shows it
  plugin.emit("state", { state: "paused", reasons: ["interruption"] });
  assert.equal(h.isShown(), true);
});

test("hides on `stopped` and on pagehide", () => {
  const plugin = hintPlugin();
  const { doc, win } = dom();
  const h = installPausedHint({ plugin, document: doc, window: win });
  assert.equal(win.listenerCount("pagehide"), 1);
  plugin.emit("state", { state: "paused", reasons: ["route"] });
  assert.equal(h.isShown(), true);
  plugin.emit("stopped", { reason: "error" });
  assert.equal(h.isShown(), false);
  plugin.emit("state", { state: "paused", reasons: ["route"] });
  assert.equal(h.isShown(), true);
  win.fire("pagehide");
  assert.equal(h.isShown(), false);
});

test("language: Turkish phone → TR, saved library language wins, unknown languages → English", () => {
  assert.equal(hintLang({ navigator: { language: "tr-TR" } }), "tr");
  assert.equal(hintLang({ navigator: { languages: ["de-DE", "tr"] } }), "de");
  assert.equal(hintLang({ localStorage: { getItem: () => "tr" }, navigator: { language: "en-US" } }), "tr");
  assert.equal(hintLang({ localStorage: { getItem: () => "de" }, navigator: { language: "tr-TR" } }), "de");
  assert.equal(hintLang({ localStorage: { getItem: () => "xx" }, navigator: { language: "tr-TR" } }), "tr"); // unknown saved value: the phone decides
  assert.equal(hintLang({ localStorage: { getItem: () => { throw new Error("blocked"); } }, navigator: { language: "tr" } }), "tr");
  assert.equal(hintLang({}), "en");
  assert.equal(hintText("tr"), "Duraklatıldı — devam etmek için dokun");
  assert.equal(hintText("en"), "Paused — tap to resume");
  assert.equal(hintText("de"), "Pausiert — zum Fortsetzen tippen");
  assert.equal(hintText("ja"), "一時停止中 — タップで再開");
  assert.equal(hintText("xx"), "Paused — tap to resume");

  const plugin = hintPlugin();
  const { doc, win, hint } = dom({ lang: "tr-TR" });
  installPausedHint({ plugin, document: doc, window: win });
  plugin.emit("state", { state: "paused", reasons: ["interruption"] });
  assert.equal(hint().textContent, "Duraklatıldı — devam etmek için dokun");

  const deWin = dom({ lang: "de-DE" });
  const p2 = hintPlugin();
  installPausedHint({ plugin: p2, document: deWin.doc, window: deWin.win });
  p2.emit("state", { state: "paused", reasons: ["interruption"] });
  assert.equal(deWin.hint().textContent, "Pausiert — zum Fortsetzen tippen");

  const xxWin = dom({ lang: "xx-YY" });
  const p3 = hintPlugin();
  installPausedHint({ plugin: p3, document: xxWin.doc, window: xxWin.win });
  p3.emit("state", { state: "paused", reasons: ["interruption"] });
  assert.equal(xxWin.hint().textContent, "Paused — tap to resume");
});

test("dispose removes the element and every listener", async () => {
  const plugin = hintPlugin();
  const { doc, win, body, hint } = dom();
  const h = installPausedHint({ plugin, document: doc, window: win });
  plugin.emit("state", { state: "paused", reasons: ["interruption"] });
  const el = hint();
  assert.equal(body.children.includes(el), true);
  h.dispose();
  await tick();
  assert.equal(body.children.includes(el), false);
  assert.equal(hint(), null);
  assert.equal(plugin.listenerCount("state"), 0);
  assert.equal(plugin.listenerCount("stopped"), 0);
  assert.equal(win.listenerCount("pagehide"), 0);
  assert.equal(el.listenerCount("click"), 0);
  plugin.emit("state", { state: "paused", reasons: ["interruption"] }); // nothing listens any more
  assert.equal(h.isShown(), false);
  assert.equal(hint(), null);
});

test("a plugin whose addListener throws or returns nothing is harmless", () => {
  const { doc, win } = dom();
  const throwing = { addListener: () => { throw new Error("no events"); }, resume: () => Promise.resolve({}) };
  const h = installPausedHint({ plugin: throwing, document: doc, window: win });
  assert.equal(h.isShown(), false);
  h.dispose();
  const bare = { addListener: () => undefined };
  const h2 = installPausedHint({ plugin: bare, document: doc, window: win });
  h2.dispose();
});
