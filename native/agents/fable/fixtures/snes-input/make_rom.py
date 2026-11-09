#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Light Soldier Games / NostaljiBox contributors
#
# Builds input-test.sfc: a 32 KiB LoROM SNES image whose WRAM and SRAM depend on the
# controller input of BOTH pads, every frame. Used by the native netplay determinism tests
# (docs/native-player/NETPLAY.md §8.2) to prove that an input script on port 1 changes the
# WRAM hash and that the two instances see the same inputs.
#
# Hand-assembled 65816; every instruction is listed with its bytes and meaning below. No
# third-party code or toolchain is used. Run:  python make_rom.py  (writes input-test.sfc
# next to this script and self-checks the header, checksum and vectors).

import struct
import sys
from pathlib import Path

ROM_SIZE = 32 * 1024          # 32 KiB -> header ROM-size code 5 (2^5 KiB)
BASE = 0x8000                 # LoROM bank $00: ROM offset 0 maps to $00:8000
HEADER = 0x7FC0               # internal header at $00:FFC0 -> ROM offset $7FC0
FILL = 0xFF

# ---------------------------------------------------------------------------------------------
# A tiny two-pass assembler: fixed-length instructions, labels, 8-bit relative branches.
# ---------------------------------------------------------------------------------------------
class Asm:
    def __init__(self, org):
        self.org = org
        self.out = bytearray()
        self.labels = {}
        self.fixups = []          # (offset_of_operand_byte, label)
        self.listing = []

    @property
    def pc(self):
        return self.org + len(self.out)

    def label(self, name):
        self.labels[name] = self.pc
        self.listing.append(f"{name}:")

    def emit(self, data, text):
        self.listing.append(f"  ${self.pc:04X}: {data.hex(' '):<12} {text}")
        self.out += data

    def op(self, *b, text=""):
        self.emit(bytes(b), text)

    def branch(self, opcode, label, text):
        self.fixups.append((len(self.out) + 1, label, len(self.listing), opcode, text))
        self.emit(bytes([opcode, 0x00]), f"{text} -> {label}")

    def resolve(self):
        for off, label, line, opcode, text in self.fixups:
            target = self.labels[label]
            rel = target - (self.org + off + 1)   # relative to the byte after the branch
            if not -128 <= rel <= 127:
                raise ValueError(f"branch to {label} out of range ({rel})")
            self.out[off] = rel & 0xFF
            pc = self.org + off - 1
            self.listing[line] = f"  ${pc:04X}: {opcode:02x} {rel & 0xFF:02x}        {text} -> {label} (${target:04X})"


# ---------------------------------------------------------------------------------------------
# WRAM layout (direct page, D = 0, which is $7E0000.. through the bank $00 mirror).
# All values are 16-bit little-endian words.
# ---------------------------------------------------------------------------------------------
FRAME = 0x00    # $7E0000: frame counter (NMIs seen)
SUM1 = 0x02     # $7E0002: running sum of pad 1 masks ($4218/$4219)
SUM2 = 0x04     # $7E0004: running sum of pad 2 masks ($421A/$421B)
HASH1 = 0x06    # $7E0006: hash1 = rol16(hash1) ^ pad1, every frame
HASH2 = 0x08    # $7E0008: hash2 = rol16(hash2) ^ pad2, every frame
LAST1 = 0x0A    # $7E000A: pad 1 mask of the latest frame
LAST2 = 0x0C    # $7E000C: pad 2 mask of the latest frame
HELD1 = 0x0E    # $7E000E: frames in which pad 1 had any bit set
HELD2 = 0x10    # $7E0010: frames in which pad 2 had any bit set
# SRAM layout (bank $70, 2 KiB battery RAM; LoROM maps it at $70:0000-$70:07FF):
#   $700000 hash1   $700002 hash2   $700004 frame   $700006 held1   $700008 held2
# Backdrop colour (CGRAM 0) = ($4210 ^ pad1 ^ byteswap(pad2)) & $7FFF, so the screen changes
# with input and is never black.


