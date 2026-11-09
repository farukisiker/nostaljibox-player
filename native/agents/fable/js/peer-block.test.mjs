// SPDX-License-Identifier: MIT
// Run with: node --test native/agents/fable/js/
import test from "node:test";
import assert from "node:assert/strict";
import {
  packPeer, unpackPeer, peerToLong, peerFromLong, pairingProblem, describePeer, guestBackend, localPeer,
  systemCode, systemName, BACKEND_EJS, BACKEND_NATIVE, PEER_TAG, PEER_VERSION,
} from "./peer-block.js";
import { fakePlugin } from "./fake-plugin.mjs";

const native = (over = {}) => ({ backend: BACKEND_NATIVE, system: "snes", coreVersion: "642d1d1", appVersion: "1.4.0+96", ...over });
const ejs = (over = {}) => ({ backend: BACKEND_EJS, system: "snes", coreVersion: "", appVersion: "", ...over });
// What the decoders return for a block: the same fields plus the tcp flag (NETPLAY.md §12.2).
const decoded = (p) => ({ ...p, tcp: !!p.tcp });

// The tail of a compact code as today's encoder writes it after the candidates: the inbox block.
const inboxBlock = (ips, port) => [ips.length, ...ips.flatMap((ip) => ip.split(".").map(Number)), port >> 8, port & 255];

// What the decoder shipped before this change does with the bytes after the candidates
// (shared/link.js unpackFields, old version): reads one inbox block and stops.
function oldDecoderTail(bytes, i) {
  let inbox = null;
  if (i < bytes.length) {
    const ips = [];
    for (let n = bytes[i++]; n > 0; n--, i += 4) ips.push([...bytes.subarray(i, i + 4)].join("."));
    inbox = { ips, port: (bytes[i] << 8) | bytes[i + 1] };
    i += 2;
  }
  if (i > bytes.length) throw new Error("bad code");
  return inbox;
}

// What the new decoder does with the same bytes (mirrors shared/link.js unpackFields).
function newDecoderTail(bytes, i) {
  let inbox = null;
  let peer = null;
  if (i < bytes.length) {
    const ips = [];
    for (let n = bytes[i++]; n > 0; n--, i += 4) ips.push([...bytes.subarray(i, i + 4)].join("."));
    if (ips.length) inbox = { ips, port: (bytes[i] << 8) | bytes[i + 1] };
    i += 2;
    const tail = i < bytes.length ? unpackPeer(bytes, i) : null;
    if (tail) {
      peer = tail.peer;
      i = tail.end;
    }
  }
  if (i > bytes.length) throw new Error("bad code");
  return { inbox, peer };
}

test("tag byte is 0x50 + version (0x51 for v1); block is backend, system, 7-byte core, app, flags", () => {
  const b = packPeer(native());
  assert.equal(b[0], 0x51);
  assert.equal(PEER_TAG + PEER_VERSION, 0x51);
  assert.equal(b[1], 1);
  assert.equal(b[2], systemCode("snes"));
  assert.equal(String.fromCharCode(...b.slice(3, 10)), "642d1d1");
  assert.equal(b[10], "1.4.0+96".length);
  assert.equal(b.length, 12 + "1.4.0+96".length); // + 1 flags byte (§12.2), always written
  assert.equal(b[b.length - 1], 0);
  const withTcp = packPeer(native({ tcp: true }));
  assert.equal(withTcp[withTcp.length - 1], 1);
});

test("pack/unpack round-trip, short and long core versions, unknown system", () => {
  for (const p of [native(), ejs(), native({ coreVersion: "abc", appVersion: "" }), native({ system: "weird" }), native({ coreVersion: "0123456789" })]) {
    const bytes = Uint8Array.from([7, 7, ...packPeer(p)]);
    const r = unpackPeer(bytes, 2);
    assert.ok(r, JSON.stringify(p));
    assert.equal(r.end, bytes.length);
    assert.equal(r.peer.backend, p.backend);
    assert.equal(r.peer.system, systemName(systemCode(p.system)));
    assert.equal(r.peer.coreVersion, p.coreVersion.slice(0, 7));
    assert.equal(r.peer.appVersion, p.appVersion);
  }
  assert.equal(systemName(systemCode("weird")), "");
  assert.equal(systemName(0), "");
});

