// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/opus-5-5/js/tcp-channel.test.mjs
// The PairInbox TCP channel (NETPLAY.md §12.4) against a fake PairInbox: connect rounds, the
// RTCDataChannel look-alike under channelIO end to end, plugin capability detection, the host's
// token check, old-host compatibility and the peer block's tcp flag.
import test from "node:test";
import assert from "node:assert/strict";
import {
  hasChannels, tcpChannel, openChannel, acceptChannel, shouldTryTcp, ensureListeners, isTimeout, CHANNEL_METHODS, LOW_THRESHOLD,
} from "./tcp-channel.js";
import { channelIO } from "../../../../src/lockstep.js";
import { parseInboxLine } from "../../fable/js/pair-net.js";
import { packPeer, unpackPeer, peerToLong, peerFromLong, BACKEND_NATIVE, BACKEND_EJS } from "../../fable/js/peer-block.js";
import { toBase64 } from "../../fable/js/lockstep-native.js";

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await tick();
};
const noTimers = { setInterval: () => 1, clearInterval: () => {} };
const REFUSED = "The operation couldn't be completed. (Network.NWError error 61 - Connection refused)";

// A fake PairInbox. `connectPlan`: one entry per connect() call ({ id } resolves, an Error or a
// string rejects). Two fakes can be wired together (wire()): a send on one arrives as an event on
// the other one task later, and the send resolves then (so bufferedAmount rises and falls).
function fakeInbox({ connectPlan = [] } = {}) {
  const listeners = new Map();
  const p = {
    calls: [],
    connectPlan: [...connectPlan],
    other: null,
    ids: new Map(), // my channel id -> the other fake's id for the same link
    onConnect: null,
    failSend: null,
    names() {
      return p.calls.map((c) => c.method);
    },
    emit(name, data) {
      for (const fn of [...(listeners.get(name) || [])]) fn(data);
    },
    listenerCount(name) {
      return (listeners.get(name) || new Set()).size;
    },
    addListener(name, fn) {
      p.calls.push({ method: "addListener", args: name });
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return Promise.resolve({ remove: () => listeners.get(name).delete(fn) });
    },
    connect(args) {
      p.calls.push({ method: "connect", args });
      const r = p.connectPlan.shift();
      if (r instanceof Error) return Promise.reject(r);
      if (typeof r === "string") return Promise.reject(new Error(r));
      if (p.onConnect) p.onConnect(args, r);
      return Promise.resolve(r);
    },
    deliver(event, id, payload) {
      if (p.failSend) return Promise.reject(new Error(p.failSend));
      if (!p.other) return Promise.resolve();
      return new Promise((resolve) =>
        setImmediate(() => {
          p.other.emit(event, { id: p.ids.get(id), ...payload });
          resolve();
        }),
      );
    },
    channelSend(args) {
      p.calls.push({ method: "channelSend", args });
      return p.deliver("channelText", args.id, { text: args.text });
    },
    channelSendBase64(args) {
      p.calls.push({ method: "channelSendBase64", args });
      return p.deliver("channelBytes", args.id, { data: args.data });
    },
    channelClose(args) {
      p.calls.push({ method: "channelClose", args });
      if (p.other && p.ids.has(args.id)) {
        const theirs = p.ids.get(args.id);
        setImmediate(() => {
          p.emit("channelClose", { id: args.id, reason: "closed" }); // the plugin reports its own close too
          p.other.emit("channelClose", { id: theirs, reason: "eof" });
        });
      }
      return Promise.resolve();
    },
  };
  return p;
}

// Host fake `a` (id ha) and guest fake `b` (id gb) joined by one TCP link.
function wire(a, ha, b, gb) {
  a.other = b;
  b.other = a;
  a.ids.set(ha, gb);
  b.ids.set(gb, ha);
}

const nativePeer = (over = {}) => ({ backend: BACKEND_NATIVE, system: "snes", coreVersion: "642d1d1", appVersion: "1.4.0+96", ...over });
const offerWith = (over = {}) => ({
  type: "offer",
  ufrag: "abcd",
  inbox: { ips: ["172.20.10.1"], port: 40123 },
  peer: nativePeer({ tcp: true }),
  ...over,
});