def build_code():
    a = Asm(BASE)

    # ----- RESET ($8000). CPU starts in emulation mode, 8-bit registers, D=0, DB=0. -----
    a.label("reset")
    a.op(0x78,              text="SEI             ; IRQs off (NMI is non-maskable anyway)")
    a.op(0x18,              text="CLC")
    a.op(0xFB,              text="XCE             ; carry -> E: switch to native mode")
    a.op(0xC2, 0x10,        text="REP #$10        ; X/Y 16-bit")
    a.op(0xE2, 0x20,        text="SEP #$20        ; A 8-bit")
    a.op(0xA2, 0xFF, 0x1F,  text="LDX #$1FFF")
    a.op(0x9A,              text="TXS             ; stack at $1FFF")
    a.op(0x4B,              text="PHK")
    a.op(0xAB,              text="PLB             ; data bank = program bank ($00)")
    a.op(0xA9, 0x80,        text="LDA #$80")
    a.op(0x8D, 0x00, 0x21,  text="STA $2100       ; INIDISP: force blank while we set up")
    a.op(0x9C, 0x00, 0x42,  text="STZ $4200       ; NMITIMEN: NMI + auto-joypad off during init")
    a.op(0x9C, 0x0B, 0x42,  text="STZ $420B       ; MDMAEN: no DMA")
    a.op(0x9C, 0x0C, 0x42,  text="STZ $420C       ; HDMAEN: no HDMA")
    a.op(0x9C, 0x05, 0x21,  text="STZ $2105       ; BGMODE 0 (unused, no layers enabled)")
    a.op(0x9C, 0x2C, 0x21,  text="STZ $212C       ; TM: no layers on main screen -> backdrop only")
    a.op(0x9C, 0x2D, 0x21,  text="STZ $212D       ; TS: nothing on sub screen")
    a.op(0x9C, 0x30, 0x21,  text="STZ $2130       ; CGWSEL: no colour window")
    a.op(0x9C, 0x31, 0x21,  text="STZ $2131       ; CGADSUB: no colour math")
    a.op(0x9C, 0x33, 0x21,  text="STZ $2133       ; SETINI: no interlace / overscan")
    a.op(0xC2, 0x20,        text="REP #$20        ; A 16-bit")
    for dp in (FRAME, SUM1, SUM2, HASH1, HASH2, LAST1, LAST2, HELD1, HELD2):
        a.op(0x64, dp,      text=f"STZ ${dp:02X}         ; clear WRAM word $7E{dp:04X}")
    a.op(0xE2, 0x20,        text="SEP #$20        ; A 8-bit")
    a.op(0x9C, 0x21, 0x21,  text="STZ $2121       ; CGADD = 0 (backdrop colour)")
    a.op(0xA9, 0x10,        text="LDA #$10")
    a.op(0x8D, 0x22, 0x21,  text="STA $2122       ; CGDATA low  -> colour $4210 (dim teal)")
    a.op(0xA9, 0x42,        text="LDA #$42")
    a.op(0x8D, 0x22, 0x21,  text="STA $2122       ; CGDATA high")
    a.op(0xA9, 0x0F,        text="LDA #$0F")
    a.op(0x8D, 0x00, 0x21,  text="STA $2100       ; INIDISP: screen on, full brightness")
    a.op(0xA9, 0x81,        text="LDA #$81")
    a.op(0x8D, 0x00, 0x42,  text="STA $4200       ; NMITIMEN: VBlank NMI + auto-joypad read")
    a.label("main")
    a.op(0xCB,              text="WAI             ; sleep until the next NMI")
    a.branch(0x80, "main",  "BRA")

    # ----- NMI (native vector). Runs once per frame during VBlank. -----
    a.label("nmi")
    a.op(0xC2, 0x30,        text="REP #$30        ; A/X/Y 16-bit")
    a.op(0x48,              text="PHA")
    a.op(0xDA,              text="PHX")
    a.op(0x5A,              text="PHY")
    a.op(0x8B,              text="PHB")
    a.op(0x4B,              text="PHK")
    a.op(0xAB,              text="PLB             ; data bank = $00")
    a.op(0xE2, 0x20,        text="SEP #$20        ; A 8-bit")
    a.op(0xAD, 0x10, 0x42,  text="LDA $4210       ; RDNMI: acknowledge the NMI")
    a.label("wait_joy")
    a.op(0xAD, 0x12, 0x42,  text="LDA $4212       ; HVBJOY")
    a.op(0x29, 0x01,        text="AND #$01        ; bit 0 = auto-joypad read in progress")
    a.branch(0xD0, "wait_joy", "BNE             ; wait until the pads are latched")
    a.op(0xC2, 0x20,        text="REP #$20        ; A 16-bit")

    # pad 1 -> SUM1, HASH1, LAST1
    a.op(0xAD, 0x18, 0x42,  text="LDA $4218       ; JOY1L/JOY1H: pad 1 mask (16-bit read)")
    a.op(0x85, LAST1,       text="STA LAST1")
    a.op(0x18,              text="CLC")
    a.op(0x65, SUM1,        text="ADC SUM1")
    a.op(0x85, SUM1,        text="STA SUM1        ; sum1 += pad1")
    a.op(0xA5, HASH1,       text="LDA HASH1")
    a.op(0x0A,              text="ASL A           ; bit 15 -> carry")
    a.op(0x69, 0x00, 0x00,  text="ADC #$0000      ; carry -> bit 0: 16-bit rotate left")
    a.op(0x45, LAST1,       text="EOR LAST1")
    a.op(0x85, HASH1,       text="STA HASH1       ; hash1 = rol(hash1) ^ pad1")

    # pad 2 -> SUM2, HASH2, LAST2
    a.op(0xAD, 0x1A, 0x42,  text="LDA $421A       ; JOY2L/JOY2H: pad 2 mask (16-bit read)")
    a.op(0x85, LAST2,       text="STA LAST2")
    a.op(0x18,              text="CLC")
    a.op(0x65, SUM2,        text="ADC SUM2")
    a.op(0x85, SUM2,        text="STA SUM2        ; sum2 += pad2")
    a.op(0xA5, HASH2,       text="LDA HASH2")
    a.op(0x0A,              text="ASL A")
    a.op(0x69, 0x00, 0x00,  text="ADC #$0000      ; rotate left")
    a.op(0x45, LAST2,       text="EOR LAST2")
    a.op(0x85, HASH2,       text="STA HASH2       ; hash2 = rol(hash2) ^ pad2")

    a.op(0xE6, FRAME,       text="INC FRAME       ; frame counter (16-bit)")
    a.op(0xA5, LAST1,       text="LDA LAST1")
    a.branch(0xF0, "skip1", "BEQ             ; nothing held on pad 1")
    a.op(0xE6, HELD1,       text="INC HELD1")
    a.label("skip1")
    a.op(0xA5, LAST2,       text="LDA LAST2")
    a.branch(0xF0, "skip2", "BEQ             ; nothing held on pad 2")
    a.op(0xE6, HELD2,       text="INC HELD2")
    a.label("skip2")

    # SRAM mirror of the state (bank $70, long addressing)
    a.op(0xA5, HASH1,       text="LDA HASH1")
    a.op(0x8F, 0x00, 0x00, 0x70, text="STA $700000     ; SRAM[0..1] = hash1")
    a.op(0xA5, HASH2,       text="LDA HASH2")
    a.op(0x8F, 0x02, 0x00, 0x70, text="STA $700002     ; SRAM[2..3] = hash2")
    a.op(0xA5, FRAME,       text="LDA FRAME")
    a.op(0x8F, 0x04, 0x00, 0x70, text="STA $700004     ; SRAM[4..5] = frame")
    a.op(0xA5, HELD1,       text="LDA HELD1")
    a.op(0x8F, 0x06, 0x00, 0x70, text="STA $700006     ; SRAM[6..7] = held1")
    a.op(0xA5, HELD2,       text="LDA HELD2")
    a.op(0x8F, 0x08, 0x00, 0x70, text="STA $700008     ; SRAM[8..9] = held2")

    # backdrop colour from both pads (we are in VBlank, CGRAM writes are safe)
    a.op(0xA5, LAST2,       text="LDA LAST2")
    a.op(0xEB,              text="XBA             ; swap bytes of pad2")
    a.op(0x45, LAST1,       text="EOR LAST1")
    a.op(0x49, 0x10, 0x42,  text="EOR #$4210      ; base colour so idle is not black")
    a.op(0x29, 0xFF, 0x7F,  text="AND #$7FFF      ; BGR555 has 15 bits")
    a.op(0xE2, 0x20,        text="SEP #$20        ; A 8-bit (B holds the high byte)")
    a.op(0x9C, 0x21, 0x21,  text="STZ $2121       ; CGADD = 0")
    a.op(0x8D, 0x22, 0x21,  text="STA $2122       ; CGDATA low")
    a.op(0xEB,              text="XBA")
    a.op(0x8D, 0x22, 0x21,  text="STA $2122       ; CGDATA high")
    a.op(0xA9, 0x0F,        text="LDA #$0F")
    a.op(0x8D, 0x00, 0x21,  text="STA $2100       ; keep the screen on")

    a.op(0xC2, 0x30,        text="REP #$30        ; A/X/Y 16-bit for the pulls")
    a.op(0xAB,              text="PLB")
    a.op(0x7A,              text="PLY")
    a.op(0xFA,              text="PLX")
    a.op(0x68,              text="PLA")
    a.op(0x40,              text="RTI")

    # ----- Every other vector (COP, BRK, ABORT, IRQ, emulation-mode entries). -----
    a.label("rti")
    a.op(0x40,              text="RTI")

    a.resolve()
    return a