test("unpackPeer: wrong tag or truncated block → null", () => {
  assert.equal(unpackPeer(Uint8Array.from([0x52, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0]), 0), null);
  const b = packPeer(native());
  assert.equal(unpackPeer(Uint8Array.from(b.slice(0, 10)), 0), null); // no appLen byte
  assert.equal(unpackPeer(Uint8Array.from(b.slice(0, -2)), 0), null); // app string cut
  // Without the flags byte it is a block from the encoder before §12.2: valid, tcp false.
  const old = unpackPeer(Uint8Array.from(b.slice(0, -1)), 0);
  assert.equal(old.end, b.length - 1);
  assert.equal(old.peer.tcp, false);
  assert.equal(unpackPeer(Uint8Array.from([]), 0), null);
});

test("an invite without an inbox still carries the inbox block (0 IPs, port 0) before the peer block", () => {
  const tail = Uint8Array.from([...inboxBlock([], 0), ...packPeer(native())]);
  assert.deepEqual([...tail.slice(0, 3)], [0, 0, 0]);
  const r = newDecoderTail(tail, 0);
  assert.equal(r.inbox, null); // no addresses: the guest falls back to the QR answer
  assert.deepEqual(r.peer, decoded(native()));
});

test("inbox with addresses followed by the peer block decodes both", () => {
  const tail = Uint8Array.from([...inboxBlock(["192.168.1.5", "10.0.0.2"], 40123), ...packPeer(native())]);
  const r = newDecoderTail(tail, 0);
  assert.deepEqual(r.inbox, { ips: ["192.168.1.5", "10.0.0.2"], port: 40123 });
  assert.deepEqual(r.peer, decoded(native()));
});

test("old decoder compatibility: it reads the inbox and ignores the peer block without error", () => {
  const withIps = Uint8Array.from([...inboxBlock(["192.168.1.5"], 40123), ...packPeer(native())]);
  assert.deepEqual(oldDecoderTail(withIps, 0), { ips: ["192.168.1.5"], port: 40123 });
  const noIps = Uint8Array.from([...inboxBlock([], 0), ...packPeer(native())]);
  assert.deepEqual(oldDecoderTail(noIps, 0), { ips: [], port: 0 });
});

test("old invite (no block at all, or inbox only) → peer null = old EJS phone", () => {
  assert.deepEqual(newDecoderTail(Uint8Array.from([]), 0), { inbox: null, peer: null });
  const r = newDecoderTail(Uint8Array.from(inboxBlock(["192.168.1.5"], 1)), 0);
  assert.equal(r.peer, null);
  assert.deepEqual(r.inbox, { ips: ["192.168.1.5"], port: 1 });
});

test("long form p: { b, s, c, a, f } round-trips; missing p → null", () => {
  assert.deepEqual(peerToLong(native()), { b: 1, s: "snes", c: "642d1d1", a: "1.4.0+96", f: 0 });
  assert.deepEqual(peerFromLong(peerToLong(native())), decoded(native()));
  assert.deepEqual(peerFromLong(peerToLong(ejs())), decoded(ejs()));
  assert.deepEqual(peerFromLong({ b: 1, s: "snes", c: "642d1d1", a: "1.4.0+96" }), decoded(native())); // before §12.2: no f
  assert.equal(peerFromLong(undefined), null);
  assert.equal(peerFromLong("x"), null);
});

test("pairing decision: same native version pairs, anything else is refused; EJS–EJS always pairs", () => {
  assert.equal(pairingProblem(native(), native()), null);
  assert.equal(pairingProblem(native(), native({ appVersion: "1.4.0+97" })), "mismatch");
  assert.equal(pairingProblem(native(), native({ coreVersion: "deadbee" })), "mismatch");
  assert.equal(pairingProblem(native(), ejs()), "mismatch");
  assert.equal(pairingProblem(ejs(), native()), "mismatch");
  assert.equal(pairingProblem(ejs(), ejs()), null);
  assert.equal(pairingProblem(ejs({ appVersion: "9" }), ejs()), null); // Android–Android as today
  // Old peer without a block: fine for an EJS phone, "legacy" for a native host (the host shows the message).
  assert.equal(pairingProblem(ejs(), null), null);
  assert.equal(pairingProblem(null, null), null);
  assert.equal(pairingProblem(native(), null), "legacy");
});

