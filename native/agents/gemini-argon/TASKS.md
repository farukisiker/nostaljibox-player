# Gemini Argon — Sub-Agent Tasks (`native/agents/gemini-argon/TASKS.md`)

Lead: `gemini-argon` (`gemini-4-argon-high`)

| task | sub-agent model | session id | files | status | % | ETA HH:MM | resume command |
|---|---|---|---|---|---|---|---|
| WP0: Supafaust iOS core pipeline + SNES fixture | `gemini-4-argon-high` (lead prior to rule) | `a0633558-6655-41e0-827a-fcd0fedc0f5c` | `.github/workflows/ios-cores.yml`, `ios-cores/{cores.lock.json,build-core.sh,make-framework.sh,release.json,patches/supafaust.patch}`, `fixtures/snes/*` | done | 100% | 01:01 | `--conversation a0633558-6655-41e0-827a-fcd0fedc0f5c` |
| WP7: Test ROM fixtures (NES, MD, SMS, GG) | `gemini-3.8-flash-high` | `78c50c9a-acb5-42bd-b93e-482d1f30c0de` | `fixtures/gemini-3.8-flash-high/**`, `fixtures/{nes,md,segaMD,sms,segaMS,gg,segaGG}/**` | done | 100% | 01:20 | `--conversation 78c50c9a-acb5-42bd-b93e-482d1f30c0de` |
| WP8a: Nestopia + Gearsystem lock & patches | `gemini-3.8-flash-high` | `31745612-bd1a-4950-b6ab-24b87cbd87c6` | `ios-cores/gemini-3.8-flash-high/{nestopia.lock.json,gearsystem.lock.json,patches/*}` | done | 100% | 01:20 | `--conversation 31745612-bd1a-4950-b6ab-24b87cbd87c6` |
| WP8b: ClownMDEmu iOS port patch & lock | `gemini-4-argon-high` | `47839ede-2722-4e5a-9cba-21c5da4cb39f` | `ios-cores/gemini-4-argon-high/{clownmdemu.lock.json,patches/clownmdemu.patch}` | done | 100% | 01:21 | `--conversation 47839ede-2722-4e5a-9cba-21c5da4cb39f` |
| WP8c: Build & publish 4-core release (`ios-cores.yml`) | `gemini-4-argon-high` (lead) | `a0633558-6655-41e0-827a-fcd0fedc0f5c` | `ios-cores/{cores.lock.json,build-core.sh,release.json}` | running | 60% | 01:30 | `--conversation a0633558-6655-41e0-827a-fcd0fedc0f5c` |
