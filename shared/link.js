// SPDX-License-Identifier: MIT — part of nostaljibox-player/shared, usable outside the GPL player.
// Two-phone play over the local network: the host phone runs the emulator and streams its
// screen to the guest over WebRTC; the guest sends its button presses back on a data channel.
// There is no server: the WebRTC offer/answer are exchanged as QR codes (or copied text).
import QRCode from "qrcode";
import jsQR from "jsqr";
import { Share } from "@capacitor/share";
import { Clipboard } from "@capacitor/clipboard";
import { App } from "@capacitor/app";

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

export async function encodeDescription(desc) {
  return PREFIX + (await deflate(JSON.stringify({ t: desc.type, s: minimizeSdp(desc.sdp) })));
}

export async function decodeDescription(code) {
  code = code.trim();
  if (!code.startsWith(PREFIX)) throw new Error("Bu bir NostaljiBox bağlantı kodu değil.");
  const { t, s } = JSON.parse(await inflate(code.slice(PREFIX.length)));
  return { type: t, sdp: s };
}

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
  await QRCode.toCanvas(canvas, text, { errorCorrectionLevel: "L", margin: 2, width: size });
  canvas.style.width = canvas.style.height = "";
}

// Camera permission also makes browsers put real LAN addresses (not mDNS names) in the SDP,
// which is what lets two phones find each other without a server.
export async function openCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
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
      const scale = Math.min(1, 640 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (hit && hit.data.startsWith(PREFIX)) {
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

// Raise the video bitrate: on a LAN we can afford a sharp picture.
export async function tuneSender(sender) {
  try {
    const p = sender.getParameters();
    p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = 6_000_000;
    p.encodings[0].maxFramerate = 60;
    p.degradationPreference = "maintain-framerate";
    await sender.setParameters(p);
  } catch {
    // not supported everywhere
  }
}

// ---------- invite links ----------
// The same codes can travel through any messenger: "nostaljibox://join?c=…" carries the host's
// offer, "nostaljibox://answer?c=…" the guest's reply. Only connection data is shared, never a ROM.

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
      ? `🎮 NostaljiBox'ta 2. oyuncu olmaya davet edildin!\nAçmak için dokun: ${link}\n\nAçılmazsa bu mesajı kopyala, NostaljiBox → "2. oyuncu olarak katıl" → "Panodan yapıştır".`
      : `🎮 NostaljiBox: 2. oyuncu hazır.\nBağlanmak için dokun: ${link}\n\nAçılmazsa bu mesajı kopyala, oyundaki 👥 ekranında "Panodan yapıştır".`;
  if (native()) return Share.share({ title: "NostaljiBox daveti", text, dialogTitle: "Davet gönder" });
  if (navigator.share) return navigator.share({ title: "NostaljiBox daveti", text });
  await navigator.clipboard.writeText(text);
  return { copied: true };
}

// Finds a pairing code anywhere in pasted text (a whole shared message works too).
export function findCode(text) {
  const inv = parseInvite((/nostaljibox:\/\/\S+/i.exec(text || "") || [""])[0]);
  if (inv) return inv.code;
  const m = new RegExp(PREFIX + "[A-Za-z0-9_-]+").exec(text || "");
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
  App.addListener("appUrlOpen", ({ url }) => {
    const inv = parseInvite(url);
    if (inv) handler(inv);
  });
  const launch = await App.getLaunchUrl().catch(() => null);
  const inv = launch && parseInvite(launch.url);
  if (inv && !sessionStorage.getItem("handled:" + inv.code)) {
    sessionStorage.setItem("handled:" + inv.code, "1");
    handler(inv);
  }
}
