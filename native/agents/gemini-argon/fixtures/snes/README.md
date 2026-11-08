# SNES Headless Smoke-Test Fixture (`hello-world-region.sfc`)

- **File:** `hello-world-region.sfc`
- **Size:** 262,144 bytes (256 KB, LoROM, no enhancement chips)
- **SHA-256:** `21a7d745830ead7f011ca20a540af25d03b487b9911be53b071dff7feffe3c9f`
- **Internal Header Title:** `REGION HELLO WORLD`
- **Repository:** <https://github.com/donth77/snes-homebrew> (`hello-world-region/`)
- **Release Tag / Commit:** `v1.0.0` (`f94da8b5b79b019a9250fdae4b1667737d30412d`)
- **Download URL:** <https://github.com/donth77/snes-homebrew/releases/download/v1.0.0/hello-world-region.sfc>
- **License:** MIT License (Copyright (c) 2026 Tom D; built with PVSnesLib 4.5.0 under MIT License). See [`LICENSE`](./LICENSE) for full license texts.

## Behavior for Smoke Tests

On boot, the ROM initializes SNES Mode 1 text console graphics in VRAM, displays `"REGION-AWARE HELLO"` and `"NTSC / 60 HZ"` (or `"PAL  / 50 HZ"`), turns the display on, and increments an on-screen `"SECONDS: <n>"` counter once per second (every 60 frames on NTSC) without requiring controller input.
