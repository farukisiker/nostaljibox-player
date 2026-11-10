// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/opus-5-5/js/link-ad-gate.test.mjs
// The link-start ad gate (NETPLAY.md §13.3) as wired in the real src/host-link.js and
// src/guest-link.js: two fake channels joined to each other, fake NativePlayer plugins
// (fable/js/fake-plugin.mjs), a fake adHook per phone and node:test's mock timers. The modules'
// browser-only imports (shared/link.js: QR, camera, Capacitor; shared/i18n.js; ./ad-hook.js) are
// swapped for small stubs with a module resolve hook; everything else is the real code.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { fakePlugin } from "../../fable/js/fake-plugin.mjs";
import { channelIO } from "../../../../src/lockstep.js";
import { LINK_AD_GATE_MAX_MS } from "./ad-gate.js";

// ---- module stubs for the two link pages ----
const LINK_EXPORTS = [
  "createPeer", "gatheringDone", "encodeDescription", "decodeDescription", "drawQR", "openCamera", "stopCamera", "scanQR",
  "shareInvite", "pasteCode", "findCode", "onInviteLink", "listenForAnswer", "sendAnswer", "iceUfrag", "pairInbox",
];
const stubUrl = (src) => "data:text/javascript," + encodeURIComponent(src);
const LINK_STUB = LINK_EXPORTS.map((n) => `export const ${n} = (...a) => globalThis.__nbLinkTest.link.${n}(...a);`).join("\n");
const I18N_STUB = "export const t = (key) => key;";
const adStub = (side) =>
  `export const adHook = { get supported() { return globalThis.__nbLinkTest.ads.${side}.supported; }, gate: (...a) => globalThis.__nbLinkTest.ads.${side}.gate(...a) };`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL || "";
    const side = /\/src\/host-link\.js$/.test(parent) ? "host" : /\/src\/guest-link\.js$/.test(parent) ? "guest" : null;
    if (side) {
      if (specifier === "../shared/link.js") return { url: stubUrl(LINK_STUB), shortCircuit: true };
      if (specifier === "../shared/i18n.js") return { url: stubUrl(I18N_STUB), shortCircuit: true };
      if (specifier === "./ad-hook.js") return { url: stubUrl(adStub(side)), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// ---- a minimal DOM ----
class El {
  constructor(id) {
    this.id = id;
    this.textContent = "";
    this.onclick = null;
    this.listeners = {};
    const set = new Set();
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !set.has(c) : !!force;
        if (on) set.add(c);
        else set.delete(c);
        return on;
      },
    };
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type, ev) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }
}
const els = new Map();
const el = (sel) => {
  if (!els.has(sel)) els.set(sel, new El(sel));
  return els.get(sel);
};
const winListeners = [];
const win = {
  location: { href: "https://app.test/player/play.html?id=g1", search: "" },
  localStorage: { getItem: () => null },
  Capacitor: { getPlatform: () => "ios", Plugins: {} },
  addEventListener: (type, fn) => winListeners.push({ type, fn }),
  removeEventListener: () => {},
};
globalThis.window = win;
globalThis.location = win.location;
globalThis.document = {
  querySelector: el,
  getElementById: (id) => el(`#${id}`),
  body: new El("body"),
  documentElement: new El("html"),
  addEventListener: () => {},
  removeEventListener: () => {},
};
const fireWindow = (type) => winListeners.filter((l) => l.type === type).forEach((l) => l.fn({}));

