#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Light Soldier Games / NostaljiBox contributors
#
# Behavioural self-check for input-test.sfc without a real emulator: a minimal 65816 interpreter
# that knows exactly the opcodes the ROM uses, a stub of the few MMIO registers it touches
# ($2100, $2121/$2122, $4200, $4210, $4212, $4218-$421B), WRAM at bank $00/$7E and 2 KiB SRAM at
# $70:0000. It runs N frames with scripted pad masks and checks the WRAM/SRAM words against the
# README's formulas, and that port-1-only input changes WRAM while leaving the pad-2 words alone.
# Run:  python simulate.py [input-test.sfc]

import struct
import sys
from pathlib import Path

N, V, M, X, D, I, Z, C = 0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01


class Snes:
    def __init__(self, rom):
        self.rom = rom
        self.wram = bytearray(0x20000)
        self.sram = bytearray(0x800)
        self.cgram = {}
        self.cgadd = 0
        self.cglow = None
        self.inidisp = 0
        self.nmitimen = 0
        self.pads = (0, 0)
        self.joy_busy = 0   # reads of $4212 that still report "auto-read in progress"
        self.waiting = False
        self.nmis = 0
        # reset state
        self.a = self.x = self.y = 0
        self.s = 0x01FF
        self.dp = 0
        self.db = 0
        self.pb = 0
        self.e = 1
        self.p = M | X | I
        self.pc = struct.unpack_from("<H", rom, 0x7FFC)[0]

    # ---- memory -------------------------------------------------------------------------
    def read(self, addr):
        bank, off = (addr >> 16) & 0xFF, addr & 0xFFFF
        if bank in (0x7E, 0x7F):
            return self.wram[((bank - 0x7E) << 16) | off]
        if bank == 0x70 and off < 0x8000:
            return self.sram[off & 0x7FF]
        if bank < 0x40 and off < 0x2000:
            return self.wram[off]
        if bank < 0x40 and off >= 0x8000:
            return self.rom[(bank & 0x7F) * 0x8000 + off - 0x8000]
        if bank < 0x40:
            if off == 0x4210:
                return 0x80 | 2
            if off == 0x4212:
                if self.joy_busy:
                    self.joy_busy -= 1
                    return 0x81
                return 0x80
            if 0x4218 <= off <= 0x421B:
                pad = self.pads[(off - 0x4218) >> 1]
                return (pad >> (8 * (off & 1))) & 0xFF
            return 0
        raise ValueError(f"read from unmapped ${addr:06X}")

    def write(self, addr, val):
        bank, off = (addr >> 16) & 0xFF, addr & 0xFFFF
        val &= 0xFF
        if bank in (0x7E, 0x7F):
            self.wram[((bank - 0x7E) << 16) | off] = val
        elif bank == 0x70 and off < 0x8000:
            self.sram[off & 0x7FF] = val
        elif bank < 0x40 and off < 0x2000:
            self.wram[off] = val
        elif bank < 0x40 and off < 0x8000:
            if off == 0x2100:
                self.inidisp = val
            elif off == 0x2121:
                self.cgadd = val
                self.cglow = None
            elif off == 0x2122:
                if self.cglow is None:
                    self.cglow = val
                else:
                    self.cgram[self.cgadd] = self.cglow | (val << 8)
                    self.cgadd = (self.cgadd + 1) & 0xFF
                    self.cglow = None
            elif off == 0x4200:
                self.nmitimen = val
            elif off in (0x2105, 0x212C, 0x212D, 0x2130, 0x2131, 0x2133, 0x420B, 0x420C):
                pass
            else:
                raise ValueError(f"write to unexpected register ${off:04X}")
        else:
            raise ValueError(f"write to unmapped ${addr:06X}")

    def read16(self, addr):
        return self.read(addr) | (self.read(addr + 1) << 8)

    def write16(self, addr, val):
        self.write(addr, val & 0xFF)
        self.write(addr + 1, val >> 8)

    # ---- helpers -------------------------------------------------------------------------
    def fetch(self):
        v = self.read((self.pb << 16) | self.pc)
        self.pc = (self.pc + 1) & 0xFFFF
        return v

    def fetch16(self):
        lo = self.fetch()
        return lo | (self.fetch() << 8)

    def push(self, v):
        self.write(self.s, v)
        self.s = (self.s - 1) & 0xFFFF if not self.e else 0x0100 | ((self.s - 1) & 0xFF)

    def pull(self):
        self.s = (self.s + 1) & 0xFFFF if not self.e else 0x0100 | ((self.s + 1) & 0xFF)
        return self.read(self.s)

    def m8(self):
        return bool(self.p & M)

    def x8(self):
        return bool(self.p & X)

    def setnz(self, v, eight):
        self.p &= ~(N | Z)
        if (v & (0xFF if eight else 0xFFFF)) == 0:
            self.p |= Z
        if v & (0x80 if eight else 0x8000):
            self.p |= N

    def set_a(self, v):
        if self.m8():
            self.a = (self.a & 0xFF00) | (v & 0xFF)
        else:
            self.a = v & 0xFFFF
        self.setnz(v, self.m8())

    def get_a(self):
        return self.a & 0xFF if self.m8() else self.a

    def load_a(self, addr):
        self.set_a(self.read(addr) if self.m8() else self.read16(addr))

    def store_a(self, addr):
        if self.m8():
            self.write(addr, self.a & 0xFF)
        else:
            self.write16(addr, self.a)

    def adc(self, operand):
        if self.p & D:
            raise ValueError("decimal mode not modelled")
        mask = 0xFF if self.m8() else 0xFFFF
        a = self.get_a()
        r = a + operand + (self.p & C)
        self.p &= ~(C | V)
        if r > mask:
            self.p |= C
        sign = (mask + 1) >> 1
        if (~(a ^ operand) & (a ^ r)) & sign:
            self.p |= V
        self.set_a(r & mask)

    def dp_addr(self, off):
        return (self.dp + off) & 0xFFFF           # bank 0

    def abs_addr(self, off):
        return (self.db << 16) | off

    def branch(self, cond):
        rel = self.fetch()
        if cond:
            self.pc = (self.pc + (rel - 256 if rel > 127 else rel)) & 0xFFFF

    # ---- NMI -------------------------------------------------------------------------------
    def nmi(self):
        self.push(self.pb)
        self.push(self.pc >> 8)
        self.push(self.pc & 0xFF)
        self.push(self.p)
        self.p = (self.p | I) & ~D
        self.pb = 0
        self.pc = struct.unpack_from("<H", self.rom, 0x7FEA)[0]
        self.joy_busy = 2
        self.nmis += 1

    # ---- one instruction ---------------------------------------------------------------
    def step(self):
        op = self.fetch()
        if op == 0x78: self.p |= I                                             # SEI
        elif op == 0x18: self.p &= ~C                                          # CLC
        elif op == 0xFB:                                                       # XCE: swap C and E
            old_c = self.p & C
            self.p = (self.p & ~C) | (1 if self.e else 0)
            self.e = old_c
            if self.e:
                self.p |= M | X
                self.s = 0x0100 | (self.s & 0xFF)
        elif op == 0xC2: self.p &= ~self.fetch()                               # REP #imm
        elif op == 0xE2:                                                       # SEP #imm
            self.p |= self.fetch()
            if self.p & X:
                self.x &= 0xFF
                self.y &= 0xFF
        elif op == 0xA2:                                                       # LDX #imm
            self.x = self.fetch() if self.x8() else self.fetch16()
            self.setnz(self.x, self.x8())
        elif op == 0x9A: self.s = self.x if not self.e else 0x0100 | (self.x & 0xFF)  # TXS
        elif op == 0x4B: self.push(self.pb)                                    # PHK
        elif op == 0xAB: self.db = self.pull(); self.setnz(self.db, True)      # PLB
        elif op == 0xA9: self.set_a(self.fetch() if self.m8() else self.fetch16())  # LDA #imm
        elif op == 0x8D: self.store_a(self.abs_addr(self.fetch16()))           # STA abs
        elif op == 0x9C:                                                       # STZ abs
            addr = self.abs_addr(self.fetch16())
            self.write(addr, 0)
            if not self.m8():
                self.write(addr + 1, 0)
        elif op == 0x64:                                                       # STZ dp
            addr = self.dp_addr(self.fetch())
            self.write(addr, 0)
            if not self.m8():
                self.write(addr + 1, 0)
        elif op == 0xCB: self.waiting = True                                   # WAI
        elif op == 0x80: self.branch(True)                                     # BRA
        elif op == 0x48:                                                       # PHA
            if not self.m8():
                self.push(self.a >> 8)
            self.push(self.a & 0xFF)
        elif op == 0xDA:                                                       # PHX
            if not self.x8():
                self.push(self.x >> 8)
            self.push(self.x & 0xFF)
        elif op == 0x5A:                                                       # PHY
            if not self.x8():
                self.push(self.y >> 8)
            self.push(self.y & 0xFF)
        elif op == 0x8B: self.push(self.db)                                    # PHB
        elif op == 0xAD: self.load_a(self.abs_addr(self.fetch16()))            # LDA abs
        elif op == 0x29: self.set_a(self.get_a() & (self.fetch() if self.m8() else self.fetch16()))  # AND #imm
        elif op == 0xD0: self.branch(not self.p & Z)                           # BNE
        elif op == 0xF0: self.branch(bool(self.p & Z))                         # BEQ
        elif op == 0x85: self.store_a(self.dp_addr(self.fetch()))              # STA dp
        elif op == 0x65:                                                       # ADC dp
            addr = self.dp_addr(self.fetch())
            self.adc(self.read(addr) if self.m8() else self.read16(addr))
        elif op == 0x69: self.adc(self.fetch() if self.m8() else self.fetch16())  # ADC #imm
        elif op == 0xA5: self.load_a(self.dp_addr(self.fetch()))               # LDA dp
        elif op == 0x0A:                                                       # ASL A
            a = self.get_a()
            top = 0x80 if self.m8() else 0x8000
            self.p = (self.p & ~C) | (1 if a & top else 0)
            self.set_a((a << 1) & (top * 2 - 1))
        elif op == 0x45:                                                       # EOR dp
            addr = self.dp_addr(self.fetch())
            self.set_a(self.get_a() ^ (self.read(addr) if self.m8() else self.read16(addr)))
        elif op == 0x49: self.set_a(self.get_a() ^ (self.fetch() if self.m8() else self.fetch16()))  # EOR #imm
        elif op == 0xE6:                                                       # INC dp
            addr = self.dp_addr(self.fetch())
            if self.m8():
                v = (self.read(addr) + 1) & 0xFF
                self.write(addr, v)
            else:
                v = (self.read16(addr) + 1) & 0xFFFF
                self.write16(addr, v)
            self.setnz(v, self.m8())
        elif op == 0x8F: self.store_a(self.fetch16() | (self.fetch() << 16))   # STA long
        elif op == 0xEB:                                                       # XBA
            self.a = ((self.a & 0xFF) << 8) | (self.a >> 8)
            self.setnz(self.a & 0xFF, True)
        elif op == 0x7A:                                                       # PLY
            self.y = self.pull()
            if not self.x8():
                self.y |= self.pull() << 8
            self.setnz(self.y, self.x8())
        elif op == 0xFA:                                                       # PLX
            self.x = self.pull()
            if not self.x8():
                self.x |= self.pull() << 8
            self.setnz(self.x, self.x8())
        elif op == 0x68:                                                       # PLA
            v = self.pull()
            if not self.m8():
                v |= self.pull() << 8
            self.set_a(v)
        elif op == 0x40:                                                       # RTI
            self.p = self.pull()
            if self.e:
                self.p |= M | X
            self.pc = self.pull() | (self.pull() << 8)
            if not self.e:
                self.pb = self.pull()
        else:
            raise ValueError(f"opcode ${op:02X} at ${self.pb:02X}:{self.pc - 1:04X} not modelled")

    # ---- frame driver ----------------------------------------------------------------
    def run_until_wait(self, limit=100000):
        for _ in range(limit):
            if self.waiting:
                return
            self.step()
        raise RuntimeError("CPU did not reach WAI")

    def frame(self, pad1, pad2):
        """Deliver one VBlank: latch the pads, fire NMI (if enabled), run the handler to the next WAI."""
        self.run_until_wait()
        assert self.nmitimen & 0x81 == 0x81, "NMI + auto-joypad must be enabled"
        self.pads = (pad1, pad2)
        self.waiting = False
        self.nmi()
        self.run_until_wait()

    def word(self, addr):
        return self.read16(addr)