// ---------- (1) openChannel ----------

test("(1) openChannel: the ranked addresses go to one connect, { id } becomes an open adapter; listeners first", async () => {
  const plugin = fakeInbox({ connectPlan: [{ id: 4 }] });
  const rounds = [];
  const ch = await openChannel({
    plugin,
    hosts: ["169.254.3.3", "100.64.0.9", "172.20.10.1", "172.20.10.1"],
    port: 40123,
    token: "abcd",
    onRound: (n, list) => rounds.push([n, list]),
  });
  assert.ok(ch);
  assert.equal(ch.id, 4);
  assert.equal(ch.readyState, "open");
  assert.equal(ch.binaryType, "arraybuffer");
  const connects = plugin.calls.filter((c) => c.method === "connect");
  assert.equal(connects.length, 1);
  // link-local dropped, duplicate dropped, private before the rest (pair-net.js rankLanIps)
  assert.deepEqual(connects[0].args, { hosts: ["172.20.10.1", "100.64.0.9"], port: 40123, token: "abcd", timeoutMs: 10000 });
  assert.deepEqual(rounds, [[1, ["172.20.10.1", "100.64.0.9"]]]);
  // channelText/channelBytes/channelClose are listened to before the connect, once per plugin
  const names = plugin.names();
  assert.deepEqual(names.slice(0, 4), ["addListener", "addListener", "addListener", "connect"]);
  await ensureListeners(plugin);
  assert.equal(plugin.listenerCount("channelText"), 1);
  assert.equal(plugin.listenerCount("channelBytes"), 1);
  assert.equal(plugin.listenerCount("channelClose"), 1);
});

test("(1b) openChannel: no plugin, no usable address, no port or token → null without a connect", async () => {
  const plugin = fakeInbox({ connectPlan: [{ id: 1 }] });
  assert.equal(await openChannel({ plugin: null, hosts: ["192.168.1.2"], port: 1, token: "t" }), null);
  assert.equal(await openChannel({ plugin, hosts: ["169.254.1.1", "fe80::1"], port: 1, token: "t" }), null);
  assert.equal(await openChannel({ plugin, hosts: ["192.168.1.2"], port: 0, token: "t" }), null);
  assert.equal(await openChannel({ plugin, hosts: ["192.168.1.2"], port: 1, token: "" }), null);
  assert.equal(plugin.calls.filter((c) => c.method === "connect").length, 0);
  const broken = fakeInbox({ connectPlan: [{ id: 1 }] });
  broken.addListener = () => Promise.reject(new Error("UNIMPLEMENTED"));
  assert.equal(await openChannel({ plugin: broken, hosts: ["192.168.1.2"], port: 1, token: "t" }), null);
});

// ---------- (2) adapter under channelIO, end to end ----------

