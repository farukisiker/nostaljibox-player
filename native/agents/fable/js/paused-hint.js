// SPDX-License-Identifier: GPL-3.0-or-later
// "Paused — tap to resume" hint for the native player (API.md §3 `state` event). The native session
// pauses itself for reasons the player did not ask for (audio interruption, route loss, app
// background, config change: EmulatorSession.swift setPauseReason); when it comes back paused and
// the page shows nothing about it, the screen just sits still. This shows a small centred pill
// while `state` is "paused" and #native-menu is not visible (the menu's own pause has the menu on
// screen; a pause left behind with only "user", e.g. an interruption that ended without
// shouldResume, has nothing else to tap, above all on the guest page, which has no menu). The
// only pauses it skips are those whose reasons are nothing but "configChange" and/or
// "background": each of those sends paused then running within a moment (headphone plug-in,
// Control Center), and the pill would just flash. A tap calls plugin.resume() (clears `user`,
// `route` and, outside the background, a stale `interruption`; the next `state` event re-shows the
// pill if the session stays paused).
// Hidden on "running", on `stopped`, on pagehide. Installed once per page load, host and guest pages
// alike: the Capacitor plugin proxy exists before play.js runs on iOS, and the `state` events of
// whatever session runs later arrive on it. Without the plugin (Android, desktop) it does nothing.
//
// The id is NOT in sonnet-5-5 native-mode.js OVERLAY_IDS (checked by the test), so showing it never
// hides the native pad. z-index 15: above the game, below every play.css sheet (.overlay 20: the
// pairing panels #link/#join, #toast 30, #play-tools 50) and #native-menu (60), so a panel the user
// opened is never covered by the pill and its buttons stay tappable (the pill is at the screen
// centre, where the panels sit). The native pad is a UIView above the WebView, but TouchPadView.hitTest
// returns self only inside button/zone touch areas (API.md §5); the screen centre is outside the
// left zone, the right diamond and the bottom row, so the tap reaches this element.
import { pickLang } from "./lang.js";
import { nt } from "./strings.js";

export const PAUSED_HINT_ID = "native-paused-hint";

// The text is strings.js `pausedHint` (13 languages); the language is lang.js pickLang, the same
// choice as shared/i18n.js pick(): the saved library language, else the phone's, else English.
export const hintLang = pickLang;

export function hintText(lang = hintLang()) {
  return nt("pausedHint", null, lang);
}

function isShown(el) {
  return !!el && !el.hidden && !el.classList?.contains("hidden") && el.style?.display !== "none";
}

// Reasons that clear themselves a moment later (paused → running), so the pill would only flash.
const TRANSIENT = new Set(["configChange", "background"]);

// Any paused state, except when every reason is transient (and there is at least one). "user"
// alone counts: after an interruption that ended without shouldResume it is all that is left, and
// the guest page has no menu to clear it. The menu check in onState covers the menu's own pause.
export function wantsHint(payload) {
  if (!payload || payload.state !== "paused") return false;
  const reasons = Array.isArray(payload.reasons) ? payload.reasons : [];
  return !(reasons.length > 0 && reasons.every((r) => TRANSIENT.has(r)));
}

// max-width 240px/32vw: on 667–852 pt landscape phones a wider pill reaches into the pad's touch
// areas (zone box + 30 pt, PadLayout.swift) and the diamond's left button; the text wraps instead.
const STYLE =
  "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:15;box-sizing:border-box;" +
  "max-width:min(240px,32vw);padding:10px 18px;border-radius:22px;background:rgba(0,0,0,0.72);" +
  "color:#fff;font:600 15px/1.3 -apple-system,system-ui,sans-serif;text-align:center;" +
  "cursor:pointer;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;";

/**
 * Installs the hint. `plugin` is Capacitor.Plugins.NativePlayer (or null); `document` the page.
 * Returns { hide(), dispose(), isShown(), element } for the page and the tests; every method is a
 * safe no-op without a plugin. Never throws.
 */
export function installPausedHint({ plugin, document: doc = globalThis.document, window: win = globalThis.window } = {}) {
  const handle = { hide: () => {}, dispose: () => {}, isShown: () => false, element: null };
  if (!plugin || typeof plugin.addListener !== "function" || !doc || typeof doc.createElement !== "function") return handle;

  let el = null;
  const listeners = []; // plugin listener handles (promises or objects with remove())
  const offs = []; // DOM/window listener removers

  const hide = () => {
    if (!el) return;
    el.hidden = true;
    if (el.style) el.style.display = "none";
  };
  const ensure = () => {
    if (el) return el;
    el = doc.createElement("div");
    el.id = PAUSED_HINT_ID;
    el.setAttribute?.("role", "button");
    el.setAttribute?.("style", STYLE);
    el.textContent = hintText(hintLang(win));
    const onTap = (ev) => {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
      hide();
      try {
        Promise.resolve(plugin.resume?.({})).catch(() => {});
      } catch {
        // no session any more: the hint is gone, nothing else to do
      }
    };
    el.addEventListener("click", onTap);
    offs.push(() => el?.removeEventListener?.("click", onTap));
    (doc.body || doc.documentElement)?.appendChild?.(el);
    handle.element = el;
    return el;
  };
  const show = () => {
    const node = ensure();
    node.textContent = hintText(hintLang(win)); // the library language may have changed meanwhile
    node.hidden = false;
    if (node.style) node.style.display = "";
  };
  const onState = (payload) => {
    if (!wantsHint(payload) || isShown(doc.getElementById?.("native-menu"))) hide();
    else show();
  };
  const onPageHide = () => hide();

  try {
    listeners.push(plugin.addListener("state", onState));
    listeners.push(plugin.addListener("stopped", hide));
  } catch {
    // a plugin without events: nothing to show, ever
  }
  win?.addEventListener?.("pagehide", onPageHide);
  offs.push(() => win?.removeEventListener?.("pagehide", onPageHide));

  handle.hide = hide;
  handle.isShown = () => isShown(el);
  handle.dispose = () => {
    hide();
    for (const off of offs.splice(0)) off();
    for (const h of listeners.splice(0)) {
      Promise.resolve(h)
        .then((l) => l?.remove?.())
        .catch(() => {});
    }
    el?.remove?.();
    if (el && !el.remove && el.parentNode?.removeChild) el.parentNode.removeChild(el);
    el = null;
    handle.element = null;
  };
  return handle;
}
