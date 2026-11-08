<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# HOOKS: what Claude inserts into `src/play.js` (WP5, sonnet-5-5)

Four lines in total, all in `src/play.js`; `play.html` and `play.css` are not touched (the CSS comes
in through a Vite import, like `./play.css`). Everything else (`#back`, `#emu-menu`, `#p2`,
`pagehide`, pad visibility, fallback) is handled inside `native-mode.js`.

Why no ordering constraint on `#p2`: `native-mode.js` listens for clicks on `document` in the
**capture** phase and checks `ev.target.closest("#p2")`, so it always runs before the listener
that `setupHostLink` puts on `#p2` itself, wherever hook 3 sits. The same goes for `#back` and
`#emu-menu`: the existing handlers in `play.js` stay as they are and never see the click in native
mode. (If hook 3 is placed before `setupHostLink(() => current)` nothing changes either.)

## 1. Imports (after `import "./play.css";`, line 7)

```js
import { t, ejsLanguage, translatePage } from "../shared/i18n.js";
import "./play.css";
+import { installNativeMode, autoOpenHostLink } from "../native/agents/sonnet-5-5/js/native-mode.js";
+import "../native/agents/sonnet-5-5/native.css";

translatePage();
```

## 2. EmulatorJS path: open the link panel after `?p2=1` (in `EJS_onGameStart`, line ~203)

```js
      bindComboButton(emu);
      if (onStart) onStart(emu);
+      autoOpenHostLink({ params });
    },
  });
```

## 3. Hand the game to native mode (in the async IIFE at the bottom, line ~246)

```js
    put("games", id, { ...game, played: Date.now() }).catch(() => {});
+    if (await installNativeMode({ params, game, rom, PADS, lockOrientation, bootEmulator: () => boot(game, rom) })) return;
    boot(game, rom);
  })().catch((e) => fail(t("error", { msg: e.message || e })));
```

`installNativeMode` resolves `true` when native mode owns the page (`play.js` must not call
`boot`), `false` otherwise (non-iOS, no plugin, `nb_native=off`, `?ejs=1`, `?join`, unsupported
system or archive). It stays `true` when the native start fails afterwards, because the fallback
calls `bootEmulator()` itself, once. `?join` never reaches hook 3 (the guest branch above it), the
flag is only a second guard.

## What the hook gives the other work packages

- `window.nbNative = { plugin, game, onFallback }` is set while native mode runs and deleted on
  fallback. `#emu-menu` taps dispatch `document` event `nb:native-menu` (WP6 listens).
- `html.native` is set by `bootNative` and removed on stop or fallback.
- A native menu that wants the pad hidden while it is open: give its root `id="native-menu"` and
  toggle the `hidden` attribute or the `hidden` class (observed together with `#tools-panel`,
  `#link`, `#join`, `#error`).
- Importing `native-mode.js` imports `native-player.js`, which stops any orphaned native session
  once per page load (PLAN §1.5, item 2).
