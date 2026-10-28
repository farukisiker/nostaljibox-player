// SPDX-License-Identifier: GPL-3.0-or-later
// Two-phone play in lockstep: both phones run the same game from the same savestate and only
// button states travel between them. Each phone sends its buttons for a frame DELAY frames ahead
// and does not run a frame before it has the other phone's buttons for it, so both emulators see
// the same input on the same frame and show the same game, each at full quality on its own screen.

const DELAY = 3; // frames of input delay (~50 ms), the same for both players
const CHECK_EVERY = 300; // frames between savestate comparisons (~5 s)
const BIG_STATE = 4 << 20; // DS/PS1-sized states take long to hash: compare them once a minute
const CHECK_BIG_EVERY = 3600;
const CHUNK = 16 * 1024; // binary message size every WebRTC stack accepts
const WAIT_NOTICE_MS = 1500;
const MAX_MASK = 1024; // more unrestored bytes than this means the load itself went wrong

// JSON messages plus binary transfers (ROM, savestate) on one data channel. A JSON message with a
// `size` announces that many bytes of binary chunks; onMessage gets it once they have all arrived.
export function channelIO(channel, onMessage) {
  channel.binaryType = "arraybuffer";
  let incoming = null;
  channel.onmessage = (m) => {
    if (typeof m.data === "string") {
      const msg = JSON.parse(m.data);
      if (msg.size) incoming = { msg, bytes: new Uint8Array(msg.size), got: 0 };
      else onMessage(msg);
      return;
    }
    if (!incoming) return;
    incoming.bytes.set(new Uint8Array(m.data), incoming.got);
    incoming.got += m.data.byteLength;
    if (incoming.got >= incoming.bytes.length) {
      const { msg, bytes } = incoming;
      incoming = null;
      onMessage(msg, bytes);
    }
  };
  const open = () => channel.readyState === "open";
  const drain = () =>
    channel.bufferedAmount < 1 << 20
      ? Promise.resolve()
      : new Promise((resolve) => {
          channel.bufferedAmountLowThreshold = 256 * 1024;
          channel.addEventListener("bufferedamountlow", resolve, { once: true });
        });
  return {
    send(msg) {
      if (open()) channel.send(JSON.stringify(msg));
    },
    async sendBytes(msg, bytes) {
      if (!open()) return;
      channel.send(JSON.stringify({ ...msg, size: bytes.length }));
      for (let i = 0; i < bytes.length && open(); i += CHUNK) {
        await drain();
        channel.send(bytes.subarray(i, i + CHUNK));
      }
    },
  };
}

// Hashes a savestate, skipping the bytes a load does not restore (e.g. a core's running cycle
// counter): they differ between phones even when the games are identical.
function hash(bytes, mask) {
  if (mask) for (const i of mask) bytes[i] = 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}

// Keys are "port:button"; values are what simulate_input takes (1, or an analog amount).
function keyParts(key) {
  const [port, button] = key.split(":");
  return [Number(port), Number(button)];
}

export class Lockstep {
  constructor(emu, io, isHost, onWait) {
    this.emu = emu;
    this.gm = emu.gameManager;
    this.raw = this.gm.functions;
    this.io = io;
    this.isHost = isHost;
    this.onWait = onWait || (() => {});
    this.epoch = 0;
    this.held = {}; // this phone's buttons right now
    this.applied = [{}, {}]; // buttons fed to the core: [host's, guest's]
    this.active = false;
    this.hold = false;
    this.wantRun = true; // EmulatorJS's own pause state (menus etc.)
    this.running = true;
    this.checkEvery = CHECK_EVERY;
  }

  attach() {
    this.emu.lockstep = this; // handy when debugging from the console
    const gm = this.gm;
    const local = gm.simulateInput.bind(gm);
    // Hotkeys (save/load state, fast forward…) stay local; buttons go through the lockstep.
    gm.simulateInput = (player, button, value) => {
      if (button >= 24) return local(player, button, value);
      const port = this.isHost ? player : player === 0 ? 1 : -1;
      if (port < 0) return;
      const key = port + ":" + button;
      if (value) this.held[key] = value;
      else delete this.held[key];
    };
    gm.toggleMainLoop = (playing) => {
      this.wantRun = !!playing;
      this.updateLoop();
    };
    // The emulator's main loop runs one frame per animation frame. Newer emscripten has no
    // Module.postMainLoop, so check right after each callback whether a frame just ran.
    const raf = (this.nativeRaf = window.requestAnimationFrame);
    window.requestAnimationFrame = (cb) =>
      raf.call(window, (t) => {
        cb(t);
        this.afterFrame();
      });
    this.lastFrameNum = this.raw.getFrameNum();
    this.waitTimer = setInterval(() => {
      const waiting = this.active && this.waitingSince && performance.now() - this.waitingSince > WAIT_NOTICE_MS;
      if (waiting !== this.noticeShown) this.onWait((this.noticeShown = waiting));
    }, 250);
  }

  // Back to single player, e.g. after the other phone left.
  detach() {
    this.active = false;
    delete this.emu.lockstep;
    clearInterval(this.waitTimer);
    if (this.noticeShown) this.onWait(false);
    delete this.gm.simulateInput;
    delete this.gm.toggleMainLoop;
    window.requestAnimationFrame = this.nativeRaf;
    this.applySide(this.isHost ? 1 : 0, {});
    this.hold = false;
    this.updateLoop();
  }