def rol16(v):
    return ((v << 1) | (v >> 15)) & 0xFFFF


def expected(script):
    frame = sum1 = sum2 = h1 = h2 = held1 = held2 = 0
    for p1, p2 in script:
        frame += 1
        sum1 = (sum1 + p1) & 0xFFFF
        sum2 = (sum2 + p2) & 0xFFFF
        h1 = rol16(h1) ^ p1
        h2 = rol16(h2) ^ p2
        held1 += p1 != 0
        held2 += p2 != 0
    last1, last2 = script[-1]
    colour = (0x4210 ^ last1 ^ (((last2 & 0xFF) << 8) | (last2 >> 8))) & 0x7FFF
    return dict(frame=frame, sum1=sum1, sum2=sum2, hash1=h1, hash2=h2, last1=last1, last2=last2,
                held1=held1, held2=held2, colour=colour)


def observed(s):
    return dict(frame=s.word(0x7E0000), sum1=s.word(0x7E0002), sum2=s.word(0x7E0004),
                hash1=s.word(0x7E0006), hash2=s.word(0x7E0008), last1=s.word(0x7E000A),
                last2=s.word(0x7E000C), held1=s.word(0x7E000E), held2=s.word(0x7E0010),
                colour=s.cgram.get(0))


def run(rom, script):
    s = Snes(rom)
    for p1, p2 in script:
        s.frame(p1, p2)
    return s


