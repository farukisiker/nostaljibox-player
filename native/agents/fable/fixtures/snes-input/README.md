# SNES input-sensitive test ROM (`input-test.sfc`)

- **File:** `input-test.sfc`, 32,768 bytes (32 KiB LoROM, map mode `$20`, no enhancement chips)
- **SHA-256:** `fda1721cf4c1212da3f8bb488458b7fce2ee2e1adf5ec29ab6c6dc24f081bd99`
- **Internal header:** title `NB INPUT TEST`, cartridge type `$02` (ROM + RAM + battery),
  ROM size code 5 (32 KiB), **RAM size code 1 = 2 KiB battery SRAM**, region `$01` (NTSC),
  checksum `$C3F6` / complement `$3C09`, reset vector `$8000`, native NMI vector `$805D`
- **License:** MIT, our own code (see `LICENSE`). No third-party code or toolchain: `make_rom.py`
  hand-assembles the 235 bytes of 65816 and writes the header, checksum and vectors.
- **Purpose:** `docs/native-player/NETPLAY.md` §8.2 step 0. The other SNES fixture
  (`gemini-argon/fixtures/snes/hello-world-region.sfc`) ignores the controllers, so equal WRAM
  hashes with and without an input script prove nothing about port handling. This ROM folds the
  auto-read mask of **both** pads into WRAM and SRAM every frame.

## What it does

Reset: native mode, stack `$1FFF`, force blank, no layers on the main screen (backdrop only),
clears its WRAM words, sets backdrop colour `$4210`, turns the screen on and enables
`$4200 = $81` (VBlank NMI + auto-joypad read). The main loop is `WAI` / `BRA`.

Every NMI (once per frame): acknowledge `$4210`, wait for `$4212` bit 0 to clear (pads latched),
read `$4218/$4219` (pad 1) and `$421A/$421B` (pad 2) as 16-bit masks, update the words below,
mirror five of them to SRAM, and set CGRAM colour 0 from the two masks. No DMA, no IRQ, no APU.

## WRAM (bank `$7E`, also visible through the bank `$00` mirror), 16-bit little-endian words

| Address | Name | Depends on | Update per frame |
|---|---|---|---|
| `$7E0000` | `frame` | neither | `frame += 1` |
| `$7E0002` | `sum1` | **pad 1** | `sum1 += pad1` (mod 2^16) |
| `$7E0004` | `sum2` | **pad 2** | `sum2 += pad2` |
| `$7E0006` | `hash1` | **pad 1** (whole history) | `hash1 = rol16(hash1) ^ pad1` |
| `$7E0008` | `hash2` | **pad 2** (whole history) | `hash2 = rol16(hash2) ^ pad2` |
| `$7E000A` | `last1` | pad 1 | mask of the latest frame |
| `$7E000C` | `last2` | pad 2 | mask of the latest frame |
| `$7E000E` | `held1` | pad 1 | `+1` when `pad1 != 0` |
| `$7E0010` | `held2` | pad 2 | `+1` when `pad2 != 0` |

Nothing else in WRAM is written (the stack at `$1FF0..$1FFF` holds the NMI frame while the
handler runs and is popped before `RTI`). So after N frames:

- idle on both ports: `frame = N`, every other word `0`;
- input only on port 1 (host): `sum1/hash1/held1/last1` change, `sum2/hash2/held2/last2` stay `0`;
- input only on port 2 (guest): the opposite.

`pad1`/`pad2` are the raw auto-read masks: high byte `B Y Sel Start Up Down Left Right`,
low byte `A X L R 0 0 0 0`. A different button order, a dropped frame or a frame applied one
step late all change `hash*` because of the rotate.

## SRAM (bank `$70`, 2 KiB battery RAM, LoROM `$70:0000-$70:07FF`)

| Address | Value |
|---|---|
| `$700000` | copy of `hash1` (pad 1) |
| `$700002` | copy of `hash2` (pad 2) |
| `$700004` | copy of `frame` |
| `$700006` | copy of `held1` (pad 1) |
| `$700008` | copy of `held2` (pad 2) |

Bytes `$70000A..$7007FF` are never written, so whatever `.srm` the emulator loaded stays there.
This is what §8.2 needs: the first 10 bytes of cartridge RAM follow the inputs, the rest follows
the loaded save file, and both are part of a Mednafen savestate.

## Screen

Backdrop colour (CGRAM 0) = `($4210 ^ pad1 ^ byteswap(pad2)) & $7FFF` (BGR555), written during
VBlank. Idle shows a dim teal, never black; holding buttons changes the colour.

## Build and check

```
python make_rom.py            # writes input-test.sfc, checks header/checksum/vectors
python make_rom.py --listing  # also prints the assembly listing with bytes and comments
python simulate.py            # runs the ROM for 600 frames in a tiny 65816 interpreter
```

`simulate.py` models only the opcodes and registers the ROM uses (plus a stubbed `$4212`), so it
checks the arithmetic, addressing modes and register widths, not PPU/joypad timing. It asserts
the WRAM and SRAM formulas above for a seeded two-port script, the port-1-only / port-2-only
separation, and that two identical runs give identical WRAM and SRAM.

Expected values for the built-in seeded 600-frame script (also printed by `simulate.py`):
`hash1=$A6C6 hash2=$4AAA sum1=$81A0 sum2=$F410 held1=452 held2=302 colour=$7F60`.

## Using it in `DeterminismTests`

The native CI merges `native/agents/*/fixtures/` into `TEST_RUNNER_NB_FIXTURES_DIR`, so this file
is `<fixtures>/snes-input/input-test.sfc`. Suggested checks:

1. Run 600 frames idle and 600 frames with a seeded script on port 1 only: the FNV-1a hash of
   WRAM must differ, and `$7E0004/$7E0008` (pad-2 words) must be `0` in both runs.
2. Same script on port 2 only: `$7E0002/$7E0006` must be `0`, `$7E0008` nonzero.
3. Two instances with the same two-port script: equal WRAM hashes at every checkpoint, and
   SRAM bytes 0-9 equal.
4. With a `.srm` full of `0xFF`: after `unserialize` of a state from a `0x00` SRAM run, bytes
   10.. of cartridge RAM come from the state, not the file.
