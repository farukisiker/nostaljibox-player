<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# WP6 Native In-Game Menu Integration (`HOOKS.md`)

## 1. Lines to add to `src/play.js`

Add these lines to `src/play.js` (alongside existing native imports):

```js
import "../native/agents/gemini-argon/js/native-menu.js";
import "../native/agents/gemini-argon/js/native-menu.css";
```

## 2. How `native-menu.js` hooks into `nb:native-menu` and `window.nbNative`

1. **Event Trigger (`nb:native-menu`)**:
   - Sonnet's `native-mode.js` intercepts `#emu-menu` taps and dispatches a CustomEvent `"nb:native-menu"` on `document`.
   - `native-menu.js` automatically binds a `document.addEventListener("nb:native-menu", ...)` listener upon module load.

2. **Overlay & Touch Pad Sync**:
   - Opening toggles `#native-menu` (removes `.hidden`, sets `hidden = false`), which triggers Sonnet's `MutationObserver` on `document.body` to hide the native touch pad overlay.
   - Closing adds `.hidden` and sets `hidden = true`, restoring pad visibility.
   - Opening also defensively hides `#tools-panel` if present (`document.getElementById("tools-panel")?.classList?.add("hidden")`).

3. **Bridge Integration (`window.nbNative` v2)**:
   - Accesses bridge configuration and methods via `window.nbNative` v2:
     `{ plugin, game, onFallback, options: { scaling, showPad, showStats }, setPadPreference(visible) }`
     (with fallback plugin access via `window.Capacitor?.Plugins?.NativePlayer`).
   - Emulation pause/resume: calls `plugin?.pause?.()` on menu open, and calls `plugin?.resume?.()` on menu close (unless skipping resume, e.g. on fallback).
   - State seeding & synchronization: seeds menu state from `nbNative?.options` (`scaling` default `"fit"`, `showPad` default `true`, `showStats` default `true`), and writes back updated options (`scaling`, `showPad`, `showStats`) upon successful user interactions.
   - Touch pad preference: touch pad toggle delegates to `nbNative?.setPadPreference(visible)` (button is disabled if `setPadPreference` is not a function); does not call `plugin.setPadVisible` directly.
   - "Use the classic player": calls `closeNativeMenu({ skipResume: true })`, awaits `plugin?.stop?.()`, and invokes `nbNative?.onFallback?.()` at most once.
   - Provides controls for Reset, Save/Load states (1–3), Scaling (`fit`/`integer`/`stretch`), Touch pad toggle, Stats toggle, and Quit.