test("(2) adapter ↔ channelIO end to end: JSON both ways, 16 KiB byte chunks arrive intact, bufferedAmount rises and falls", async () => {
  const host = fakeInbox();
  const guest = fakeInbox({ connectPlan: [{ id: 7 }] });
  let hostCh = null;
  const accept = await acceptChannel({ plugin: host, token: () => "abcd", onOpen: (ch) => (hostCh = ch) });
  // The guest's connect makes the host's plugin report channelOpen for the same link.
  guest.onConnect = (args) => {
    wire(host, 3, guest, 7);
    host.emit("channelOpen", { id: 3, token: args.token });
  };
  const guestCh = await openChannel({ plugin: guest, hosts: ["172.20.10.1"], port: 40123, token: "abcd" });
  assert.ok(guestCh && hostCh);
  assert.equal(accept.channel, hostCh);

  const gotByGuest = [];
  const gotByHost = [];
  const hostIo = channelIO(hostCh, (msg, bytes) => gotByHost.push({ msg, bytes }), { native: true, timers: noTimers });
  const guestIo = channelIO(guestCh, (msg, bytes) => gotByGuest.push({ msg, bytes }), { native: true, timers: noTimers });

  let peak = 0;
  let lows = 0;
  hostCh.addEventListener("bufferedamountlow", () => lows++);
  const realSend = host.channelSendBase64;
  host.channelSendBase64 = (args) => {
    peak = Math.max(peak, hostCh.bufferedAmount);
    return realSend(args);
  };

  hostIo.send({ t: "booted" });
  guestIo.send({ t: "ready", epoch: 1 });
  const rom = new Uint8Array(1536 * 1024 + 123); // > 1 MiB: channelIO waits for bufferedamountlow
  for (let i = 0; i < rom.length; i++) rom[i] = (i * 31 + (i >> 9)) & 255;
  await hostIo.sendBytes({ t: "rom", name: "Game", file: "game.sfc", core: "snes" }, rom);
  await settle(20);

  assert.deepEqual(gotByHost.map((g) => g.msg), [{ t: "ready", epoch: 1 }]);
  assert.deepEqual(gotByGuest[0].msg, { t: "booted" });
  const romMsg = gotByGuest[1];
  assert.deepEqual(romMsg.msg, { t: "rom", name: "Game", file: "game.sfc", core: "snes", size: rom.length });
  assert.equal(romMsg.bytes.length, rom.length);
  assert.deepEqual(romMsg.bytes, rom);
  // 16 KiB chunks (channelIO CHUNK) went as base64 frames
  const chunks = host.calls.filter((c) => c.method === "channelSendBase64");
  assert.equal(chunks.length, Math.ceil(rom.length / (16 * 1024)));
  assert.ok(peak >= 1 << 20, `peak ${peak}`);
  assert.ok(lows >= 1, "bufferedamountlow fired");
  assert.equal(hostCh.bufferedAmountLowThreshold, LOW_THRESHOLD);
  assert.equal(hostCh.bufferedAmount, 0);
  assert.equal(guestCh.bufferedAmount, 0);
  hostIo.close();
  guestIo.close();
});

test("(2b) send(Uint8Array view) encodes only the view's bytes; ArrayBuffer and strings work too", async () => {
  const plugin = fakeInbox();
  const ch = tcpChannel(plugin, 11);
  const whole = Uint8Array.from([9, 9, 1, 2, 3, 9]);
  ch.send(whole.subarray(2, 5));
  ch.send(Uint8Array.from([4, 5]).buffer);
  ch.send('{"t":"hb"}');
  const sent = plugin.calls.filter((c) => c.method.startsWith("channelSend"));
  assert.deepEqual(sent.map((c) => c.method), ["channelSendBase64", "channelSendBase64", "channelSend"]);
  assert.equal(sent[0].args.data, toBase64(Uint8Array.from([1, 2, 3])));
  assert.equal(sent[1].args.data, toBase64(Uint8Array.from([4, 5])));
  assert.deepEqual(sent[2].args, { id: 11, text: '{"t":"hb"}' });
  assert.equal(ch.bufferedAmount, 3 + 2 + 10);
  await settle();
  assert.equal(ch.bufferedAmount, 0);
});

test("(2c) incoming bytes are an ArrayBuffer, text a string; events before the adapter wait and keep their order", async () => {
  const plugin = fakeInbox();
  await ensureListeners(plugin);
  plugin.emit("channelText", { id: 21, text: "first" });
  plugin.emit("channelBytes", { id: 21, data: toBase64(Uint8Array.from([7, 8])) });
  const ch = tcpChannel(plugin, 21);
  const got = [];
  ch.onmessage = (m) => got.push(m.data);
  plugin.emit("channelText", { id: 21, text: "live" }); // arrives before the backlog is delivered
  await settle();
  assert.equal(got.length, 3);
  assert.equal(got[0], "first");
  assert.ok(got[1] instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(got[1])], [7, 8]);
  assert.equal(got[2], "live");
  // A close for an id without an adapter drops its data; an adapter made later starts closed.
  plugin.emit("channelText", { id: 22, text: "lost" });
  plugin.emit("channelClose", { id: 22, reason: "eof" });
  const late = tcpChannel(plugin, 22);
  const lateGot = [];
  let closedWith = null;
  late.onmessage = (m) => lateGot.push(m.data);
  late.onclose = (ev) => (closedWith = ev.reason);
  await settle();
  assert.deepEqual(lateGot, []);
  assert.equal(closedWith, "eof");
  assert.equal(late.readyState, "closed");
});

