# Gemini Argon — Sub-Agent Tasks (`native/agents/gemini-argon/TASKS.md`)

Lead: `gemini-argon` (`gemini-4-argon-high`)

| task | sub-agent model | session id | files | status | % | ETA HH:MM | resume command |
|---|---|---|---|---|---|---|---|
| WP0: Supafaust iOS core pipeline + SNES fixture | `gemini-4-argon-high` (lead prior to rule) | `a0633558-6655-41e0-827a-fcd0fedc0f5c` | `.github/workflows/ios-cores.yml`, `ios-cores/{cores.lock.json,build-core.sh,make-framework.sh,release.json,patches/supafaust.patch}`, `fixtures/snes/*` | done | 100% | 01:01 | `--conversation a0633558-6655-41e0-827a-fcd0fedc0f5c` |
| WP7: Test ROM fixtures (NES, MD, SMS, GG) | `gemini-3.8-flash-high` | `78c50c9a-acb5-42bd-b93e-482d1f30c0de` | `fixtures/gemini-3.8-flash-high/**`, `fixtures/{nes,md,segaMD,sms,segaMS,gg,segaGG}/**` | done | 100% | 01:20 | `--conversation 78c50c9a-acb5-42bd-b93e-482d1f30c0de` |
| WP8a: Nestopia + Gearsystem lock & patches | `gemini-3.8-flash-high` | `31745612-bd1a-4950-b6ab-24b87cbd87c6` | `ios-cores/gemini-3.8-flash-high/{nestopia.lock.json,gearsystem.lock.json,patches/*}` | done | 100% | 01:20 | `--conversation 31745612-bd1a-4950-b6ab-24b87cbd87c6` |
| WP8b: ClownMDEmu iOS port patch & lock | `gemini-4-argon-high` | `47839ede-2722-4e5a-9cba-21c5da4cb39f` | `ios-cores/gemini-4-argon-high/{clownmdemu.lock.json,patches/clownmdemu.patch}` | done | 100% | 01:21 | `--conversation 47839ede-2722-4e5a-9cba-21c5da4cb39f` |
| WP8c: Build & publish 4-core release (`ios-cores-d6ed1fa9ce8b`) | `gemini-4-argon-high` (lead) | `a0633558-6655-41e0-827a-fcd0fedc0f5c` | `ios-cores/{cores.lock.json,build-core.sh,release.json}` | done | 100% | 01:26 | `--conversation a0633558-6655-41e0-827a-fcd0fedc0f5c` |
| WP2-Zip: NativeZip module (`ZipExtractor.swift`) | `gemini-4-argon-high` | `2ecd0b31-c57b-4a07-9922-ec06a4caba17` | `NativeZip/gemini-4-argon-high/ZipExtractor.swift` | done | 100% | 01:41 | `--conversation 2ecd0b31-c57b-4a07-9922-ec06a4caba17` |
| WP2-ZipTests: `ZipExtractorTests.swift` | `gemini-3.8-flash-high` | `829ff773-349d-461e-b506-1f2c39b3165a` | `Tests/gemini-3.8-flash-high/ZipExtractorTests.swift` | done | 100% | 01:44 | `--conversation 829ff773-349d-461e-b506-1f2c39b3165a` |
| Android regression test on ALFA 8TX (`62240306301`) — note: frame counter was EJS's `EJS_emulator.gameManager.getFrameNum()` (`get_current_frame_count`); screen was ON (`svc power stayon true` + `KEYCODE_WAKEUP`) | `gemini-3.8-flash-high` | `a42ad8e8-74c3-4f47-a9c4-e7e866aa96de` | `.ai-runs/dev/android-regression.md`, `ios-cores/gemini-3.8-flash-high/android-regression.md` | done | 100% | 01:46 | `--conversation a42ad8e8-74c3-4f47-a9c4-e7e866aa96de` |
| WP9: Exported-IPA validation gate (`validate-ipa.sh`) | `gemini-3.8-flash-high` | `39277d15-baa2-4508-9e89-fb76ac8d3fa5` | `ci/gemini-3.8-flash-high/validate-ipa.sh` | done | 100% | 02:12 | `--conversation 39277d15-baa2-4508-9e89-fb76ac8d3fa5` |
