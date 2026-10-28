// SPDX-License-Identifier: MIT — part of nostaljibox-player/shared, usable outside the GPL player.
// Two-phone play over the local network: both phones run the game and exchange button presses
// (and, at the start, the ROM and a savestate) on a WebRTC data channel.
// There is no server: the WebRTC offer/answer are exchanged as QR codes (or copied text).
import QRCode from "qrcode";
import jsQR from "jsqr";
import { Share } from "@capacitor/share";
import { Clipboard } from "@capacitor/clipboard";
import { App } from "@capacitor/app";
import { t } from "./i18n.js";

const PREFIX = "NB1:";

async function deflate(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function inflate(code) {
  const b64 = code.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

// Shrinks an SDP so its QR code stays easy to scan: keeps a single video codec (VP8, which every
// WebRTC stack supports), drops RTP header extensions, SSRC bookkeeping, retransmission and non-IPv4/TCP candidates.
export function minimizeSdp(sdp) {
  const lines = sdp.split(/\r?\n/).filter(Boolean);
  const keepPts = new Set();
  const rtpmap = lines.filter((l) => l.startsWith("a=rtpmap:"));
  const vp8 = rtpmap.find((l) => /VP8\/90000/i.test(l));
  if (vp8) keepPts.add(vp8.slice(9).split(" ")[0]);
  const ptOf = (l) => l.slice(l.indexOf(":") + 1).split(/[ ]/)[0];
  let inVideo = false;
  const out = [];
  for (let l of lines) {
    if (l.startsWith("m=")) inVideo = l.startsWith("m=video");
    if (inVideo && keepPts.size) {
      if (l.startsWith("m=video")) {
        const parts = l.split(" ");
        l = parts.slice(0, 3).concat([...keepPts]).join(" ");
      } else if (/^a=(rtpmap|fmtp|rtcp-fb):/.test(l) && !keepPts.has(ptOf(l))) continue;
      // Keep only keyframe requests and NACK; congestion feedback is not needed on a LAN.
      if (l.startsWith("a=rtcp-fb:") && !/ nack/.test(l)) continue;
    }
    if (/^a=(ssrc:|rtcp-xr|extmap-allow-mixed|msid-semantic)/.test(l)) continue;
    // Same-network play only needs IPv4 host candidates; drop the trailing bookkeeping fields.
    if (l.startsWith("a=candidate")) {
      const f = l.split(" ");
      if (f[2].toLowerCase() !== "udp" || f[4].includes(":")) continue;
      l = f.slice(0, 8).join(" ");
    }
    if (l.startsWith("a=extmap") || l.startsWith("a=ssrc-group:FID")) continue;
    out.push(l);
  }
  return out.join("\r\n") + "\r\n";
}

// ---------- compact codes (NB3) ----------
// A whole SDP made a ~100×100 QR that phone cameras could not read. Both phones build the same
// SDP shape (one data channel), so only the per-session fields travel: ICE ufrag/password, the
// DTLS fingerprint, the DTLS role and the host candidates (IPv4 or mDNS name). About 90 bytes,
// in base32 so the QR uses alphanumeric mode. NB2 was the same for the old video-streaming SDP.
const PREFIX3 = "NB3:";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SETUPS = ["actpass", "active", "passive"];

function toBase32(bytes) {
  let out = "", bits = 0, value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) out += B32[(value >>> (bits -= 5)) & 31];
  }
  if (bits) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text) {
  const out = [];
  let bits = 0, value = 0;
  for (const ch of text) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("bad code");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) out.push((value >>> (bits -= 8)) & 255);
  }
  return new Uint8Array(out);
}

// The per-session fields of an SDP, or null when it does not have the shape the template rebuilds.
function sessionFields(sdp) {
  const get = (re) => (re.exec(sdp) || [])[1];
  const ufrag = get(/^a=ice-ufrag:(\S+)/m);
  const pwd = get(/^a=ice-pwd:(\S+)/m);
  const fp = get(/^a=fingerprint:sha-256 ((?:[0-9A-F]{2}:){31}[0-9A-F]{2})\s*$/im);
  const setup = SETUPS.indexOf(get(/^a=setup:(\w+)/m));
  const mids = [...sdp.matchAll(/^a=mid:(\S+)/gm)].map((m) => m[1]).join();
  const first = sdp.split(/^m=/m)[1] || "";
  // Host candidates are either IPv4 addresses or, before camera permission, mDNS names (<uuid>.local).
  const cands = [...first.matchAll(/^a=candidate:\S+ 1 udp \d+ (\d+\.\d+\.\d+\.\d+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.local) (\d+) typ host/gim)]
    .map((m) => [m[1].toLowerCase(), +m[2]])
    .slice(0, 4);
  if (!ufrag || !pwd || !fp || setup < 0 || mids !== "0" || !first.startsWith("application") || !cands.length) return null;
  if (ufrag.length > 255 || pwd.length > 255) return null;
  return { ufrag, pwd, fp, setup, cands };
}

