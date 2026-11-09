# Mega Drive / Genesis Headless Smoke-Test Fixture (pong.md)

- **File:** pong.md
- **Size:** 131,072 bytes (128 KB)
- **SHA-256:** 4f077c764972b23c6f2ea6056ebc3b8bf1da972d95f400259de676f787f1061d
- **Header (offset 0x100):** "SEGA MEGA DRIVE (C)MONTESLU 2026PONG V1.0.0" (starts with "SEGA")
- **Repository:** <https://github.com/monteslu/retro-homebrew-games> (genesis/pong/)
- **Release Tag / Commit:** uild-27 (eb7dc3044f9d2f76047f3b3573971bf86575ca52)
- **Download URL:** <https://github.com/monteslu/retro-homebrew-games/releases/download/build-27/pong.bin>
- **Author:** Luis Montes
- **License:** MIT License (Copyright (c) 2026 Luis Montes). See [LICENSE](./LICENSE) for full license text.
- **Core:** md / segaMD (clownmdemu)

## Behavior for Smoke Tests

On boot, pong.md sets 320-pixel screen width, registers VDP color palettes, uploads tile graphics into VRAM, and enters the title state (drawTitle()). It immediately renders a visible pulsing "PONG" title screen, bouncing ball animation, and player selection options on Plane A without requiring controller input, within the first few frames.
