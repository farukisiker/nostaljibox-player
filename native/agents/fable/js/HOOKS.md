<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# HOOKS: what Claude inserts into `src/play.js` for the paused hint (fable, `paused-hint.js`)

Two lines, both in `src/play.js`, next to the other native imports. Nothing else changes:
`play.html`, `play.css`, `native-mode.js`, `native-guest.js` and `native-menu.js` stay as they are
(the hint styles itself inline and creates its element lazily on the first non-user pause).

## 1. Import (with the other `../native/agents/...` imports, line ~9)

```js
import { bootNativeGuest, stopNativeGuest } from "../native/agents/fable/js/native-guest.js";
+import { installPausedHint } from "../native/agents/fable/js/paused-hint.js";
import "../native/agents/sonnet-5-5/native.css";
```

## 2. Call (module level, right after `translatePage();`, line ~14)

```js
translatePage();
+installPausedHint({ plugin: window.Capacitor?.Plugins?.NativePlayer ?? null, document });
```

## Why one call covers the host and the guest page

`play.js` is the module of both pages (`?id=` host, `?join` guest). On iOS the Capacitor plugin
proxy `Capacitor.Plugins.NativePlayer` exists before any page script runs, and the `state` /
`stopped` events of whichever session is started later (`installNativeMode` → `bootNative`, or
`setupGuestLink` → `bootNativeGuest`) arrive on that same object, so listening from module load is
enough; the call does not need `window.nbNative` or the session. Without the plugin (Android,
desktop web) `installPausedHint` returns a no-op handle and touches nothing.

## What it does (API.md §3 `state` event, EmulatorSession.swift `setPauseReason`)

- Shows a centred pill `Duraklatıldı — devam etmek için dokun` / `Paused — tap to resume`
  (`strings.js` key `pausedHint`, all 13 app languages; the language is `lang.js` `pickLang`, the
  same choice as `shared/i18n.js`: saved library language, else the phone's; any other language
  gets English) when `state` is `"paused"` and `#native-menu` is
  not visible (the menu's own pause already has the menu on screen). Only `"user"` counts too: an
  interruption that ends without `shouldResume` leaves just that, and the guest page has no menu.
  The one exception: reasons that are nothing but `configChange` and/or `background` (headphone
  plug-in, Control Center), which go paused → running within a moment and would only flash.
- A tap calls `plugin.resume()` (clears `user`, `route` and, outside the background, a stale
  `interruption`: iOS does not always send `.ended`) and hides the pill. If the session stays
  paused (the engine could not start), the next `state` event shows it again.
- Hides on `state: "running"`, on the plugin's `stopped` event and on `pagehide`.
- Its id `native-paused-hint` is not in native-mode's `OVERLAY_IDS` (test-checked), so it never hides
  the native pad. z-index 15: above the game, below every play.css sheet (`.overlay` 20, so the
  pairing panels `#link`/`#join` and their buttons are never under the pill; `#toast` 30,
  `#play-tools` 50) and `#native-menu` (60).
  The native pad is a UIView over the WebView, but `TouchPadView.hitTest` captures only its button
  and zone areas (API.md §5); the pill sits at the screen centre (max width `min(240px, 32vw)`, the
  text wraps), clear of the left zone, the right diamond and the bottom row even on 667–852 pt
  landscape phones, so the tap reaches the WebView.
