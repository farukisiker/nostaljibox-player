// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/fable/js/
// Pairing over a Personal Hotspot: inbox address order (link-local dropped, private first), ICE
// candidate order (the other phone's subnet first), the parallel inbox send with its retry round
// behind the Local Network prompt, and the host's scan button / camera visibility.
import test from "node:test";
import assert from "node:assert/strict";
import { OVERLAY_IDS } from "../../sonnet-5-5/js/native-mode.js";
import {
  isIPv4, isPrivateIPv4, isLinkLocal, sameLan, addressRank, rankLanIps, rankCandidates, sendToInbox, hostReplyView,
} from "./pair-net.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("address classes: private, link-local, same /24", () => {
  assert.equal(isIPv4("172.20.10.1"), true);
  assert.equal(isIPv4("fe80::1"), false);
  assert.equal(isIPv4("3f1c2a4b-1234-5678-9abc-def012345678.local"), false);
  for (const ip of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.20", "172.20.10.1"]) assert.equal(isPrivateIPv4(ip), true, ip);
  for (const ip of ["172.15.0.1", "172.32.0.1", "100.64.3.9", "8.8.8.8", "169.254.10.3"]) assert.equal(isPrivateIPv4(ip), false, ip);
  assert.equal(isLinkLocal("169.254.10.3"), true);
  assert.equal(isLinkLocal("169.253.10.3"), false);
  assert.equal(sameLan("172.20.10.1", ["172.20.10.7"]), true);
  assert.equal(sameLan("172.20.11.1", ["172.20.10.7"]), false);
  assert.equal(sameLan("172.20.10.1", []), false);
  assert.equal(sameLan("x.local", ["172.20.10.7"]), false);
  assert.equal(addressRank("172.20.10.1", ["172.20.10.7"]), 0);
  assert.equal(addressRank("10.33.0.2", ["172.20.10.7"]), 1);
  assert.equal(addressRank("100.64.3.9"), 2);
  assert.equal(addressRank("abcdefab-1234-5678-9abc-def012345678.local"), 3);
  assert.equal(addressRank("169.254.10.3", ["169.254.10.7"]), 4); // never the other phone, even "in the same /24"
});

test("rankLanIps: the hotspot owner as host offers bridge100 first, link-local never, duplicates once", () => {
  // host = hotspot owner: en0 (no IPv4 or 169.254) ranks before bridge100 in PairInbox.lanAddresses
  assert.deepEqual(rankLanIps(["169.254.33.2", "172.20.10.1"]), ["172.20.10.1"]);
  // host = hotspot client: en0 first already; a USB/en2 link-local address goes away
  assert.deepEqual(rankLanIps(["172.20.10.5", "169.254.1.2"]), ["172.20.10.5"]);
  // same Wi-Fi with a public or CGNAT address on another en*: private first, order kept otherwise
  assert.deepEqual(rankLanIps(["100.64.3.9", "192.168.1.20", "10.0.0.5"]), ["192.168.1.20", "10.0.0.5", "100.64.3.9"]);
  assert.deepEqual(rankLanIps(["192.168.1.20", "192.168.1.20", " 192.168.1.21 ", "fe80::1", "", null, "x"]), ["192.168.1.20", "192.168.1.21"]);
  assert.deepEqual(rankLanIps(["169.254.1.2"]), []);
  assert.deepEqual(rankLanIps(null), []);
});

