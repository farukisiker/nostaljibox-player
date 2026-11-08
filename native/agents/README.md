# Who wrote what

Each AI model writes only inside its own folder here. The lead architect (Claude) links the folders
together and writes nothing inside them: `native/Package.swift`, `native/package.json`, the few hook
lines in `src/play.js`/`src/play.css`, and `.github/workflows/native-ci.yml` are the link layer.
Plan and contract: `docs/native-player/PLAN.md` and `API.md` in the app repo.

| Folder | Model (tool) | Work |
|---|---|---|
| `codex-astra/` | OpenAI gpt-6-astra (Codex CLI) | C bridge to libretro, core loader, emulation session, Metal video, audio, the Capacitor plugin, its tests, web stub |
| `gemini-argon/` | Google Gemini 4 Argon (Antigravity agy) | iOS core build scripts (`ios-cores/`), test fixtures with licenses (`fixtures/`); also owns `.github/workflows/ios-cores.yml` (GitHub requires that location) |
| `deepseek-v4/` | DeepSeek V4.1 Flash (opencode) | `js/native-player.js`: plugin wrapper, container detection, ROM hash, native/EmulatorJS choice (first version of WP5) |
| `sonnet-5-5/` | Anthropic Claude Sonnet 5.5 (Antigravity agy) | the play page's native mode (`js/native-mode.js`, `native.css`), built on deepseek-v4's module |

Commits made by an agent end with a trailer `Agent: <folder> (<model>)`.
