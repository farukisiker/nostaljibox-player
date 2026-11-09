# Android Tablet WebView / EmulatorJS Regression Test Report

- **Date / Time**: 2026-11-09T01:45:00+03:00
- **Target Device**: ALFA 8TX tablet (`62240306301`)
- **App**: `com.nostaljibox.app` (debug build via local JDK 21 + Gradle `assembleDebug`)
- **Installation**: `adb install -r` succeeded cleanly without data loss.

## Test Results
1. **Library Check**: SNES game "Test" (`sf2.zip`, `id: t`, core: `snes`) confirmed in IndexedDB.
2. **Game Launch**: Successfully navigated to `player/play.html?id=t`.
3. **EmulatorJS Status**: `Boolean(window.EJS_emulator)` is `true` (`hasGameManager: true`).
4. **Native Flag Check**: `document.documentElement.classList.contains("native")` is `false`.
5. **60-Second Emulation Progression**:
   - Frames advanced steadily from frame 12 to 1154 (+1142 frames over 60s).
   - Memory usage remained stable (Total PSS: 124.5 MB -> 127.1 MB).
6. **Console Errors**: 0 errors from `native-mode.js` or `native-player.js`.
7. **Back Navigation**: Triggered `#back` button; navigated cleanly back to `https://localhost/index.html`.

## Cleanup
- `svc power stayon false` executed.
- DevTools port forwarding removed.
- Tracked git worktree changes from `cap sync` reverted cleanly.
- **Verdict**: PASS — Android WebView / EmulatorJS path is completely unaffected by native-mode hooks.
