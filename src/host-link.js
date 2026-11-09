// SPDX-License-Identifier: GPL-3.0-or-later
// Host side of two-phone play: sends the ROM and a savestate to the guest phone, then both run
// the game in lockstep with the guest as player 2. The host keeps playing on whatever runs here
// (EmulatorJS, or the native player on iPhone); the invite says which, and only a guest on the same
// backend and version is accepted (NETPLAY.md §1.1). Two native iPhones use the PairInbox TCP
// channel when they can (NETPLAY.md §12, works on a Personal Hotspot); everything else WebRTC.
import {
  createPeer, gatheringDone, encodeDescription, decodeDescription, drawQR, openCamera, stopCamera, scanQR,
  shareInvite, pasteCode, findCode, onInviteLink, listenForAnswer, iceUfrag, pairInbox,
} from "../shared/link.js";
import { channelIO, createLockstep } from "./lockstep.js";
import { t } from "../shared/i18n.js";
import { localPeer, pairingProblem, describePeer } from "../native/agents/fable/js/peer-block.js";
import { startupTimeout } from "../native/agents/fable/js/startup-timeout.js";
import { nt } from "../native/agents/fable/js/strings.js";
import { hostReplyView } from "../native/agents/fable/js/pair-net.js";
import { hasChannels, acceptChannel } from "../native/agents/opus-5-5/js/tcp-channel.js";

const $ = (s) => document.querySelector(s);
const panel = $("#link");
const status = $("#link-status");
// After the reply is in, ICE has this long to connect before the panel says it could not
// (WebKit's own "failed" usually comes sooner; this is the backstop).
const CONNECT_WAIT_MS = 25000;

let pc = null;
let rtc = null; // the WebRTC data channel of pc
let link = null; // the PairInbox TCP channel, when the guest connected that way
let tcpAccept = null; // takes the guest's TCP channel while the invite is up (tcp-channel.js)
let camera = null;
let stopScan = null;
let inbox = null;
let answered = false; // a reply was applied to pc (over the Wi-Fi or by camera)
let connectTimer = null;
let sync = null;
let io = null;
let startup = null;
let myPeer = null;
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

// The native player's plugin while a native session runs (set by native-mode.js), else null.
function nativeSession() {
  return window.nbNative?.plugin || null;
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

// The reply step's scan button and camera (pair-net.js hostReplyView): the button only while the
// reply may still come by camera; once a reply is applied, nothing is left to scan.
function showReplyStep() {
  const view = hostReplyView({ inbox: !!(inbox && inbox.info), camera: !!camera, scanning: !!stopScan, answered });
  $("#link-scan").classList.toggle("hidden", !view.scanButton);
  $("#link-cam").classList.toggle("hidden", !view.camera);
}

// The phones could not connect: both the same Wi-Fi/hotspot and Local Network access are needed.
function connectFailed() {
  status.textContent = `${t("connectFailed")} ${nt("sameNetworkHint")}`;
}

// Every way the link ends goes through here: the lockstep detaches (native: lockstepStop, which also
// clears the session hold), the heartbeat and startup timers stop, the peer connection closes.
function hangUp() {
  stopInbox();
  if (tcpAccept) tcpAccept.stop();
  tcpAccept = null;
  clearTimeout(connectTimer);
  connectTimer = null;
  answered = false;
  if (startup) startup.clear();
  startup = null;
  if (sync) sync.detach();
  sync = null;
  if (io) io.close();
  io = null;
  if (link) link.close(); // a local close: no onclose, so no second hangUp
  link = null;
  if (pc) pc.close();
  pc = null;
  rtc = null;
  document.body.classList.remove("linked");
}

// The link broke (heartbeat silence, ICE failed): single player goes on here.
function lost() {
  if (document.body.classList.contains("linked")) toast(nt("connectionLost"));
  hangUp();
}

// The pairing message for a guest whose block does not match ours, or null when it does.
function refusal(theirs) {
  const problem = pairingProblem(myPeer, theirs);
  if (!problem) return null;
  if (problem === "legacy") return nt("guestOutdated");
  const words = { ejs: nt("backendEjs"), old: nt("backendOld") };
  return nt("peerMismatch", { mine: describePeer(myPeer, words), theirs: describePeer(theirs, words) });
}

async function accept(code) {
  if (!pc || pc.remoteDescription) return;
  try {
    const answer = await decodeDescription(code);
    const message = refusal(answer.peer);
    if (message) {
      // Not our pair: no connection, no reload; the game here goes on, the panel says why.
      hangUp();
      status.textContent = message;
      return;
    }
    await pc.setRemoteDescription(answer);
    // The reply is in (over the Wi-Fi in the normal case): the scan button would only re-read the
    // same code, so it goes away and the panel says what is happening now.
    answered = true;
    if (stopScan) stopScan();
    stopScan = null;
    showReplyStep();
    status.textContent = t("connecting");
    const accepted = pc;
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      if (pc === accepted && pc.connectionState !== "connected" && !document.body.classList.contains("linked")) connectFailed();
    }, CONNECT_WAIT_MS);
  } catch (e) {
    status.textContent = e.message || String(e);
  }
}

