// SPDX-License-Identifier: GPL-3.0-or-later
// Guest side of two-phone play: pairs with the host phone by QR code, receives the game from it
// (never added to the library; the native player keeps a copy on disk under `nostaljibox-link`
// until the next join, NETPLAY.md §5) and runs it in lockstep as player 2.
import {
  createPeer, gatheringDone, encodeDescription, decodeDescription, drawQR, openCamera, stopCamera, scanQR,
  shareInvite, pasteCode, findCode, onInviteLink, sendAnswer,
} from "../shared/link.js";
import { channelIO, createLockstep } from "./lockstep.js";
import { toast } from "./host-link.js";
import { t } from "../shared/i18n.js";
import { guestBackend, pairingProblem, describePeer, BACKEND_NATIVE } from "../native/agents/fable/js/peer-block.js";
import { startupTimeout } from "../native/agents/fable/js/startup-timeout.js";
import { nt } from "../native/agents/fable/js/strings.js";
import { once, latch } from "../native/agents/fable/js/guards.js";
import { startGuestGame } from "../native/agents/fable/js/native-guest.js";

const $ = (s) => document.querySelector(s);
// After the reply went over the Wi-Fi, ICE has this long to connect before the reply is also shown
// as a code (the host applied it already in the normal case, so this mostly means the phones
// cannot reach each other; WebKit's own "failed" says so when it comes).
const CONNECT_WAIT_MS = 20000;