function packFields(type, f) {
  const enc = new TextEncoder();
  const u = enc.encode(f.ufrag), p = enc.encode(f.pwd);
  const fp = f.fp.split(":").map((h) => parseInt(h, 16));
  const bytes = [type === "offer" ? 0 : 1, f.setup, u.length, ...u, p.length, ...p, ...fp, f.cands.length];
  // Each candidate: 0 + 4 address bytes, or 1 + the 16 bytes of the mDNS UUID; then the port.
  for (const [host, port] of f.cands) {
    if (host.endsWith(".local")) bytes.push(1, ...host.slice(0, -6).replace(/-/g, "").match(/../g).map((h) => parseInt(h, 16)));
    else bytes.push(0, ...host.split(".").map(Number));
    bytes.push(port >> 8, port & 255);
  }
  return new Uint8Array(bytes);
}

function unpackFields(bytes) {
  const dec = new TextDecoder();
  let i = 0;
  const type = bytes[i++] === 0 ? "offer" : "answer";
  const setup = SETUPS[bytes[i++]];
  const ufrag = dec.decode(bytes.subarray(i + 1, i + 1 + bytes[i])); i += 1 + bytes[i];
  const pwd = dec.decode(bytes.subarray(i + 1, i + 1 + bytes[i])); i += 1 + bytes[i];
  const fp = [...bytes.subarray(i, i + 32)].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(":"); i += 32;
  const cands = [];
  for (let n = bytes[i++]; n > 0; n--) {
    let host;
    if (bytes[i++] === 1) {
      const h = [...bytes.subarray(i, i + 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
      host = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
      i += 16;
    } else {
      host = [...bytes.subarray(i, i + 4)].join(".");
      i += 4;
    }
    cands.push([host, (bytes[i] << 8) | bytes[i + 1]]);
    i += 2;
  }
  if (!setup || !cands.length || i > bytes.length) throw new Error("bad code");
  return { type, setup, ufrag, pwd, fp, cands };
}

// Rebuilds the SDP the other phone produced.
function buildSdp(f) {
  const port = f.cands[0][1];
  const ip = (f.cands.find(([h]) => !h.endsWith(".local")) || ["0.0.0.0"])[0];
  const cand = f.cands.map(([a, p], i) => `a=candidate:${i + 1} 1 udp ${2122260223 - i * 65536} ${a} ${p} typ host`);
  return [
    "v=0", `o=- ${Date.now()} 2 IN IP4 127.0.0.1`, "s=-", "t=0 0", "a=group:BUNDLE 0",
    `m=application ${port} UDP/DTLS/SCTP webrtc-datachannel`, `c=IN IP4 ${ip}`, ...cand,
    `a=ice-ufrag:${f.ufrag}`, `a=ice-pwd:${f.pwd}`, "a=ice-options:trickle", `a=fingerprint:sha-256 ${f.fp}`, `a=setup:${f.setup}`,
    "a=mid:0", "a=sctp-port:5000", "a=max-message-size:262144",
  ].join("\r\n") + "\r\n";
}

export async function encodeDescription(desc) {
  const fields = sessionFields(desc.sdp);
  if (fields) return PREFIX3 + toBase32(packFields(desc.type, fields));
  // Unusual SDP (e.g. mDNS candidates): fall back to the full compressed form.
  return PREFIX + (await deflate(JSON.stringify({ t: desc.type, s: minimizeSdp(desc.sdp) })));
}

export async function decodeDescription(code) {
  code = code.trim();
  if (/^NB2:/i.test(code)) throw new Error(t("oldVersion"));
  if (code.toUpperCase().startsWith(PREFIX3)) {
    const f = unpackFields(fromBase32(code.slice(PREFIX3.length).toUpperCase()));
    return { type: f.type, sdp: buildSdp(f) };
  }
  if (!code.startsWith(PREFIX)) throw new Error(t("notACode"));
  const { t, s } = JSON.parse(await inflate(code.slice(PREFIX.length)));
  return { type: t, sdp: s };
}

const isCode = (text) => text.startsWith(PREFIX) || /^NB[23]:/i.test(text);

// Same-network play needs no STUN/TURN; host candidates are enough.
export function createPeer() {
  return new RTCPeerConnection({ iceServers: [] });
}

// Non-trickle ICE: wait until every candidate is in the SDP so one code carries everything.
export function gatheringDone(pc, timeout = 4000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", done);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", done);
    setTimeout(resolve, timeout);
  });
}