def main():
    path = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("input-test.sfc"))
    rom = path.read_bytes()

    # A: both pads active (RetroPad-ish masks: B=$8000, Y=$4000, Start=$1000, Right=$0100, A=$80).
    seed = 12345
    script = []
    for _ in range(600):
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
        p1 = (seed >> 8) & 0xFFF0 if (seed >> 4) & 3 else 0
        p2 = (seed >> 16) & 0xFFF0 if (seed >> 6) & 1 else 0
        script.append((p1, p2))
    s = run(rom, script)
    exp, obs = expected(script), observed(s)
    assert obs == exp, f"\nexpected {exp}\nobserved {obs}"
    assert s.sram[0:2] == struct.pack("<H", exp["hash1"]), "SRAM hash1"
    assert s.sram[2:4] == struct.pack("<H", exp["hash2"]), "SRAM hash2"
    assert s.sram[4:6] == struct.pack("<H", exp["frame"]), "SRAM frame"
    assert s.sram[6:8] == struct.pack("<H", exp["held1"]), "SRAM held1"
    assert s.sram[8:10] == struct.pack("<H", exp["held2"]), "SRAM held2"
    assert s.sram[10:] == bytes(0x800 - 10), "rest of SRAM untouched"
    assert s.inidisp == 0x0F, "screen stays on"
    assert s.nmis == 600

    # B: idle run vs port-1-only run: pad-1 words change, pad-2 words and frame do not.
    idle = observed(run(rom, [(0, 0)] * 600))
    p1only = observed(run(rom, [(p1, 0) for p1, _ in script]))
    assert idle["frame"] == p1only["frame"] == 600
    for k in ("sum1", "hash1", "held1", "last1", "colour"):
        assert idle[k] != p1only[k], f"{k} should depend on pad 1"
    for k in ("sum2", "hash2", "held2", "last2"):
        assert idle[k] == p1only[k] == 0, f"{k} must not depend on pad 1"
    assert idle["colour"] == 0x4210, "idle backdrop is the base colour, not black"
    p2only = observed(run(rom, [(0, p2) for _, p2 in script]))
    for k in ("sum2", "hash2", "held2", "last2"):
        assert p2only[k] == exp[k], f"{k} should depend only on pad 2"
    assert p2only["hash2"] != 0 and p2only["held2"] > 0
    assert p2only["sum1"] == p2only["hash1"] == 0

    # C: determinism: the same script twice gives identical WRAM and SRAM.
    t = run(rom, script)
    assert t.wram == s.wram and t.sram == s.sram
    print(f"simulate: OK  600 frames  hash1=${exp['hash1']:04X} hash2=${exp['hash2']:04X} "
          f"sum1=${exp['sum1']:04X} sum2=${exp['sum2']:04X} held1={exp['held1']} held2={exp['held2']} "
          f"colour=${exp['colour']:04X}")


if __name__ == "__main__":
    main()