def build_rom():
    code = build_code()
    rom = bytearray([FILL]) * ROM_SIZE
    rom[0:len(code.out)] = code.out

    reset, nmi, rti = code.labels["reset"], code.labels["nmi"], code.labels["rti"]

    # Internal header ($00:FFC0 -> offset $7FC0)
    title = b"NB INPUT TEST".ljust(21, b" ")
    hdr = bytearray()
    hdr += title                               # $FFC0-$FFD4 title (21 bytes, space padded)
    hdr += bytes([0x20])                       # $FFD5 map mode: LoROM, slow ROM
    hdr += bytes([0x02])                       # $FFD6 cartridge type: ROM + RAM + battery
    hdr += bytes([ROM_SIZE.bit_length() - 11]) # $FFD7 ROM size: 2^n KiB (32 KiB -> 5)
    hdr += bytes([0x01])                       # $FFD8 RAM size: 2^1 KiB = 2 KiB battery SRAM
    hdr += bytes([0x01])                       # $FFD9 region: North America (NTSC)
    hdr += bytes([0x00])                       # $FFDA developer ID (no extended header)
    hdr += bytes([0x00])                       # $FFDB version 1.0
    hdr += struct.pack("<H", 0xFFFF)           # $FFDC checksum complement (placeholder)
    hdr += struct.pack("<H", 0x0000)           # $FFDE checksum (placeholder)
    # Native-mode vectors $FFE0-$FFEF: --, --, COP, BRK, ABORT, NMI, (unused), IRQ
    hdr += struct.pack("<8H", 0xFFFF, 0xFFFF, rti, rti, rti, nmi, rti, rti)
    # Emulation-mode vectors $FFF0-$FFFF: --, --, COP, (unused), ABORT, NMI, RESET, IRQ/BRK
    hdr += struct.pack("<8H", 0xFFFF, 0xFFFF, rti, rti, rti, rti, reset, rti)
    assert len(hdr) == 0x40
    rom[HEADER:HEADER + 0x40] = hdr

    # Checksum: 16-bit sum of every byte with checksum=$0000 and complement=$FFFF; those four
    # bytes always add up to $1FE whatever the final values are, so the sum stays valid.
    checksum = sum(rom) & 0xFFFF
    rom[HEADER + 0x1C:HEADER + 0x1E] = struct.pack("<H", checksum ^ 0xFFFF)
    rom[HEADER + 0x1E:HEADER + 0x20] = struct.pack("<H", checksum)
    return bytes(rom), code