// boot(game, rom, onStart) starts EmulatorJS; onStart gets it once the game runs.
// hooks.bootNative(game, bytes, { onStarted, onError }) starts the native player instead (N0-f,
// native-guest.js: deleteGame("nostaljibox-link"), start with persistSRAM:false, lockstepHold(true)
// once it runs, then onStarted(plugin); onError(code) when it cannot). hooks.stopNative() ends that
// session when the link does. Without the hooks the guest is an EJS peer, as today, and a native
// host refuses it before the connection is made.
export function setupGuestLink(boot, hooks = {}) {
  const status = $("#join-status");
  let pc = null;
  let camera = null;
  let stopScan = null;
  let sync = null;
  let io = null;
  let startup = null;
  let myPeer = null;
  let native = false;

  document.body.classList.add("guest");
  $("#join").classList.remove("hidden");

  function leave(msg) {
    toast(msg);
    setTimeout(() => (location.href = "../index.html"), 2500);
  }

  // Every end of the link: lockstep off (native: lockstepStop), timers off, then the library.
  // Once only: onLost, onclose and ICE "failed" can all fire for the same lost link.
  const end = once((msg) => {
    if (sync) sync.detach();
    sync = null;
    if (startup) startup.clear();
    if (io) io.close();
    if (!native && window.EJS_emulator && window.EJS_emulator.pause) window.EJS_emulator.pause();
    if (native && hooks.stopNative) hooks.stopNative(); // the game must not run on alone until the library loads
    leave(msg);
  });

  // This phone could not start or keep the game: tell the host, then go back.
  function abort(reason, msg) {
    if (io) io.send({ t: "abort", reason });
    end(msg);
  }

  function onChannel(channel) {
    // Native only (NETPLAY.md §7): 30 s from the ROM's last chunk to `started`, and from `booted`
    // to the host's state. EJS boots and transfers have no fixed limit.
    startup = startupTimeout(native, () => abort("timeout", nt("startTimeout")));
    io = channelIO(
      channel,
      (msg, bytes) => {
        if (msg.t === "rom") {
          $("#join").classList.add("hidden");
          toast(t("loadingGame"));
          const game = { name: msg.name, file: msg.file, core: msg.core };
          const started = (target) => {
            startup.got("started");
            sync = createLockstep(target, io, false, (waiting) => waiting && toast(t("waitingHost")));
            // Native: a state the core rejects (`state-mismatch`, …) ends it now, not after the
            // host's 30 s timeout; at game start as "could not open", on a resync as "could not
            // re-sync" (N1-b).
            sync.onLoadFailed = (err, resync) => {
              const code = err?.code || "load";
              abort(code, resync ? nt("resyncFailed", { code }) : nt("guestBootFailed", { code }));
            };
            sync.attach();
            sync.setHold(true);
            io.send({ t: "booted" });
            startup.expect("state");
            document.body.classList.add("linked");
            toast(t("youArePlayer2"));
          };
          if (native) startup.expect("started");
          startGuestGame({
            native,
            game,
            bytes,
            boot,
            bootNative: hooks.bootNative,
            onStarted: started,
            // Native could not open or keep the game: no EmulatorJS here (the host would not pair
            // with it), tell the host and go back to the library.
            onError: (code) => abort(code, nt("guestBootFailed", { code })),
            onEjsStarted: () => io.armHeartbeat(), // EJS guest: the game runs from here (the native one arms at lockstepStart)
          });
        } else if (msg.t === "abort") {
          // The host gave up: after too many resyncs ("unstable"), else as a lost connection.
          end(msg.reason === "unstable" ? nt("unstableLink") : nt("connectionLost"));
        } else if (sync) {
          if (msg.t === "state") startup.got("state");
          sync.onMessage(msg, bytes);
        }
      },
      { native, onLost: () => end(nt("connectionLost")) },
    );
    status.textContent = t("receivingGame");
    channel.onclose = () => end(t("hostLeft"));
  }

  // One offer at a time: the latch is taken before the first await, so a repeated scan or link
  // while this one is still being decoded cannot open a second connection.
  const offering = latch();
  async function onOffer(code) {
    if (pc || !offering.take()) return;
    if (stopScan) stopScan();
    try {
      const offer = await decodeDescription(code);
      // Same backend and version on both phones, or no game (NETPLAY.md §1.1): decided here,
      // before any answer goes out.
      myPeer = await guestBackend(offer.peer, { canBootNative: typeof hooks.bootNative === "function" });
      native = myPeer.backend === BACKEND_NATIVE;
      if (pairingProblem(myPeer, offer.peer)) {
        const words = { ejs: nt("backendEjs"), old: nt("backendOld") };
        stopCamera(camera);
        $("#join-scan").classList.add("hidden");
        status.textContent = nt("peerMismatch", { mine: describePeer(myPeer, words), theirs: describePeer(offer.peer, words) });
        offering.release(); // a pasted invite from a matching phone may still follow
        return; // #back ("Back to library") stays on screen
      }
      status.textContent = t("preparingConnection");
      pc = createPeer();
      pc.ondatachannel = (ev) => onChannel(ev.channel);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
          status.textContent = `${t("connectFailed")} ${nt("sameNetworkHint")}`;
          if (document.body.classList.contains("linked")) end(nt("connectionLost"));
        }
      };
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await gatheringDone(pc);
      // The host's inbox addresses say which of this phone's addresses are on the shared network
      // (a hotspot owner has cellular, VPN and link-local ones too): those candidates go first.
      const answer = await encodeDescription(pc.localDescription, null, myPeer, offer.inbox?.ips || null);
      stopCamera(camera);
      $("#join-scan").classList.add("hidden");
      // Hand the answer to the host over the Wi-Fi; show it as a code only if that fails, or if
      // the phones still have not connected a while later.
      const showAnswer = async () => {
        $("#join-answer").classList.remove("hidden");
        await drawQR($("#join-qr"), answer);
        $("#join-share").onclick = () =>
          shareInvite("answer", answer)
            .then((r) => r && r.copied && toast(t("replyCopied")))
            .catch(() => {});
        status.textContent = t("showReplyHint");
      };
      status.textContent = t("sendingReply");
      // Up to ~20 s: all of the host's addresses at once, and a second try after the iOS Local
      // Network prompt (shared/link.js sendAnswer).
      if (await sendAnswer(offer.inbox, offer.ufrag, answer)) {
        status.textContent = t("connecting");
        const sent = pc;
        setTimeout(() => {
          if (pc === sent && pc.connectionState !== "connected" && pc.connectionState !== "failed") showAnswer();
        }, CONNECT_WAIT_MS);
      } else {
        await showAnswer();
      }
    } catch (e) {
      status.textContent = e.message || String(e);
      pc = null;
      offering.release();
    }
  }

  $("#join-paste").addEventListener("input", (ev) => {
    const code = findCode(ev.target.value);
    if (code) onOffer(code);
  });
  $("#join-from-clipboard").addEventListener("click", async () => {
    const code = await pasteCode().catch(() => null);
    if (code) onOffer(code);
    else toast(t("noInviteCode"));
  });
  onInviteLink(({ kind, code }) => {
    if (kind === "join") onOffer(code);
    else toast(t("thisIsReply"));
  });

  (async () => {
    try {
      const stream = await openCamera($("#join-cam"));
      // The invite may have been pasted while the camera was starting; don't scan during the game.
      if (pc) return stopCamera(stream);
      camera = stream;
      stopScan = scanQR($("#join-cam"), onOffer);
    } catch {
      status.textContent = t("guestNoCamera");
    }
  })();

  window.addEventListener("pagehide", () => {
    stopCamera(camera);
    if (io) io.close();
    if (pc) pc.close();
    if (native && hooks.stopNative) hooks.stopNative();
  });
}