// ---------- (3) capability detection ----------

test("(3) hasChannels: needs a native platform and all four methods in the PairInbox header", () => {
  const methods = (names) => names.map((name) => ({ name, rtype: "promise" }));
  const win = (over = {}) => ({
    Capacitor: {
      isNativePlatform: () => true,
      PluginHeaders: [{ name: "NativePlayer", methods: methods(["start"]) }, { name: "PairInbox", methods: methods(["listen", "close", "send", ...CHANNEL_METHODS]) }],
      ...over,
    },
  });
  assert.equal(hasChannels(win()), true);
  assert.equal(hasChannels(win({ isNativePlatform: () => false })), false);
  assert.equal(hasChannels(win({ isNativePlatform: undefined })), false);
  assert.equal(hasChannels(win({ PluginHeaders: undefined })), false); // no headers at all
  assert.equal(hasChannels(win({ PluginHeaders: [{ name: "NativePlayer", methods: [] }] })), false); // no PairInbox header
  // an older app: PairInbox without the channel methods, or with one missing
  assert.equal(hasChannels(win({ PluginHeaders: [{ name: "PairInbox", methods: methods(["listen", "close", "send"]) }] })), false);
  assert.equal(hasChannels(win({ PluginHeaders: [{ name: "PairInbox", methods: methods(["listen", "connect", "channelSend", "channelClose"]) }] })), false);
  assert.equal(hasChannels(win({ PluginHeaders: "x" })), false);
  assert.equal(hasChannels({}), false); // web without Capacitor
  assert.equal(hasChannels(undefined), false);
});

// ---------- (4) connect rounds ----------

test("(4) connect: two timeouts → null after exactly 2 calls; a refusal → null after 1; success in round 2", async () => {
  const timedOut = fakeInbox({ connectPlan: ["timeout", "timeout", { id: 1 }] });
  assert.equal(await openChannel({ plugin: timedOut, hosts: ["192.168.1.2"], port: 5, token: "t" }), null);
  assert.equal(timedOut.calls.filter((c) => c.method === "connect").length, 2);

  const refused = fakeInbox({ connectPlan: [REFUSED, { id: 1 }] });
  assert.equal(await openChannel({ plugin: refused, hosts: ["192.168.1.2"], port: 5, token: "t" }), null);
  assert.equal(refused.calls.filter((c) => c.method === "connect").length, 1);

  const second = fakeInbox({ connectPlan: ["timeout", { id: 9 }] });
  const rounds = [];
  const ch = await openChannel({ plugin: second, hosts: ["192.168.1.2"], port: 5, token: "t", onRound: (n) => rounds.push(n) });
  assert.equal(ch && ch.id, 9);
  assert.deepEqual(rounds, [1, 2]);
  assert.equal(second.calls.filter((c) => c.method === "connect").length, 2);

  // "no channel" (an older host answered OK) is not a timeout either
  const old = fakeInbox({ connectPlan: ["no channel", { id: 1 }] });
  assert.equal(await openChannel({ plugin: old, hosts: ["192.168.1.2"], port: 5, token: "t" }), null);
  assert.equal(old.calls.filter((c) => c.method === "connect").length, 1);
  assert.equal(isTimeout(new Error("timeout")), true);
  assert.equal(isTimeout(new Error(REFUSED)), false);
});

// ---------- (5) host accepts one channel ----------

