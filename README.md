# nostaljibox-player

`nostaljibox-player` is the open-source emulator screen and core bundle for NostaljiBox, a retro emulator app for iOS and Android.

It provides the WebAssembly emulation viewport powered by [EmulatorJS](https://emulatorjs.org) (v4.2.3), loads ROMs and save states from IndexedDB, displays virtual controls and touch overlays, and coordinates local peer-to-peer 2-player lockstep play over WebRTC.

> **Note:** No ROMs or BIOS files are included in this repository.

## Repository Layout

```
.
├── .github/workflows/
│   └── build-cores.yml    # CI workflow building extra libretro cores
├── cores/
│   ├── dist/              # Precompiled wasm data files for extra cores
│   └── extra-cores.json   # Build definitions for gearsystem & clownmdemu
├── cores.json             # Manifest of npm and prebuilt cores
├── scripts/
│   └── copy-emulators.cjs # Deployment script bundling EJS and cores into public/ejs
├── shared/                # Shared utilities (MIT licensed)
│   ├── link.js            # WebRTC SDP/candidate signaling
│   ├── storage.js         # IndexedDB storage for ROMs and saves
│   ├── systems.js         # Console definitions and ROM auto-detection
│   └── unzip.js           # ZIP archive inspection
├── src/
│   ├── host-link.js       # Host side of two-phone play: sends the ROM and a savestate
│   ├── guest-link.js      # Guest side: pairs by QR, receives the game, plays as player 2
│   ├── lockstep.js        # Runs both phones frame by frame on the same inputs
│   ├── play.css           # Viewport and HUD styles
│   └── play.js            # Player bootstrap and EmulatorJS runtime config
└── play.html              # Standalone player entrypoint
```

## How the App Uses It

This repository is used by the NostaljiBox app as a git submodule at `player/`.

The script `scripts/copy-emulators.cjs` is executed from the app root (e.g., during `npm run dev` or `npm run build`). It expects `node_modules/@emulatorjs/*` packages and writes the bundled emulator runtime into `public/ejs/`, patching the core table:
- `snes` → `bsnes`
- `segaMD` → `clownmdemu`
- `segaMS` / `segaGG` → `gearsystem`

## Rebuilding Cores

Three cores (`bsnes`, `gearsystem`, and `clownmdemu`) are prebuilt into `cores/dist/` because EmulatorJS does not publish them on npm.

- **GitHub Actions:** Run `.github/workflows/build-cores.yml` via `workflow_dispatch` or push changes affecting the workflow or `cores/extra-cores.json`.
- **Locally:** Use emsdk `3.1.74` and clone the EmulatorJS build scripts pinned to commit `6c0dc2e` with RetroArch `next` pinned to commit `a61f8a8905` (4.2.x compatible). Merge `cores/extra-cores.json` and build `clownmdemu` with `PLATFORM_DEFINES=-DCLOWNCD_NO_CHD`.

## Licenses

This project is licensed under the **GNU General Public License v3.0 or later** ([LICENSE](LICENSE)), except for `shared/`:
- `shared/` (`link.js`, `storage.js`, `systems.js`, `unzip.js`): **MIT** (usable outside the GPL player)
- Everything else (`play.html`, `src/*`, `scripts/*`): **GPL-3.0-or-later**
- Each file includes an explicit SPDX license identifier.
- EmulatorJS runtime: **GPL-3.0**

### Per-Core License Table

All bundled cores permit commercial distribution:

| Core | Console | License | Upstream Source |
|---|---|---|---|
| bsnes | Super Nintendo | GPLv3 | https://github.com/libretro/bsnes |
| Gearsystem | Master System / Game Gear | GPLv3 | https://github.com/drhelius/Gearsystem |
| clownmdemu | Sega Mega Drive / Genesis | AGPLv3 | https://github.com/Clownacy/clownmdemu-libretro |
| nestopia | NES / Famicom | GPLv2 | `@emulatorjs/core-nestopia` |
| mupen64plus_next | Nintendo 64 | GPLv2 | `@emulatorjs/core-mupen64plus_next` |
| gambatte | Game Boy / Color | GPLv2 | `@emulatorjs/core-gambatte` |
| mgba | Game Boy Advance | MPL-2.0 | `@emulatorjs/core-mgba` |
| melonDS | Nintendo DS | GPLv3 | `@emulatorjs/core-melonds` |
| pcsx_rearmed | PlayStation | GPLv2 | `@emulatorjs/core-pcsx_rearmed` |
| stella2014 | Atari 2600 | GPLv2 | `@emulatorjs/core-stella2014` |
| prosystem | Atari 7800 | GPLv2 | `@emulatorjs/core-prosystem` |
| mednafen_pce | PC Engine / TurboGrafx-16 | GPLv2 | `@emulatorjs/core-mednafen_pce` |
| mednafen_ngp | Neo Geo Pocket | GPLv2 | `@emulatorjs/core-mednafen_ngp` |
| mednafen_wswan | WonderSwan | GPLv2 | `@emulatorjs/core-mednafen_wswan` |
| handy | Atari Lynx | zlib | `@emulatorjs/core-handy` |
| beetle_vb | Virtual Boy | GPLv2 | `@emulatorjs/core-beetle_vb` |