// Render at device resolution so every module stays crisp for the other phone's camera.
export async function drawQR(canvas, text) {
  const size = Math.round((canvas.clientWidth || 280) * (window.devicePixelRatio || 1));
  // A full 4-module quiet zone; cameras lose the finder patterns when the code touches the edge.
  await QRCode.toCanvas(canvas, text, { errorCorrectionLevel: "L", margin: 4, width: size });
  canvas.style.width = canvas.style.height = "";
}

// Camera permission also makes browsers put real LAN addresses (not mDNS names) in the SDP,
// which is what lets two phones find each other without a server.
export async function openCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play();
  return stream;
}

export function stopCamera(stream) {
  if (stream) for (const t of stream.getTracks()) t.stop();
}

// Scans frames from a playing <video> until a QR with our prefix shows up.
export function scanQR(video, onCode) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    if (video.videoWidth) {
      // Small frames turn each QR module into 2–3 pixels; 1280 keeps them readable.
      const scale = Math.min(1, 1280 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (hit && isCode(hit.data)) {
        stopped = true;
        onCode(hit.data);
        return;
      }
    }
    setTimeout(tick, 120);
  };
  tick();
  return () => (stopped = true);
}

// ---------- invite links ----------
// The same codes can travel through any messenger: "nostaljibox://join?c=…" carries the host's
// offer, "nostaljibox://answer?c=…" the guest's reply. Only connection data is in them, never a ROM.

const native = () => !!window.Capacitor?.isNativePlatform?.();

export function inviteUrl(kind, code) {
  return `nostaljibox://${kind}?c=${encodeURIComponent(code)}`;
}

// Returns { kind: "join" | "answer", code } for one of our links, or null.
export function parseInvite(url) {
  const m = /^nostaljibox:\/\/(join|answer)\?c=([^&#\s]+)/i.exec(url || "");
  return m ? { kind: m[1].toLowerCase(), code: decodeURIComponent(m[2]) } : null;
}

export async function shareInvite(kind, code) {
  const link = inviteUrl(kind, code);
  const text =
    kind === "join"
      ? t("inviteMessage", { link })
      : t("replyMessage", { link });
  if (native()) return Share.share({ title: t("inviteTitle"), text, dialogTitle: t("inviteTitle") });
  if (navigator.share) return navigator.share({ title: t("inviteTitle"), text });
  await navigator.clipboard.writeText(text);
  return { copied: true };
}

// Finds a pairing code anywhere in pasted text (a whole shared message works too).
export function findCode(text) {
  const inv = parseInvite((/nostaljibox:\/\/\S+/i.exec(text || "") || [""])[0]);
  if (inv) return inv.code;
  const m = /NB[23]:[A-Z2-7]+|NB1:[A-Za-z0-9_-]+/i.exec(text || "");
  return m ? m[0] : null;
}

export async function pasteCode() {
  const text = native() ? (await Clipboard.read()).value : await navigator.clipboard.readText();
  return findCode(text);
}

// Calls handler for invite links that open the app, including the one it was launched with.
// Pages hand a link to each other in the URL hash (e.g. library -> guest.html#nostaljibox://...).
export async function onInviteLink(handler) {
  const fromHash = parseInvite(decodeURIComponent(location.hash.slice(1)));
  if (fromHash) {
    history.replaceState(null, "", location.pathname + location.search);
    handler(fromHash);
  }
  if (!native()) return;
  // getLaunchUrl keeps returning the last link that opened the app (iOS updates it even when the
  // app was already running), so every later visit to the library would handle that invite again
  // and reopen the camera. Remember handled codes in localStorage, which also survives restarts;
  // each code holds a one-time WebRTC offer, so it is never useful twice.
  const seen = (inv) => localStorage.getItem("handled:" + inv.code);
  const mark = (inv) => localStorage.setItem("handled:" + inv.code, "1");
  App.addListener("appUrlOpen", ({ url }) => {
    const inv = parseInvite(url);
    if (!inv) return;
    mark(inv);
    handler(inv);
  });
  const launch = await App.getLaunchUrl().catch(() => null);
  const inv = launch && parseInvite(launch.url);
  if (inv && !seen(inv)) {
    mark(inv);
    handler(inv);
  }
}