// ---- two channel ends joined to each other (RTCDataChannel-like; delivery is asynchronous) ----
function channelEnd(name) {
  let handler = null;
  const queued = [];
  const end = {
    name,
    readyState: "open",
    binaryType: "blob",
    bufferedAmount: 0,
    onclose: null,
    onopen: null,
    listeners: {},
    log: [], // JSON messages this end sent (hb included)
    peer: null,
    get onmessage() {
      return handler;
    },
    set onmessage(fn) {
      handler = fn;
      while (handler && queued.length) handler(queued.shift());
    },
    addEventListener(type, fn) {
      (end.listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      end.listeners[type] = (end.listeners[type] || []).filter((f) => f !== fn);
    },
    fire(type) {
      for (const fn of end.listeners[type] || []) fn();
    },
    send(data) {
      if (end.readyState !== "open") throw new Error("InvalidStateError");
      const copy = typeof data === "string" ? data : new Uint8Array(data).slice().buffer;
      if (typeof data === "string") end.log.push(JSON.parse(data));
      const peer = end.peer;
      queueMicrotask(() => peer.readyState === "open" && peer.deliver({ data: copy }));
    },
    // Messages that come before the page set onmessage wait for it (as a real channel's do).
    deliver(ev) {
      if (handler) handler(ev);
      else queued.push(ev);
    },
    // A local close: the `close` event here (the heartbeat stops), the other end sees the channel go.
    close() {
      if (end.readyState === "closed") return;
      end.readyState = "closed";
      end.fire("close");
      queueMicrotask(() => end.peer.drop());
    },
    drop() {
      if (end.readyState === "closed") return;
      end.readyState = "closed";
      end.fire("close");
      if (end.onclose) end.onclose({});
    },
  };
  return end;
}
function channelPair() {
  const a = channelEnd("host");
  const b = channelEnd("guest");
  a.peer = b;
  b.peer = a;
  return [a, b];
}
const sent = (end) => end.log.filter((m) => m && m.t !== "hb");
const sentTypes = (end) => sent(end).map((m) => (Array.isArray(m) ? m[0] : m.t));

// ---- shared/link.js stand-in ----
function fakePc(link) {
  const pc = {
    connectionState: "new",
    localDescription: null,
    remoteDescription: null,
    ondatachannel: null,
    onconnectionstatechange: null,
    channel: null,
    createDataChannel() {
      pc.channel = link.hostEnd;
      return pc.channel;
    },
    createOffer: async () => ({ type: "offer", sdp: "a=ice-ufrag:ufrag1" }),
    createAnswer: async () => ({ type: "answer", sdp: "a=ice-ufrag:guest1" }),
    setLocalDescription: async (d) => (pc.localDescription = d),
    setRemoteDescription: async (d) => (pc.remoteDescription = d),
    close() {
      pc.connectionState = "closed";
      if (pc.channel) pc.channel.close();
    },
  };
  return pc;
}
const HOST_PEER = { backend: 1, system: "snes", coreVersion: "642d1d1", appVersion: "1.0.0+1", tcp: false };
const link = {
  peers: [],
  scans: new Map(),
  hostEnd: null,
  offer: null,
  createPeer: () => {
    const pc = fakePc(link);
    link.peers.push(pc);
    return pc;
  },
  gatheringDone: async () => {},
  encodeDescription: async () => "NB1:code",
  decodeDescription: async () => link.offer,
  drawQR: async () => {},
  openCamera: async () => ({ stream: true }),
  stopCamera: () => {},
  scanQR: (video, onCode) => {
    link.scans.set(video, onCode);
    return () => link.scans.delete(video);
  },
  shareInvite: async () => null,
  pasteCode: async () => null,
  findCode: () => null,
  onInviteLink: () => {},
  listenForAnswer: async () => null, // no Wi-Fi inbox: no TCP channel, the WebRTC path
  sendAnswer: async () => true,
  iceUfrag: () => "ufrag1",
  pairInbox: () => null,
};

// ---- adHook doubles, one per phone ----
// mode "ad": the ad stays on screen until close(); "cooldown": { shown: false } at once.
function fakeAd({ supported = true, mode = "ad" } = {}) {
  const ad = {
    supported,
    calls: [],
    open: [],
    gate(trigger) {
      ad.calls.push(trigger);
      if (mode === "cooldown") return Promise.resolve({ shown: false, reason: "cooldown" });
      return new Promise((resolve) => ad.open.push(resolve));
    },
    close() {
      ad.open.shift()({ shown: true, reason: "shown" });
    },
  };
  return ad;
}
const ads = { host: fakeAd({ supported: false }), guest: fakeAd({ supported: false }) };
globalThis.__nbLinkTest = { link, ads };

const { setupHostLink, toast } = await import("../../../../src/host-link.js");
const { setupGuestLink } = await import("../../../../src/guest-link.js");

const GAME = { name: "Test Game", file: "test.sfc", core: "snes" };
const ROM = Uint8Array.from({ length: 40000 }, (_, i) => (i * 7) & 255);
setupHostLink(() => ({ game: GAME, rom: ROM }));
const HOST_LISTENERS = winListeners.length; // host-link's pagehide → hangUp

// ---- time ----
let clock = null;
const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};
async function advance(ms) {
  for (let left = ms; left > 0; left -= 1000) {
    clock.tick(Math.min(1000, left));
    await settle(3);
  }
}
function useClock(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  clock = t.mock.timers;
  // Each test's mock timers count ids from 1 again: the toast's timer id from the last test would
  // clear a new timer of the same number (a browser never reuses ids within a page).
  toast._t = undefined;
  win.location.href = "https://app.test/player/play.html?id=g1";
  winListeners.length = HOST_LISTENERS;
  document.body.classList.remove("linked");
  delete win.nbNative;
  t.after(cleanup); // also when an assertion failed: the next test starts from a clean page
}
function cleanup() {
  fireWindow("pagehide");
  winListeners.length = HOST_LISTENERS;
  delete win.nbNative;
}

