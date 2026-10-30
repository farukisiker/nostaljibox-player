// SPDX-License-Identifier: GPL-3.0-or-later
// Host side of two-phone play: sends the ROM and a savestate to the guest phone, then both run
// the game in lockstep with the guest as player 2.
import {
  createPeer, gatheringDone, encodeDescription, decodeDescription, drawQR, openCamera, stopCamera, scanQR,
  shareInvite, pasteCode, findCode, onInviteLink, listenForAnswer, iceUfrag,
} from "../shared/link.js";
import { channelIO, Lockstep } from "./lockstep.js";
import { t } from "../shared/i18n.js";

const $ = (s) => document.querySelector(s);
const panel = $("#link");
const status = $("#link-status");

let pc = null;
let camera = null;
let stopScan = null;
let inbox = null;
let sync = null;
let currentGame = () => null;

export function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2500);
}

// The toolbar sits where a thumb rests in landscape, and a stray tap on it used to end two-phone
// play, so its buttons only act after being held down.
const HOLD_MS = 600;
export function onHold(el, fn) {
  let timer = null;
  const cancel = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    el.classList.remove("holding");
    toast(t("holdToUse"));
  };
  el.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    el.classList.add("holding");
    timer = setTimeout(() => {
      timer = null;
      el.classList.remove("holding");
      fn();
    }, HOLD_MS);
  });
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("pointerleave", cancel);
  el.addEventListener("contextmenu", (ev) => ev.preventDefault());
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

function stopInbox() {
  if (inbox) inbox.stop();
  inbox = null;
}

function hangUp() {
  stopInbox();
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
    status.textContent = t("connecting");
  } catch (e) {
    status.textContent = e.message || String(e);
  }
}

async function start() {
  const e = emulator();
  if (!e) return toast(t("stillLoading"));
  // The button stays on screen during two-phone play; a stray tap must not cut player 2 off.
  if (sync) return toast(t("p2AlreadyConnected"));
  hangUp();
  panel.classList.remove("hidden");
  status.textContent = t("preparing");

  // The guest replies over the Wi-Fi, so only the guest scans a code. Without that inbox (web, or
  // listening failed) the host scans the guest's reply instead.
  inbox = await listenForAnswer((ufrag, code) => {
    if (pc && pc.localDescription && ufrag === iceUfrag(pc.localDescription.sdp)) accept(code);
  });
  status.textContent = t("cameraOpening");
  // Camera first, even when nothing is scanned here: while it runs, iOS and Android let WebRTC use
  // the phone's LAN address, and without that the phones never connect. It stays on (hidden when
  // the reply comes over the Wi-Fi) until the guest is connected.
  try {
    camera = await openCamera($("#link-cam"));
  } catch {
    status.textContent = t("hostNoCamera");
  }
  $("#link-cam").classList.toggle("hidden", !camera || !!inbox.info);
  $("#link-scan").classList.add("hidden");

  pc = createPeer();
  const channel = pc.createDataChannel("link", { ordered: true });
  channel.onopen = () => {
    stopInbox();
    closePanel();
    document.body.classList.add("linked");
    toast(t("p2Connected"));
    const { game, rom } = currentGame();
    const io = channelIO(channel, (msg, bytes) => {
      if (msg.t === "booted") sync.resync();
      else sync.onMessage(msg, bytes);
    });
    sync = new Lockstep(e, io, true, (waiting) => waiting && toast(t("waitingP2")));
    sync.attach();
    // Freeze until the guest has loaded the game and the same savestate.
    sync.setHold(true);
    // Library ROMs are stored as Blobs or ArrayBuffers.
    new Blob([rom]).arrayBuffer().then((buf) =>
      io.sendBytes({ t: "rom", name: game.name, file: game.file, core: game.core }, new Uint8Array(buf)),
    );
  };
  channel.onclose = () => {
    if (document.body.classList.contains("linked")) toast(t("p2Left"));
    hangUp();
  };
  pc.onconnectionstatechange = () => {
    if (pc && pc.connectionState === "failed") {
      status.textContent = t("connectFailed");
    }
  };

  await pc.setLocalDescription(await pc.createOffer());
  await gatheringDone(pc);
  const code = await encodeDescription(pc.localDescription, inbox && inbox.info);
  await drawQR($("#link-qr"), code);
  $("#link-share").onclick = () =>
    shareInvite("join", code)
      .then((r) => r && r.copied && toast(t("inviteCopied")))
      .catch(() => {});
  if (inbox && inbox.info) {
    status.textContent = t("hostWaitHint");
    // If the Wi-Fi reply doesn't arrive, the guest shows it as a code; this button scans it.
    const offered = pc;
    $("#link-scan").classList.toggle("hidden", !camera);
    $("#link-scan").onclick = () => {
      if (pc !== offered || pc.remoteDescription || !camera || stopScan) return;
      $("#link-scan").classList.add("hidden");
      $("#link-cam").classList.remove("hidden");
      status.textContent = t("hostScanHint");
      stopScan = scanQR($("#link-cam"), accept);
    };
  } else if (camera) {
    status.textContent = t("hostScanHint");
    stopScan = scanQR($("#link-cam"), accept);
  }
}

export function setupHostLink(getGame) {
  currentGame = getGame;
  onHold($("#p2"), start);
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
    else toast(t("noLinkCode"));
  });
  // The guest's reply can also arrive as a nostaljibox://answer link from a messenger.
  onInviteLink(({ kind, code }) => {
    if (kind !== "answer") return toast(t("thisIsInvite"));
    if (!pc) return toast(t("createInviteFirst"));
    panel.classList.remove("hidden");
    accept(code);
  });
  window.addEventListener("pagehide", hangUp);
}
