# NES Headless Smoke-Test Fixture (irst_nes.nes)

- **File:** irst_nes.nes
- **Size:** 24,592 bytes (16-byte iNES header + 16 KB PRG ROM + 8 KB CHR ROM, NROM / Mapper 0)
- **SHA-256:** 91516cb428ded36e3fc4da391501849afde241f3923f300cd1b91b477cf7c5d4
- **iNES Header:** 4E 45 53 1A 01 01 01 00 00 00 00 00 00 00 00 00 (NES\x1a)
- **Repository:** <https://github.com/gregkrsak/first_nes>
- **Release Tag / Commit:** 0.2.0 (c7fca8d496a7e99c9deec177bf8b99e2df301cab)
- **Download URL:** <https://github.com/gregkrsak/first_nes/releases/download/v0.2.0/first_nes.nes>
- **Author:** Greg M. Krsak
- **License:** The Unlicense (Public Domain dedication). See [LICENSE](./LICENSE) for full license text.
- **Core:** 
es (Nestopia UE)

## Behavior for Smoke Tests

On boot, irst_nes.nes executes the reset handler (ISR_PowerOn_Reset), initializes CPU and PPU registers, loads palette data, background tilemap (
eon_grid.inc), and the Neon Ranger sprite into OAM. It enables PPU rendering and displays a visible non-black platformer scene within a few frames without requiring controller input.