// ---- the two phones ----
// The host page: a native session runs (window.nbNative), the invite is drawn; `open()` is the
// data channel opening (linkUp: hold, ROM out).
async function hostPage(plugin, end) {
  win.nbNative = { plugin, game: { core: "snes" } };
  link.hostEnd = end;
  el("#p2").fire("click");
  await settle();
  return {
    open() {
      end.onopen();
      delete win.nbNative; // the guest page in this same process must not find the host's session
    },
  };
}

// The guest page with the native player: scans the invite, answers, gets the data channel.
async function guestPage(plugin, end) {
  win.Capacitor.Plugins.NativePlayer = plugin;
  const calls = { boots: 0, stops: 0 };
  setupGuestLink(
    () => {
      throw new Error("no EmulatorJS in this test");
    },
    {
      bootNative: (game, bytes, { onStarted }) => {
        calls.boots += 1;
        calls.game = game;
        calls.size = bytes.length;
        onStarted(plugin);
      },
      stopNative: () => {
        calls.stops += 1;
      },
    },
  );
  await settle();
  link.offer = { type: "offer", sdp: "a=ice-ufrag:ufrag1", peer: HOST_PEER, inbox: null, ufrag: "ufrag1" };
  const before = link.peers.length;
  await link.scans.get(el("#join-cam"))("NB1:code");
  await settle();
  const pc = link.peers[before];
  assert.ok(pc, "the guest answered over WebRTC");
  pc.connectionState = "connected";
  pc.ondatachannel({ channel: end });
  return calls;
}

// A scripted phone on the other end of `end`: the real channelIO (ROM/state chunks, heartbeat).
function scripted(end) {
  const got = [];
  const io = channelIO(end, (msg, bytes) => got.push(bytes ? { ...msg, bytes } : msg), { native: true, onLost: () => got.push({ t: "LOST" }) });
  return { io, got, types: () => got.map((m) => (Array.isArray(m) ? m[0] : m.t)) };
}

const startArgs = (plugin) => plugin.calls.filter((c) => c.method === "lockstepStart").map((c) => c.args);

