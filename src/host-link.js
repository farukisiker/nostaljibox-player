// SPDX-License-Identifier: GPL-3.0-or-later
// Host side of two-phone play: sends the ROM and a savestate to the guest phone, then both run
// the game in lockstep with the guest as player 2.
import {
  createPeer, gatheringDone, encodeDescription, decodeDescription, drawQR, openCamera, stopCamera, scanQR,
  shareInvite, pasteCode, findCode, onInviteLink,
} from "../shared/link.js";
import { channelIO, Lockstep } from "./lockstep.js";

const $ = (s) => document.querySelector(s);
const panel = $("#link");
const status = $("#link-status");

let pc = null;
let camera = null;
let stopScan = null;
let sync = null;
let currentGame = () => null;

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

function closePanel() {
  panel.classList.add("hidden");
  if (stopScan) stopScan();
  stopCamera(camera);
  camera = stopScan = null;
}

function hangUp() {
  if (sync) sync.detach();
  sync = null;
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
  const channel = pc.createDataChannel("link", { ordered: true });
  channel.onopen = () => {
    closePanel();
    document.body.classList.add("linked");
    toast("2. oyuncu bağlandı, oyun ona gönderiliyor…");
    const { game, rom } = currentGame();
    const io = channelIO(channel, (msg, bytes) => {
      if (msg.t === "booted") sync.resync();
      else sync.onMessage(msg, bytes);
    });
    sync = new Lockstep(e, io, true, (waiting) => waiting && toast("2. oyuncu bekleniyor…"));
    sync.attach();
    // Freeze until the guest has loaded the game and the same savestate.
    sync.setHold(true);
    // Library ROMs are stored as Blobs or ArrayBuffers.
    new Blob([rom]).arrayBuffer().then((buf) =>
      io.sendBytes({ t: "rom", name: game.name, file: game.file, core: game.core }, new Uint8Array(buf)),
    );
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

export function setupHostLink(getGame) {
  currentGame = getGame;
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
