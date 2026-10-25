// SPDX-License-Identifier: GPL-3.0-or-later
// Host side of two-phone play: streams the emulator canvas to the guest phone and feeds the
// guest's buttons into the emulator as player 2.
import {
  createPeer, gatheringDone, encodeDescription, decodeDescription, drawQR, openCamera, stopCamera, scanQR, tuneSender,
  shareInvite, pasteCode, findCode, onInviteLink,
} from "../shared/link.js";

const $ = (s) => document.querySelector(s);
const panel = $("#link");
const status = $("#link-status");

let pc = null;
let camera = null;
let stopScan = null;
let held = new Set();

export function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2500);
}

function emulator() {
  const e = window.EJS_emulator;
  return e && e.gameManager && e.canvas ? e : null;
}

function press(btn, value) {
  const e = emulator();
  if (!e) return;
  e.gameManager.simulateInput(1, btn, value);
  if (value) held.add(btn);
  else held.delete(btn);
}

function releaseAll() {
  for (const b of [...held]) press(b, 0);
}

function closePanel() {
  panel.classList.add("hidden");
  if (stopScan) stopScan();
  stopCamera(camera);
  camera = stopScan = null;
}

function hangUp() {
  releaseAll();
  if (pc) pc.close();
  pc = null;
  document.body.classList.remove("linked");
}

async function accept(code) {
  if (!pc || pc.remoteDescription) return;
  try {
    await pc.setRemoteDescription(await decodeDescription(code));
    status.textContent = "Bağlanıyor…";
  } catch (e) {
    status.textContent = e.message || String(e);
  }
}

async function start() {
  const e = emulator();
  if (!e) return toast("Oyun daha yükleniyor, birazdan tekrar dene.");
  hangUp();
  panel.classList.remove("hidden");
  status.textContent = "Kamera açılıyor…";

  // Camera first: its permission is what exposes LAN addresses to WebRTC.
  try {
    camera = await openCamera($("#link-cam"));
  } catch {
    status.textContent = "Kamera açılamadı; kodları kopyala/yapıştır ile değiştirebilirsin.";
  }

  pc = createPeer();
  const stream = e.canvas.captureStream(60);
  for (const track of stream.getVideoTracks()) tuneSender(pc.addTrack(track, stream));
  const channel = pc.createDataChannel("input", { ordered: true });
  channel.onmessage = (m) => {
    const [btn, value] = JSON.parse(m.data);
    press(btn, value);
  };
  channel.onopen = () => {
    closePanel();
    document.body.classList.add("linked");
    toast("2. oyuncu bağlandı 🎮");
  };
  channel.onclose = () => {
    if (document.body.classList.contains("linked")) toast("2. oyuncunun bağlantısı koptu");
    hangUp();
  };
  pc.onconnectionstatechange = () => {
    if (pc && pc.connectionState === "failed") {
      status.textContent = "Bağlantı kurulamadı. İki telefon aynı Wi-Fi ağında mı?";
    }
  };

  await pc.setLocalDescription(await pc.createOffer());
  await gatheringDone(pc);
  const code = await encodeDescription(pc.localDescription);
  await drawQR($("#link-qr"), code);
  $("#link-share").onclick = () =>
    shareInvite("join", code)
      .then((r) => r && r.copied && toast("Davet panoya kopyalandı"))
      .catch(() => {});
  if (camera) {
    status.textContent = "Kodu ikinci telefona okut, sonra onun gösterdiği kodu bu kameraya göster.";
    stopScan = scanQR($("#link-cam"), accept);
  }
}

export function setupHostLink() {
  $("#p2").addEventListener("click", start);
  $("#link-close").addEventListener("click", () => {
    closePanel();
    if (pc && pc.connectionState !== "connected") hangUp();
  });
  $("#link-paste").addEventListener("input", (ev) => {
    const code = findCode(ev.target.value);
    if (code) accept(code);
  });
  $("#link-from-clipboard").addEventListener("click", async () => {
    const code = await pasteCode().catch(() => null);
    if (code) accept(code);
    else toast("Panoda bağlantı kodu yok");
  });
  // The guest's reply can also arrive as a nostaljibox://answer link from a messenger.
  onInviteLink(({ kind, code }) => {
    if (kind !== "answer") return toast("Bu bir katılma daveti; ana telefonda 👥 ile davet oluştur.");
    if (!pc) return toast("Önce 👥 ile davet oluştur.");
    panel.classList.remove("hidden");
    accept(code);
  });
  window.addEventListener("pagehide", hangUp);
}