// The guest is connected (WebRTC data channel or PairInbox TCP channel; channelIO takes either):
// the ROM goes out, then the state, and both phones play. `e` / `native`: what runs here (start()).
function linkUp(channel, e, native) {
  stopInbox();
  closePanel();
  document.body.classList.add("linked");
  toast(t("p2Connected"));
  const { game, rom } = currentGame();
  io = channelIO(
    channel,
    (msg, bytes) => {
      if (!sync) return; // a late message after hangUp
      if (msg.t === "booted") {
        startup.got("booted");
        // The native lockstep resolves once the state's last chunk is queued; then the guest has
        // 30 s to answer `ready`. The EJS resync returns nothing and has no timeout.
        Promise.resolve(sync.resync())
          .then(() => startup && startup.expect("ready"))
          .catch(() => {
            // getStateBase64 or the send failed: don't stay frozen for a ready that cannot come.
            if (io) io.send({ t: "abort", reason: "state" });
            toast(nt("guestStartFailed"));
            hangUp();
          });
      } else if (msg.t === "abort") {
        // The guest could not start the game, or could not load a resync's state (or gave up):
        // back to single player here.
        toast(sync.resyncs > 0 ? nt("resyncFailed", { code: msg.reason || "abort" }) : nt("guestStartFailed"));
        hangUp();
      } else {
        if (msg.t === "ready") {
          startup.got("ready");
          io.armHeartbeat(); // the game runs on both phones: 5 s of silence now ends the link
        }
        sync.onMessage(msg, bytes);
      }
    },
    { native: !!native, onLost: lost },
  );
  sync = createLockstep(e, io, true, (waiting) => waiting && toast(t("waitingP2")));
  // Native only (N1-b, lockstep-native.js): a checksum mismatch resends the state with the next
  // epoch; the guest then has 30 s to answer `ready`, as at game start. A state that cannot be
  // taken or sent, or a fourth resync within a minute, ends the link (the guest gets `abort`).
  sync.onResyncSent = () => startup && startup.expect("ready");
  sync.onResynced = () => toast(nt("resynced")); // the guest answered ready: both phones run again
  sync.onResyncFailed = (err) => {
    if (io) io.send({ t: "abort", reason: "state" });
    toast(nt("resyncFailed", { code: err?.code || "state" }));
    hangUp();
  };
  sync.onUnstable = () => {
    if (io) io.send({ t: "abort", reason: "unstable" });
    toast(nt("unstableLink"));
    hangUp();
  };
  sync.attach();
  // Freeze until the guest has loaded the game and the same savestate.
  sync.setHold(true);
  // Native only: a guest that never boots (or never answers a resync) must not leave the host
  // frozen (NETPLAY.md §7).
  startup = startupTimeout(!!native, (name) => {
    io.send({ t: "abort", reason: "timeout" });
    toast(name === "ready" && sync && sync.resyncs > 0 ? nt("resyncFailed", { code: "timeout" }) : nt("guestStartFailed"));
    hangUp();
  });
  // Library ROMs are stored as Blobs or ArrayBuffers.
  new Blob([rom])
    .arrayBuffer()
    .then((buf) => io.sendBytes({ t: "rom", name: game.name, file: game.file, core: game.core }, new Uint8Array(buf)))
    .then(() => startup && startup.expect("booted"));
}