def self_check(rom):
    assert len(rom) == ROM_SIZE and (len(rom) & (len(rom) - 1)) == 0, "size must be a power of two"
    h = rom[HEADER:HEADER + 0x40]
    checksum = struct.unpack_from("<H", h, 0x1E)[0]
    complement = struct.unpack_from("<H", h, 0x1C)[0]
    assert checksum ^ complement == 0xFFFF, "complement mismatch"
    # Recompute the way an emulator does: zero both fields, add $1FE for them, sum the rest.
    body = bytearray(rom)
    body[HEADER + 0x1C:HEADER + 0x20] = b"\xff\xff\x00\x00"
    assert (sum(body) & 0xFFFF) == checksum, "checksum mismatch"
    assert h[0x15] == 0x20 and h[0x16] == 0x02 and h[0x18] == 0x01, "header fields"
    assert (1 << h[0x17]) * 1024 == ROM_SIZE, "ROM size code"
    for off in range(0x24, 0x40, 2):
        if off in (0x20, 0x22, 0x30, 0x32):  # the four unused $FFFF slots
            continue
        v = struct.unpack_from("<H", h, off)[0]
        assert BASE <= v < BASE + ROM_SIZE and v != 0xFFFF, f"vector at $FF{0xC0 + off:02X} = ${v:04X} outside ROM"
        assert rom[v - BASE] != FILL, f"vector ${v:04X} points at fill"
    reset = struct.unpack_from("<H", h, 0x3C)[0]
    assert reset == BASE, "reset vector must be $8000"
    assert rom[0] == 0x78 and rom[1] == 0x18 and rom[2] == 0xFB, "reset starts with SEI CLC XCE"


def main():
    here = Path(__file__).resolve().parent
    rom, code = build_rom()
    self_check(rom)
    out = here / "input-test.sfc"
    out.write_bytes(rom)
    if "--listing" in sys.argv:
        print("\n".join(code.listing))
    checksum = struct.unpack_from("<H", rom, HEADER + 0x1E)[0]
    print(f"wrote {out.name}: {len(rom)} bytes, code {len(code.out)} bytes, "
          f"reset=${code.labels['reset']:04X} nmi=${code.labels['nmi']:04X} checksum=${checksum:04X}")


if __name__ == "__main__":
    main()