test("(5) acceptChannel: only the first channel with the right token; wrong token and a second channel are closed", async () => {
  const plugin = fakeInbox();
  let token = "";
  const opened = [];
  const accept = await acceptChannel({ plugin, token: () => token, onOpen: (ch) => opened.push(ch) });
  plugin.emit("channelOpen", { id: 1, token: "" }); // before the offer exists: "" never matches
  token = "abcd";
  plugin.emit("channelOpen", { id: 2, token: "nope" });
  plugin.emit("channelOpen", { id: 3, token: "abcd" });
  plugin.emit("channelOpen", { id: 4, token: "abcd" });
  await settle();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].id, 3);
  assert.equal(accept.channel, opened[0]);
  const closed = plugin.calls.filter((c) => c.method === "channelClose").map((c) => c.args.id);
  assert.deepEqual(closed, [1, 2, 4]);
  accept.stop();
  assert.equal(plugin.listenerCount("channelOpen"), 0);
  // a plain string token works too
  const p2 = fakeInbox();
  const got = [];
  await acceptChannel({ plugin: p2, token: "xyz", onOpen: (ch) => got.push(ch.id) });
  p2.emit("channelOpen", { id: 8, token: "xyz" });
  assert.deepEqual(got, [8]);
});

// ---------- (6) older hosts ----------

test("(6) old host: an NB-CH1 line is not an inbox answer; an invite without the tcp flag never tries TCP", () => {
  assert.equal(parseInboxLine("NB-CH1 abc"), null);
  assert.deepEqual(parseInboxLine("abcd NB3:AAAA"), { ufrag: "abcd", code: "NB3:AAAA" });
  assert.deepEqual(parseInboxLine("abcd nb3:aaaa"), { ufrag: "abcd", code: "nb3:aaaa" });
  assert.deepEqual(parseInboxLine("abcd NB1:xy_z"), { ufrag: "abcd", code: "NB1:xy_z" });
  assert.equal(parseInboxLine("abcd"), null);
  assert.equal(parseInboxLine(""), null);
  assert.equal(parseInboxLine(undefined), null);

  const me = nativePeer();
  assert.equal(shouldTryTcp({ offer: offerWith(), myPeer: me, supported: true }), true);
  assert.equal(shouldTryTcp({ offer: offerWith({ peer: nativePeer() }), myPeer: me, supported: true }), false); // no flag
  assert.equal(shouldTryTcp({ offer: offerWith({ peer: nativePeer({ tcp: false }) }), myPeer: me, supported: true }), false);
  assert.equal(shouldTryTcp({ offer: offerWith({ peer: null }), myPeer: me, supported: true }), false); // old invite
  assert.equal(shouldTryTcp({ offer: offerWith(), myPeer: me, supported: false }), false); // this app has no channel methods
  assert.equal(shouldTryTcp({ offer: offerWith(), myPeer: { ...me, backend: BACKEND_EJS }, supported: true }), false);
  assert.equal(shouldTryTcp({ offer: offerWith({ peer: nativePeer({ backend: BACKEND_EJS, tcp: true }) }), myPeer: me, supported: true }), false);
  assert.equal(shouldTryTcp({ offer: offerWith({ inbox: null }), myPeer: me, supported: true }), false);
  assert.equal(shouldTryTcp({ offer: offerWith({ inbox: { ips: [], port: 1 } }), myPeer: me, supported: true }), false);
  assert.equal(shouldTryTcp({ offer: offerWith({ ufrag: undefined }), myPeer: me, supported: true }), false); // long (NB1) code
});

// ---------- (7) peer block tcp flag ----------