test("both phones show the ad: adgate goes out, the state only after the guest's addone AND the host's own ad", async (t) => {
  useClock(t);
  ads.host = fakeAd();
  ads.guest = fakeAd();
  const hostPlugin = fakePlugin();
  const guestPlugin = fakePlugin();
  const [a, b] = channelPair();
  const host = await hostPage(hostPlugin, a);
  const guest = await guestPage(guestPlugin, b);
  host.open();
  await settle();
  // ROM over, the guest booted with the ads flag; the host opened the gate.
  assert.equal(guest.boots, 1);
  assert.equal(guest.size, ROM.length);
  assert.deepEqual(sent(b).find((m) => m.t === "booted"), { t: "booted", ads: 1 });
  assert.deepEqual(sent(a).find((m) => m.t === "adgate"), { t: "adgate", id: 1 });
  assert.deepEqual(ads.host.calls, ["link-start"]);
  assert.deepEqual(ads.guest.calls, ["link-start"]);
  assert.equal(hostPlugin.names().includes("getStateBase64"), false);
  assert.equal(hostPlugin.hold, true);
  assert.equal(guestPlugin.hold, true);

  ads.host.close(); // the host's ad is closed first: still waiting for the guest
  await settle();
  assert.deepEqual(sent(a).find((m) => m.t === "addone"), { t: "addone", id: 1, shown: true, reason: "shown" });
  assert.equal(hostPlugin.names().includes("getStateBase64"), false);

  await advance(60000); // the guest's long video ad: nobody gives up
  assert.equal(sentTypes(b).includes("abort"), false);
  assert.equal(sentTypes(a).includes("abort"), false);
  assert.equal(guest.stops, 0);
  assert.equal(hostPlugin.names().includes("getStateBase64"), false);

  ads.guest.close();
  await settle();
  assert.deepEqual(sent(b).find((m) => m.t === "addone"), { t: "addone", id: 1, shown: true, reason: "shown" });
  // Now the state: loaded on the guest, ready, both phones start epoch 1 from the same frame.
  assert.ok(hostPlugin.names().includes("getStateBase64"));
  assert.deepEqual(guestPlugin.loaded, ["AAEC"]);
  assert.deepEqual(startArgs(hostPlugin).map((s) => [s.role, s.epoch]), [[0, 1]]);
  assert.deepEqual(startArgs(guestPlugin).map((s) => [s.role, s.epoch]), [[1, 1]]);
  assert.equal(hostPlugin.hold, false);
  assert.equal(guestPlugin.hold, false);
  // The order on the wire: adgate → host addone … guest addone → state → ready.
  assert.deepEqual(sentTypes(a).filter((x) => x !== "i" && x !== "h"), ["rom", "adgate", "addone", "state"]);
  assert.deepEqual(sentTypes(b).filter((x) => x !== "i" && x !== "h"), ["booted", "addone", "ready"]);
  cleanup();
});

test("the host in its cooldown answers at once; the game starts when the guest's ad closes", async (t) => {
  useClock(t);
  ads.host = fakeAd({ mode: "cooldown" });
  ads.guest = fakeAd();
  const hostPlugin = fakePlugin();
  const guestPlugin = fakePlugin();
  const [a, b] = channelPair();
  const host = await hostPage(hostPlugin, a);
  await guestPage(guestPlugin, b);
  host.open();
  await settle();
  assert.deepEqual(sent(a).find((m) => m.t === "addone"), { t: "addone", id: 1, shown: false, reason: "cooldown" });
  await advance(30000);
  assert.equal(startArgs(guestPlugin).length, 0);
  ads.guest.close();
  await settle();
  assert.deepEqual(startArgs(guestPlugin).map((s) => s.epoch), [1]);
  assert.deepEqual(startArgs(hostPlugin).map((s) => s.epoch), [1]);
  cleanup();
});