test("describePeer texts", () => {
  assert.equal(describePeer(native()), "iPhone 1.4.0+96 (642d1d1)");
  assert.equal(describePeer(ejs(), { ejs: "klasik oynatıcı" }), "klasik oynatıcı");
  assert.equal(describePeer(null, { old: "eski sürüm" }), "eski sürüm");
});

test("localPeer: native with the plugin's version and appVersion, EJS without a plugin", async () => {
  const plugin = fakePlugin({ version: "642d1d1", appVersion: "1.4.0+96" });
  assert.deepEqual(await localPeer({ plugin, system: "snes" }), native());
  assert.deepEqual(await localPeer({ plugin: null, system: "snes" }), ejs());
  const broken = { isAvailable: () => Promise.reject(new Error("x")) };
  assert.deepEqual(await localPeer({ plugin: broken, system: "snes" }), native({ coreVersion: "", appVersion: "" }));
});

function iosWindow({ flag = "auto", search = "?join", plugin = fakePlugin({ appVersion: "1.4.0+96" }) } = {}) {
  return {
    Capacitor: { getPlatform: () => "ios", Plugins: { NativePlayer: plugin } },
    localStorage: { getItem: (k) => (k === "nb_native" ? flag : null) },
    location: { search },
  };
}

test("guestBackend gates: native only on iOS with the plugin, nb_native not off, no ?ejs, isAvailable true, and a way to boot", async () => {
  const invite = native();
  const asNative = await guestBackend(invite, { canBootNative: true, win: iosWindow() });
  assert.deepEqual(asNative, native());
  const asked = fakePlugin();
  const win = iosWindow({ plugin: asked });
  asked.isAvailable = (a) => ((asked.askedFor = a), Promise.resolve({ available: true, version: "642d1d1", appVersion: "1.4.0+96" }));
  await guestBackend(invite, { canBootNative: true, win });
  assert.deepEqual(asked.askedFor, { system: "snes" }); // the system comes from the invite

  const ejsResults = await Promise.all([
    guestBackend(invite, { canBootNative: false, win: iosWindow() }),
    guestBackend(invite, { canBootNative: true, win: { ...iosWindow(), Capacitor: { getPlatform: () => "android", Plugins: {} } } }),
    guestBackend(invite, { canBootNative: true, win: iosWindow({ flag: "off" }) }),
    guestBackend(invite, { canBootNative: true, win: iosWindow({ search: "?join&ejs=1" }) }),
    guestBackend(invite, { canBootNative: true, win: iosWindow({ plugin: fakePlugin({ available: false }) }) }),
    guestBackend(invite, { canBootNative: true, win: { Capacitor: { getPlatform: () => "ios", Plugins: {} }, location: { search: "" } } }),
    guestBackend(invite, { canBootNative: true, win: undefined }),
    guestBackend(invite, { canBootNative: true, win: iosWindow({ plugin: { isAvailable: () => Promise.reject(new Error("boom")) } }) }),
  ]);
  for (const r of ejsResults) assert.deepEqual(r, ejs());
  // A guest on the web (no Capacitor) pairing with an old host: still EJS, no block needed.
  assert.deepEqual(await guestBackend(null, { canBootNative: true, win: { location: { search: "" } } }), ejs({ system: "" }));
});

test("guestBackend follows the host: an EJS or old host gets an EJS guest even on a native-capable iPhone (iPhone + Android host works as today)", async () => {
  const asked = fakePlugin();
  asked.isAvailable = () => ((asked.asked = true), Promise.resolve({ available: true, version: "642d1d1", appVersion: "1.4.0+96" }));
  const win = iosWindow({ plugin: asked });
  assert.deepEqual(await guestBackend(ejs(), { canBootNative: true, win }), ejs());
  assert.deepEqual(await guestBackend(null, { canBootNative: true, win }), ejs({ system: "" }));
  assert.equal(asked.asked, undefined); // the plugin is not even consulted
  assert.equal(pairingProblem(ejs(), ejs()), null);
  assert.equal(pairingProblem(ejs({ system: "" }), null), null);
  // Only a native host is answered natively, and refused when this phone cannot play natively.
  assert.deepEqual(await guestBackend(native(), { canBootNative: true, win }), native());
  assert.equal(pairingProblem(await guestBackend(native(), { canBootNative: false, win }), native()), "mismatch");
});