test("(7) peer block: the tcp flag byte round-trips; an old block without it reads tcp false; long form f", () => {
  const withTcp = Uint8Array.from(packPeer(nativePeer({ tcp: true })));
  const r = unpackPeer(withTcp, 0);
  assert.equal(r.peer.tcp, true);
  assert.equal(r.end, withTcp.length);
  const answer = Uint8Array.from(packPeer(nativePeer())); // the guest's answer: flag 0
  assert.equal(answer[answer.length - 1], 0);
  assert.equal(unpackPeer(answer, 0).peer.tcp, false);
  const oldBlock = answer.slice(0, -1); // what the encoder before §12.2 wrote
  const o = unpackPeer(oldBlock, 0);
  assert.equal(o.peer.tcp, false);
  assert.equal(o.end, oldBlock.length);
  assert.equal(peerToLong(nativePeer({ tcp: true })).f, 1);
  assert.equal(peerToLong(nativePeer()).f, 0);
  assert.equal(peerFromLong(peerToLong(nativePeer({ tcp: true }))).tcp, true);
  assert.equal(peerFromLong({ b: 1, s: "snes", c: "642d1d1", a: "1" }).tcp, false);
});

// ---------- (8) close ----------

test("(8) remote channelClose → close event + onclose; local close() → channelClose call, close event, no onclose", async () => {
  const plugin = fakeInbox();
  await ensureListeners(plugin);
  const remote = tcpChannel(plugin, 30);
  const events = [];
  remote.addEventListener("close", (ev) => events.push(["event", ev.reason]));
  remote.onclose = (ev) => events.push(["onclose", ev.reason]);
  const io = channelIO(remote, () => {}, { native: true, timers: noTimers });
  assert.equal(io.heartbeat.active, true);
  plugin.emit("channelClose", { id: 30, reason: "eof" });
  assert.deepEqual(events, [["event", "eof"], ["onclose", "eof"]]);
  assert.equal(remote.readyState, "closed");
  assert.equal(io.heartbeat.active, false); // channelIO's close listener stopped the heartbeat
  plugin.emit("channelClose", { id: 30, reason: "eof" }); // a repeat changes nothing
  assert.equal(events.length, 2);

  const local = tcpChannel(plugin, 31);
  const localEvents = [];
  local.addEventListener("close", () => localEvents.push("event"));
  local.onclose = () => localEvents.push("onclose");
  local.close();
  local.close(); // idempotent
  assert.deepEqual(localEvents, ["event"]);
  assert.equal(local.readyState, "closed");
  assert.deepEqual(plugin.calls.filter((c) => c.method === "channelClose").map((c) => c.args), [{ id: 31 }]);
  plugin.emit("channelClose", { id: 31, reason: "closed" }); // the plugin's own report of that close
  assert.deepEqual(localEvents, ["event"]);
  local.send("ignored");
  assert.equal(plugin.calls.filter((c) => c.method === "channelSend").length, 0);
});

test("(8b) a send the plugin rejects ends the link like a remote close; { once } listeners fire once", async () => {
  const plugin = fakeInbox();
  const ch = tcpChannel(plugin, 40);
  let closed = null;
  let onceCount = 0;
  ch.addEventListener("close", () => onceCount++, { once: true });
  ch.onclose = (ev) => (closed = ev.reason);
  plugin.failSend = "no channel";
  ch.send("x");
  await settle();
  assert.equal(closed, "no channel");
  assert.equal(ch.readyState, "closed");
  assert.equal(onceCount, 1);
  assert.equal(ch.bufferedAmount, 0);
});

test("(2d) a guest close reaches the host as onclose (eof) through the wired fakes", async () => {
  const host = fakeInbox();
  const guest = fakeInbox({ connectPlan: [{ id: 2 }] });
  let hostCh = null;
  await acceptChannel({ plugin: host, token: "tok", onOpen: (ch) => (hostCh = ch) });
  guest.onConnect = (args) => {
    wire(host, 1, guest, 2);
    host.emit("channelOpen", { id: 1, token: args.token });
  };
  const guestCh = await openChannel({ plugin: guest, hosts: ["192.168.1.9"], port: 9, token: "tok" });
  let hostLeft = null;
  let guestOnclose = 0;
  hostCh.onclose = (ev) => (hostLeft = ev.reason);
  guestCh.onclose = () => guestOnclose++;
  guestCh.close();
  await settle();
  assert.equal(hostLeft, "eof");
  assert.equal(guestOnclose, 0);
});