test("a guest without the ads flag (older app, or no ad hook): no adgate, the state goes out at once", async (t) => {
  useClock(t);
  ads.host = fakeAd();
  ads.guest = fakeAd({ supported: false });
  const hostPlugin = fakePlugin();
  const guestPlugin = fakePlugin();
  const [a, b] = channelPair();
  const host = await hostPage(hostPlugin, a);
  await guestPage(guestPlugin, b);
  host.open();
  await settle();
  assert.deepEqual(sent(b).find((m) => m.t === "booted"), { t: "booted" });
  assert.equal(sentTypes(a).includes("adgate"), false);
  assert.deepEqual(ads.host.calls, []);
  assert.deepEqual(ads.guest.calls, []);
  assert.deepEqual(startArgs(hostPlugin).map((s) => s.epoch), [1]);
  assert.deepEqual(startArgs(guestPlugin).map((s) => s.epoch), [1]);
  cleanup();
});

test("a host without an ad hook (the player on its own): the guest's flag is ignored, no gate on either phone", async (t) => {
  useClock(t);
  ads.host = fakeAd({ supported: false });
  ads.guest = fakeAd();
  const hostPlugin = fakePlugin();
  const guestPlugin = fakePlugin();
  const [a, b] = channelPair();
  const host = await hostPage(hostPlugin, a);
  await guestPage(guestPlugin, b);
  host.open();
  await settle();
  assert.deepEqual(sent(b).find((m) => m.t === "booted"), { t: "booted", ads: 1 });
  assert.equal(sentTypes(a).includes("adgate"), false);
  assert.deepEqual(ads.guest.calls, []);
  assert.deepEqual(startArgs(guestPlugin).map((s) => s.epoch), [1]);
  cleanup();
});

test("host: no gate once a resync happened (resyncs > 0), even for a booted with the flag", async (t) => {
  useClock(t);
  ads.host = fakeAd();
  const hostPlugin = fakePlugin();
  const [a, b] = channelPair();
  const host = await hostPage(hostPlugin, a);
  const g = scripted(b);
  host.open();
  await settle();
  assert.equal(g.types()[0], "rom");
  g.io.send({ t: "booted" }); // first boot without the flag: no gate
  await settle();
  assert.deepEqual(g.types().slice(1), ["state"]);
  g.io.send({ t: "ready", epoch: 1 });
  await settle();
  assert.deepEqual(startArgs(hostPlugin).map((s) => s.epoch), [1]);
  // A checksum mismatch: the host resends the state (N1-b), resyncs = 1.
  hostPlugin.emit("lockstepChecksum", { epoch: 1, frame: 300, hash: "aa" });
  g.io.send(["h", 1, 300, "bb"]);
  await settle();
  assert.deepEqual(g.types().slice(1), ["state", "state"]);
  g.io.send({ t: "ready", epoch: 2 });
  await settle();
  g.io.send({ t: "booted", ads: 1 });
  await settle();
  assert.equal(sentTypes(a).includes("adgate"), false);
  assert.deepEqual(ads.host.calls, []);
  cleanup();
});

test("guest: 60 s after adgate it has not given up; once the gate is done it waits 30 s for the state", async (t) => {
  useClock(t);
  ads.guest = fakeAd();
  const guestPlugin = fakePlugin();
  const [a, b] = channelPair();
  const calls = await guestPage(guestPlugin, b);
  const h = scripted(a);
  await h.io.sendBytes({ t: "rom", ...GAME }, ROM);
  await settle();
  assert.equal(calls.boots, 1);
  assert.deepEqual(h.got, [{ t: "booted", ads: 1 }]);
  h.io.send({ t: "adgate", id: 1 });
  await settle();
  assert.deepEqual(ads.guest.calls, ["link-start"]);
  await advance(60000);
  assert.deepEqual(h.types(), ["booted"]); // no abort, no timeout
  assert.equal(calls.stops, 0);
  ads.guest.close();
  await settle();
  assert.deepEqual(h.got[1], { t: "addone", id: 1, shown: true, reason: "shown" });
  await advance(10000); // the host's addone has not come: the gate is still open (cap at 75 s)
  assert.deepEqual(h.types(), ["booted", "addone"]);
  h.io.send({ t: "addone", id: 1, shown: false, reason: "cooldown" });
  await settle();
  await advance(29000);
  assert.deepEqual(h.types(), ["booted", "addone"]);
  await advance(2000); // 30 s after the gate closed, still no state
  assert.deepEqual(h.got[2], { t: "abort", reason: "timeout" });
  assert.equal(calls.stops, 1);
  await advance(3000);
  assert.equal(win.location.href, "../index.html"); // the game never ran: no ?from=game
  cleanup();
});

