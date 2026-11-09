// SPDX-License-Identifier: MIT — used by shared/link.js, so it stays usable outside the GPL player.
// Pairing over the local network when one phone is a Personal Hotspot (or both are on one Wi-Fi):
// which addresses to try, in which order, and how the answer is handed to the host's inbox.
//
// Addresses a phone shows (PairInbox lanAddresses: en0, en*, bridge*; WebRTC host candidates):
//   same Wi-Fi            en0 192.168.1.x on both
//   hotspot owner         bridge100 172.20.10.1; en0 has no IPv4 or a 169.254.x.x one; pdp_ip0 (cellular,
//                         often 10.x or 100.64.x) is the default route
//   hotspot client        en0 172.20.10.2–14; its own pdp_ip0 as well
//   USB / not associated  en2 or en0 169.254.x.x (link-local): never the other phone
// So: a private IPv4 (10/8, 172.16/12, 192.168/16) comes first, a link-local one last (or not at all),
// and a candidate in the other phone's subnet before any other.

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const PRIVATE = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/;
const LINK_LOCAL = /^169\.254\./;

export const isIPv4 = (ip) => IPV4.test(String(ip || ""));
export const isPrivateIPv4 = (ip) => isIPv4(ip) && PRIVATE.test(ip);
export const isLinkLocal = (ip) => isIPv4(ip) && LINK_LOCAL.test(ip);

const stableSortBy = (list, rank) =>
  list.map((v, i) => [rank(v), i, v]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((e) => e[2]);

// The same /24 as one of `lanIps` (a hotspot is a /28 inside 172.20.10.0/24, Wi-Fi mostly a /24).
export function sameLan(ip, lanIps) {
  if (!isIPv4(ip)) return false;
  const net = ip.slice(0, ip.lastIndexOf("."));
  return (lanIps || []).some((lan) => isIPv4(lan) && lan.slice(0, lan.lastIndexOf(".")) === net);
}

// 0 in the other phone's subnet, 1 private, 2 other (cellular, public), 3 mDNS name, 4 link-local.
export function addressRank(host, lanIps = []) {
  const h = String(host || "");
  if (!isIPv4(h)) return 3;
  if (isLinkLocal(h)) return 4;
  if (sameLan(h, lanIps)) return 0;
  return isPrivateIPv4(h) ? 1 : 2;
}

// The inbox addresses the host puts in its invite, best first: IPv4 only, duplicates and
// link-local addresses dropped, private ones before the rest.
export function rankLanIps(ips) {
  const out = [];
  for (const ip of ips || []) {
    const s = String(ip || "").trim();
    if (!isIPv4(s) || isLinkLocal(s) || out.includes(s)) continue;
    out.push(s);
  }
  return stableSortBy(out, (ip) => addressRank(ip));
}

// ICE host candidates [host, port] in the order the code should carry them (the compact code keeps
// the first few): the other phone's subnet first, then private, then the rest; mDNS names and
// link-local addresses at the end. Nothing is dropped: a candidate list is never empty here.
export function rankCandidates(cands, lanIps = []) {
  return stableSortBy(cands || [], ([host]) => addressRank(host, lanIps));
}

// One attempt failed because nothing answered (PairInbox "timeout"): the iOS Local Network prompt
// may have been on screen, or the address was dead. Anything else was a real refusal.
// Also used by the TCP channel's connect rounds (opus-5-5/js/tcp-channel.js).
export const isTimeout = (e) => /timeout|timed out/i.test(e?.message ?? e?.code ?? String(e ?? ""));

// Every address at once; resolves null on the first success, else the list of failures.
function raceSends(ips, send) {
  return new Promise((resolve) => {
    let pending = ips.length;
    const failures = [];
    for (const host of ips) {
      let attempt;
      try {
        attempt = Promise.resolve(send(host));
      } catch (e) {
        attempt = Promise.reject(e);
      }
      attempt.then(
        () => resolve(null),
        (e) => {
          failures.push(e);
          if (--pending === 0) resolve(failures);
        },
      );
    }
  });
}

/**
 * Hands the answer to the host's inbox. `send(host)` (one PairInbox.send: a TCP connection, 10 s
 * timeout, resolves once the host replied OK) runs for all addresses in parallel; the first OK wins.
 * When every attempt of a round timed out, one more round follows: the first connection on a phone
 * waits behind the iOS Local Network prompt, and the user may tap Allow after the first 10 s.
 * Resolves true once the host has the answer, false when every address failed (QR fallback).
 */
export async function sendToInbox({ ips, send, rounds = 2, onRound = null }) {
  const list = rankLanIps(ips);
  if (!list.length || typeof send !== "function") return false;
  for (let round = 1; round <= rounds; round++) {
    if (onRound) onRound(round, list);
    const failures = await raceSends(list, send);
    if (failures === null) return true;
    if (!failures.every(isTimeout)) return false;
  }
  return false;
}

// One line from the host's inbox: "<host ICE ufrag> <answer code>" → { ufrag, code }, else null.
// A "NB-CH1 <token>" channel request (NETPLAY.md §12) that reached an older host's inbox is not an
// answer and is ignored (a new guest only sends it to a host whose invite has the tcp flag).
export function parseInboxLine(text) {
  const [ufrag, code] = String(text ?? "").split(" ");
  return code && (code.startsWith("NB1:") || /^NB[23]:/i.test(code)) ? { ufrag, code } : null;
}

/**
 * What the host's reply step shows (host-link.js #link-scan and #link-cam).
 *   inbox     the Wi-Fi inbox is listening (the reply normally arrives by itself)
 *   camera    the camera could be opened
 *   scanning  the camera is scanning for the reply (tapped "scan", or no inbox at all)
 *   answered  a reply has been applied to the connection (from the inbox or the camera)
 * The scan button is offered only while a reply may still come by camera; once one is in, the
 * phones are connecting and scanning the same code again could do nothing.
 */
export function hostReplyView({ inbox, camera, scanning, answered }) {
  const open = !!camera && !answered;
  return {
    scanButton: open && !!inbox && !scanning,
    camera: open && (!inbox || !!scanning),
  };
}