test("rankCandidates: the other phone's subnet first, then private, cellular/public, mDNS, link-local last; nothing dropped", () => {
  const cands = [
    ["10.133.7.2", 50001], // pdp_ip0 (cellular, private range)
    ["169.254.9.9", 50002], // en2 link-local
    ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.local", 50003],
    ["100.64.3.9", 50004], // CGNAT
    ["172.20.10.1", 50005], // bridge100
    ["192.168.1.20", 50006],
  ];
  // the guest ranks against the host's inbox address (172.20.10.x)
  assert.deepEqual(
    rankCandidates(cands, ["172.20.10.7"]).map(([h]) => h),
    ["172.20.10.1", "10.133.7.2", "192.168.1.20", "100.64.3.9", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.local", "169.254.9.9"],
  );
  // the host ranks against its own LAN addresses
  assert.deepEqual(rankCandidates(cands, ["192.168.1.20"]).map(([h]) => h).slice(0, 2), ["192.168.1.20", "10.133.7.2"]);
  // without a reference the private ones simply keep their order
  assert.deepEqual(rankCandidates(cands).map(([h]) => h).slice(0, 3), ["10.133.7.2", "172.20.10.1", "192.168.1.20"]);
  // the first four of a hotspot owner's list (what the compact code keeps) include bridge100 even behind utun/cellular/USB
  const owner = [["10.133.7.2", 1], ["169.254.9.9", 2], ["10.8.0.2", 3], ["100.64.3.9", 4], ["172.20.10.1", 5]];
  assert.ok(rankCandidates(owner, ["172.20.10.3"]).slice(0, 4).some(([h]) => h === "172.20.10.1"));
  assert.deepEqual(rankCandidates([], ["1.2.3.4"]), []);
  assert.deepEqual(rankCandidates(null), []);
});

// A fake PairInbox.send: `plan[host]` is "ok", "timeout", "refused" (or a list, one per round).
function fakeSend(plan, log = []) {
  const rounds = {};
  return (host) => {
    const n = (rounds[host] = (rounds[host] || 0) + 1);
    const what = Array.isArray(plan[host]) ? plan[host][Math.min(n, plan[host].length) - 1] : plan[host];
    log.push(`${host}#${n}:${what}`);
    if (what === "ok") return Promise.resolve();
    if (what === "throw") throw new Error("bad arguments");
    return Promise.reject(new Error(what === "timeout" ? "timeout" : "Connection refused"));
  };
}

test("sendToInbox: every address at once, the first OK wins, the rest is ignored", async () => {
  const log = [];
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const send = (host) => {
    order.push(host);
    if (host === "172.20.10.1") return gate.then(() => {}); // slow but OK
    return Promise.reject(new Error("Connection refused"));
  };
  const p = sendToInbox({ ips: ["169.254.3.3", "10.0.0.9", "172.20.10.1"], send, onRound: (r, list) => log.push([r, list]) });
  await tick();
  assert.deepEqual(order, ["10.0.0.9", "172.20.10.1"]); // link-local dropped; both started before any result
  release();
  assert.equal(await p, true);
  assert.deepEqual(log, [[1, ["10.0.0.9", "172.20.10.1"]]]); // one round
});

test("sendToInbox: all refused → false after one round; no addresses or no sender → false", async () => {
  const log = [];
  assert.equal(await sendToInbox({ ips: ["172.20.10.1", "10.0.0.9"], send: fakeSend({ "172.20.10.1": "refused", "10.0.0.9": "refused" }, log) }), false);
  assert.deepEqual(log, ["172.20.10.1#1:refused", "10.0.0.9#1:refused"]);
  assert.equal(await sendToInbox({ ips: [], send: fakeSend({}) }), false);
  assert.equal(await sendToInbox({ ips: ["169.254.1.1"], send: fakeSend({}) }), false);
  assert.equal(await sendToInbox({ ips: ["172.20.10.1"], send: null }), false);
  assert.equal(await sendToInbox({ ips: ["172.20.10.1"] }), false);
  // a sender that throws synchronously counts as a failure, not a crash
  assert.equal(await sendToInbox({ ips: ["172.20.10.1"], send: fakeSend({ "172.20.10.1": "throw" }) }), false);
});

test("sendToInbox: a round where everything timed out (Local Network prompt) is tried once more", async () => {
  const log = [];
  // the prompt was answered after the first 10 s: the second round gets through
  const send = fakeSend({ "172.20.10.1": ["timeout", "ok"], "10.0.0.9": ["timeout", "refused"] }, log);
  assert.equal(await sendToInbox({ ips: ["172.20.10.1", "10.0.0.9"], send }), true);
  assert.deepEqual(log, ["172.20.10.1#1:timeout", "10.0.0.9#1:timeout", "172.20.10.1#2:ok", "10.0.0.9#2:refused"]);
  // still nothing: two rounds, then false (about 20 s on the phone, then the QR)
  const log2 = [];
  assert.equal(await sendToInbox({ ips: ["172.20.10.1"], send: fakeSend({ "172.20.10.1": "timeout" }, log2) }), false);
  assert.deepEqual(log2, ["172.20.10.1#1:timeout", "172.20.10.1#2:timeout"]);
  // a mix of timeout and refusal means the host is reachable and said no: one round only
  const log3 = [];
  assert.equal(await sendToInbox({ ips: ["172.20.10.1", "10.0.0.9"], send: fakeSend({ "172.20.10.1": "timeout", "10.0.0.9": "refused" }, log3) }), false);
  assert.equal(log3.length, 2);
  // rounds is adjustable
  const log4 = [];
  assert.equal(await sendToInbox({ ips: ["172.20.10.1"], send: fakeSend({ "172.20.10.1": "timeout" }, log4), rounds: 3 }), false);
  assert.equal(log4.length, 3);
  // Capacitor rejects with { message } objects and plain strings too
  const odd = (host) => Promise.reject(host === "a" ? { message: "timeout" } : "timeout");
  assert.equal(await sendToInbox({ ips: ["172.20.10.1", "172.20.10.2"], send: odd, rounds: 2 }), false);
});

test("hostReplyView: the scan button only while a reply can still come by camera", () => {
  // inbox + camera, waiting: button yes, camera hidden
  assert.deepEqual(hostReplyView({ inbox: true, camera: true, scanning: false, answered: false }), { scanButton: true, camera: false });
  // tapped "scan": button gone, camera shown
  assert.deepEqual(hostReplyView({ inbox: true, camera: true, scanning: true, answered: false }), { scanButton: false, camera: true });
  // the reply arrived over the Wi-Fi (the user's hotspot run): nothing left to scan, the phones are connecting
  assert.deepEqual(hostReplyView({ inbox: true, camera: true, scanning: false, answered: true }), { scanButton: false, camera: false });
  assert.deepEqual(hostReplyView({ inbox: true, camera: true, scanning: true, answered: true }), { scanButton: false, camera: false });
  // no inbox (web, or listening failed): the camera scans from the start, no button
  assert.deepEqual(hostReplyView({ inbox: false, camera: true, scanning: true, answered: false }), { scanButton: false, camera: true });
  assert.deepEqual(hostReplyView({ inbox: false, camera: true, scanning: false, answered: false }), { scanButton: false, camera: true });
  // no camera: nothing to offer (paste / link only)
  assert.deepEqual(hostReplyView({ inbox: true, camera: false, scanning: false, answered: false }), { scanButton: false, camera: false });
  assert.deepEqual(hostReplyView({ inbox: false, camera: false, scanning: false, answered: false }), { scanButton: false, camera: false });
  assert.deepEqual(hostReplyView({}), { scanButton: false, camera: false });
});

test("the pairing sheets hide the native pad (they are native-mode overlays), so nothing native covers the scan button", () => {
  assert.ok(OVERLAY_IDS.includes("link"));
  assert.ok(OVERLAY_IDS.includes("join"));
});
