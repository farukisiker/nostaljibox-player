<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# WP6 Native In-Game Menu Integration (`HOOKS.md`)

## 1. Lines to add to `src/play.js`

Add these lines to `src/play.js` (alongside existing native imports):

```js
import "../native/agents/gemini-argon/js/gemini-3.8-flash-high/native-menu.js";
import "../native/agents/gemini-argon/js/gemini-3.8-flash-high/native-menu.css";
```

*(If aliased or symlinked to `native/agents/gemini-argon/js/`)*:
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

3. **Bridge Integration (`window.nbNative`)**:
   - Accesses the native plugin via `window.nbNative?.plugin ?? window.Capacitor?.Plugins?.NativePlayer`.
   - Pauses the running emulation on menu open, and resumes on menu close unless the game was already paused by the user beforehand (`externalUserPaused`, `nbNative.userPaused`, or `plugin.userPaused`).
   - "Use the classic player" calls `window.nbNative.onFallback()` at most once per session and exits the menu without resuming the native player.
   - Provides controls for Reset, Save/Load states (1–3), Scaling (`fit`/`integer`/`stretch`), Touch pad toggle, Stats toggle, and Quit.