test("guest without an adgate (older host): the 30 s state timeout as before", async (t) => {
  useClock(t);
  ads.guest = fakeAd();
  const late = fakePlugin();
  const [a, b] = channelPair();
  const calls = await guestPage(late, b);
  const h = scripted(a);
  await h.io.sendBytes({ t: "rom", ...GAME }, ROM);
  await settle();
  await advance(31000);
  assert.deepEqual(h.types(), ["booted", "abort"]);
  assert.equal(calls.stops, 1);
  cleanup();
});

test("guest without an adgate (older host): the state is taken at once, no ad", async (t) => {
  useClock(t);
  ads.guest = fakeAd();
  const plugin = fakePlugin();
  const [c, d] = channelPair();
  await guestPage(plugin, d);
  const h2 = scripted(c);
  await h2.io.sendBytes({ t: "rom", ...GAME }, ROM);
  await settle();
  await h2.io.sendBytes({ t: "state", epoch: 1 }, Uint8Array.from([0, 1, 2]));
  await settle();
  assert.deepEqual(h2.types(), ["booted", "ready"]);
  assert.deepEqual(startArgs(plugin).map((s) => s.epoch), [1]);
  assert.deepEqual(ads.guest.calls, []);
  cleanup();
});

test("guest: a state that comes while its ad is still open (the host's cap) waits and is taken when the gate closes", async (t) => {
  useClock(t);
  ads.guest = fakeAd();
  const plugin = fakePlugin();
  const [a, b] = channelPair();
  await guestPage(plugin, b);
  const h = scripted(a);
  await h.io.sendBytes({ t: "rom", ...GAME }, ROM);
  await settle();
  h.io.send({ t: "adgate", id: 1 });
  h.io.send({ t: "addone", id: 1, shown: false, reason: "cooldown" });
  await settle();
  await advance(LINK_AD_GATE_MAX_MS - 5000);
  await h.io.sendBytes({ t: "state", epoch: 1 }, Uint8Array.from([0, 1, 2])); // the host gave up waiting
  await settle();
  assert.deepEqual(plugin.loaded, []);
  assert.deepEqual(h.types(), ["booted"]);
  ads.guest.close();
  await settle();
  assert.deepEqual(h.types(), ["booted", "addone", "ready"]);
  assert.deepEqual(plugin.loaded, ["AAEC"]);
  assert.deepEqual(startArgs(plugin).map((s) => s.epoch), [1]);
  // The game runs: a later adgate is ignored.
  h.io.send({ t: "adgate", id: 2 });
  await settle();
  assert.deepEqual(ads.guest.calls, ["link-start"]);
  cleanup();
});

test("guest: the gate's cap also takes a waiting state when the guest's own ad never reports back", async (t) => {
  useClock(t);
  ads.guest = fakeAd();
  const plugin = fakePlugin();
  const [a, b] = channelPair();
  await guestPage(plugin, b);
  const h = scripted(a);
  await h.io.sendBytes({ t: "rom", ...GAME }, ROM);
  await settle();
  h.io.send({ t: "adgate", id: 1 });
  h.io.send({ t: "addone", id: 1, shown: false, reason: "cooldown" });
  await settle();
  await h.io.sendBytes({ t: "state", epoch: 1 }, Uint8Array.from([0, 1, 2]));
  await advance(LINK_AD_GATE_MAX_MS);
  assert.deepEqual(h.types(), ["booted", "ready"]);
  assert.deepEqual(startArgs(plugin).map((s) => s.epoch), [1]);
  cleanup();
});