function guestLeft() {
  if (document.body.classList.contains("linked")) toast(t("p2Left"));
  hangUp();
}

// The guest connected over the PairInbox TCP channel (NETPLAY.md §12): no WebRTC for this pair.
// A channel that comes after the link is up (e.g. WebRTC won) is closed.
function tcpUp(ch, e, native) {
  if (io || !pc) return ch.close();
  link = ch;
  ch.onclose = guestLeft;
  if (rtc) rtc.onopen = rtc.onclose = null;
  rtc = null;
  pc.onconnectionstatechange = null;
  pc.close();
  pc = null;
  linkUp(ch, e, native);
}

async function start() {
  const e = emulator();
  const native = nativeSession();
  if (!e && !native) return toast(t("stillLoading"));
  // The button stays on screen during two-phone play; a stray tap must not cut player 2 off.
  if (sync) return toast(t("p2AlreadyConnected"));
  hangUp();
  panel.classList.remove("hidden");
  status.textContent = t("preparing");
  myPeer = await localPeer({ plugin: native, system: currentGame()?.game?.core || window.nbNative?.game?.core });

  // The guest replies over the Wi-Fi, so only the guest scans a code. Without that inbox (web, or
  // listening failed) the host scans the guest's reply instead.
  inbox = await listenForAnswer((ufrag, code) => {
    if (pc && pc.localDescription && ufrag === iceUfrag(pc.localDescription.sdp)) accept(code);
  });
  // Native host whose PairInbox can take a channel: the invite says so (peer tcp flag) and a native
  // guest connects over TCP with the offer's ICE ufrag as the token. The listener stays until hangUp.
  // (An EJS host never gets one: guests only try TCP with a native host, tcp-channel.js shouldTryTcp.)
  if (native && inbox && inbox.info && hasChannels()) {
    tcpAccept = await acceptChannel({
      plugin: pairInbox(),
      token: () => (pc && pc.localDescription ? iceUfrag(pc.localDescription.sdp) : ""),
      onOpen: (ch) => tcpUp(ch, e, native),
    }).catch(() => null);
    if (tcpAccept) myPeer.tcp = true;
  }
  status.textContent = t("cameraOpening");
  // Camera first, even when nothing is scanned here: while it runs, iOS and Android let WebRTC use
  // the phone's LAN address, and without that the phones never connect. It stays on (hidden when
  // the reply comes over the Wi-Fi) until the guest is connected.
  try {
    camera = await openCamera($("#link-cam"));
  } catch {
    status.textContent = t("hostNoCamera");
  }
  showReplyStep();

  pc = createPeer();
  const channel = pc.createDataChannel("link", { ordered: true });
  rtc = channel;
  channel.onopen = () => linkUp(channel, e, native);
  channel.onclose = guestLeft;
  pc.onconnectionstatechange = () => {
    if (pc && pc.connectionState === "failed") {
      connectFailed();
      if (document.body.classList.contains("linked")) lost();
    }
  };

  await pc.setLocalDescription(await pc.createOffer());
  await gatheringDone(pc);
  const code = await encodeDescription(pc.localDescription, inbox && inbox.info, myPeer);
  await drawQR($("#link-qr"), code);
  $("#link-share").onclick = () =>
    shareInvite("join", code)
      .then((r) => r && r.copied && toast(t("inviteCopied")))
      .catch(() => {});
  if (inbox && inbox.info) {
    status.textContent = t("hostWaitHint");
    // If the Wi-Fi reply doesn't arrive, the guest shows it as a code; this button scans it. Once a
    // reply is in, the button is hidden (showReplyStep) and a late tap only refreshes that.
    const offered = pc;
    $("#link-scan").onclick = () => {
      if (pc !== offered || !camera || stopScan || answered) return showReplyStep();
      stopScan = scanQR($("#link-cam"), accept);
      showReplyStep();
      status.textContent = t("hostScanHint");
    };
  } else if (camera) {
    status.textContent = t("hostScanHint");
    stopScan = scanQR($("#link-cam"), accept);
  }
  showReplyStep();
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