  setHold(hold) {
    this.hold = hold;
    if (!hold) this.waitingSince = 0;
    else if (!this.waitingSince) this.waitingSince = performance.now();
    this.updateLoop();
  }

  updateLoop() {
    const run = this.wantRun && !this.hold;
    if (run === this.running) return;
    this.running = run;
    this.raw.toggleMainLoop(run ? 1 : 0);
  }

  afterFrame() {
    const n = this.raw.getFrameNum();
    if (n === this.lastFrameNum) return;
    this.lastFrameNum = n;
    if (this.loading) return this.loaded();
    if (!this.active) return;
    this.frame++;
    this.gate();
  }

  // Runs between frames: publish this phone's buttons for a later frame, then let the next frame
  // run only once both phones' buttons for it are known.
  gate() {
    const f = this.frame;
    const mine = { ...this.held };
    this.local.set(f + DELAY, mine);
    this.io.send(["i", this.epoch, f + DELAY, mine]);
    if (f > 0 && f % this.checkEvery === 0) this.check(f);
    if (this.resyncWanted) return this.resync();
    this.advance();
  }

  advance() {
    const f = this.frame;
    const me = this.isHost ? 0 : 1;
    const mine = f < DELAY ? this.applied[me] : this.local.get(f);
    const theirs = f < DELAY ? this.applied[1 - me] : this.remote.get(f);
    if (!theirs) return this.setHold(true);
    // Same order on both phones: host's buttons first.
    this.applySide(0, me === 0 ? mine : theirs);
    this.applySide(1, me === 1 ? mine : theirs);
    this.local.delete(f);
    this.remote.delete(f);
    this.setHold(false);
  }

  applySide(side, keys) {
    const prev = this.applied[side];
    for (const k in prev) if (!(k in keys)) this.raw.simulateInput(...keyParts(k), 0);
    for (const k in keys) if (prev[k] !== keys[k]) this.raw.simulateInput(...keyParts(k), keys[k]);
    this.applied[side] = keys;
  }

  restart() {
    this.frame = 0;
    this.local = new Map();
    this.remote = new Map();
    this.hashes = new Map();
    this.active = true;
    this.gate();
  }

  // EmulatorJS's getState never frees the buffer the core writes the savestate into, so every call
  // leaks a whole savestate. Taken every few seconds, that ran phones out of memory mid-game.
  getState() {
    const [size, start, ok] = this.raw.saveStateInfo().split("|");
    if (ok !== "1") throw new Error(size);
    const state = this.gm.Module.HEAPU8.slice(+start, +start + +size);
    this.gm.Module._free(+start);
    return state;
  }

  // Both phones hash their savestate on the same frame; the host compares and resyncs on a mismatch.
  check(f) {
    const state = this.getState();
    // Same game on both phones, so both switch to the longer interval on the same frame.
    if (state.length > BIG_STATE) this.checkEvery = CHECK_BIG_EVERY;
    const h = hash(state, this.mask);
    if (!this.isHost) return this.io.send(["h", this.epoch, f, h]);
    this.compare(f, h, "mine");
  }

  compare(f, h, whose) {
    const entry = this.hashes.get(f) || {};
    entry[whose] = h;
    this.hashes.set(f, entry);
    if (entry.mine === undefined || entry.theirs === undefined) return;
    this.hashes.delete(f);
    if (entry.mine !== entry.theirs) {
      console.warn("lockstep: phones drifted apart at frame", f, "- resyncing");
      this.resyncWanted = true;
    }
  }

  // Host: freeze, send the savestate and the buttons in effect; both restart from frame 0.
  resync() {
    this.resyncWanted = false;
    this.active = false;
    this.setHold(true);
    this.epoch++;
    this.io.sendBytes({ t: "state", epoch: this.epoch, applied: this.applied }, this.getState());
  }

  onMessage(msg, bytes) {
    if (Array.isArray(msg)) {
      const [type, epoch, f, value] = msg;
      if (epoch !== this.epoch || !this.active) return;
      if (type === "i") {
        this.remote.set(f, value);
        if (this.hold && f === this.frame) this.advance();
      } else if (type === "h" && this.isHost) {
        this.compare(f, value, "theirs");
      }
      return;
    }
    if (msg.t === "state" && !this.isHost) {
      this.active = false;
      this.epoch = msg.epoch;
      this.gm.loadState(bytes);
      this.applySide(0, msg.applied[0]);
      this.applySide(1, msg.applied[1]);
      // RetroArch applies a loaded state at the end of the next main loop iteration, after that
      // iteration's frame has run; let that one frame pass before counting (see loaded()).
      this.loading = bytes;
      this.setHold(false);
    } else if (msg.t === "ready" && this.isHost && msg.epoch === this.epoch) {
      this.mask = msg.mask;
      this.restart();
    }
  }

  // Guest: the host's savestate is now in effect. Bytes that still differ from it are ones a load
  // does not restore; both phones leave them out of the hash comparison.
  loaded() {
    const sent = this.loading;
    this.loading = null;
    this.setHold(true);
    const now = this.getState();
    const mask = [];
    for (let i = 0; i < now.length && mask.length <= MAX_MASK; i++) if (now[i] !== sent[i]) mask.push(i);
    this.mask = now.length === sent.length && mask.length <= MAX_MASK ? mask : null;
    this.io.send({ t: "ready", epoch: this.epoch, mask: this.mask });
    this.restart();
  }
}