test("guest: the link drops during its ad → the native game stops now, the library only after the ad closes", async (t) => {
  useClock(t);
  ads.guest = fakeAd();
  const plugin = fakePlugin();
  const [a, b] = channelPair();
  const calls = await guestPage(plugin, b);
  const h = scripted(a);
  await h.io.sendBytes({ t: "rom", ...GAME }, ROM);
  await settle();
  h.io.send({ t: "adgate", id: 1 });
  await settle();
  a.close(); // the host is gone
  await settle();
  assert.equal(calls.stops, 1);
  assert.ok(plugin.names().includes("lockstepStop"));
  await advance(10000);
  assert.equal(win.location.href, "https://app.test/player/play.html?id=g1"); // the ad is still on screen
  ads.guest.close();
  await settle();
  await advance(3000);
  assert.equal(win.location.href, "../index.html"); // no game was played: no ?from=game
  cleanup();
});

test("host: the guest leaves during the gate → single player again, the ad's late result goes nowhere", async (t) => {
  useClock(t);
  ads.host = fakeAd();
  const hostPlugin = fakePlugin();
  const [a, b] = channelPair();
  const host = await hostPage(hostPlugin, a);
  const g = scripted(b);
  host.open();
  await settle();
  g.io.send({ t: "booted", ads: 1 });
  await settle();
  assert.deepEqual(g.types(), ["rom", "adgate"]);
  b.close();
  await settle();
  assert.equal(document.body.classList.contains("linked"), false);
  assert.equal(hostPlugin.hold, false); // lockstepStop cleared the hold
  ads.host.close();
  await settle();
  await advance(LINK_AD_GATE_MAX_MS);
  assert.equal(sentTypes(a).includes("addone"), false);
  assert.equal(hostPlugin.names().includes("getStateBase64"), false);
  cleanup();
});

test("host: the heartbeat allows 85 s of silence while the gate is open, 30 s again after it", async (t) => {
  useClock(t);
  ads.host = fakeAd();
  const hostPlugin = fakePlugin();
  const [a, b] = channelPair();
  const host = await hostPage(hostPlugin, a);
  const g = scripted(b);
  host.open();
  await advance(2000); // a few heartbeats each way: the host knows this guest beats
  g.io.send({ t: "booted", ads: 1 });
  await settle();
  assert.deepEqual(g.types().filter((x) => x !== "hb"), ["rom", "adgate"]);
  g.io.heartbeat.close(); // the guest goes silent (its phone froze during the ad)
  ads.host.close();
  await settle();
  await advance(60000); // 60 s > the usual 30 s pre-arm limit: still linked
  assert.equal(document.body.classList.contains("linked"), true);
  await advance(LINK_AD_GATE_MAX_MS - 60000 + 3000); // the gate's cap: limit back to 30 s, silence already longer
  assert.equal(document.body.classList.contains("linked"), false);
  cleanup();
});

test("guest: the heartbeat allows the host's silence during the gate (60 s), not after it", async (t) => {
  useClock(t);
  ads.guest = fakeAd();
  const plugin = fakePlugin();
  const [a, b] = channelPair();
  const calls = await guestPage(plugin, b);
  const h = scripted(a);
  await h.io.sendBytes({ t: "rom", ...GAME }, ROM);
  await advance(2000);
  h.io.send({ t: "adgate", id: 1 });
  await settle();
  h.io.heartbeat.close(); // the host goes silent
  await advance(60000);
  assert.equal(calls.stops, 0);
  await advance(LINK_AD_GATE_MAX_MS - 60000 + 3000); // cap → 30 s limit → lost
  assert.equal(calls.stops, 1);
  cleanup();
});
