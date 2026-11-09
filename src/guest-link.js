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

const $ = (s) => document.querySelector(s);

// boot(game, rom, onStart) starts EmulatorJS; onStart gets it once the game runs.
// hooks.bootNative(game, bytes, { onStarted, onError }) starts the native player instead (N0-f:
// deleteGame("nostaljibox-link"), start with persistSRAM:false, lockstepHold(true) at `started`,
// then onStarted(plugin); onError(code) when it cannot). Without that hook the guest is an EJS
// peer, as today, and a native host refuses it before the connection is made.
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
  function end(msg) {
    if (sync) sync.detach();
    sync = null;
    if (startup) startup.clear();
    if (io) io.close();
    if (!native && window.EJS_emulator && window.EJS_emulator.pause) window.EJS_emulator.pause();
    leave(msg);
  }

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
            sync.attach();
            sync.setHold(true);
            io.send({ t: "booted" });
            startup.expect("state");
            document.body.classList.add("linked");
            toast(t("youArePlayer2"));
          };
          if (native) {
            startup.expect("started");
            Promise.resolve()
              .then(() => hooks.bootNative(game, bytes, { onStarted: started, onError: (code) => abort(String(code), nt("guestBootFailed", { code })) }))
              .catch((e) => abort(String(e?.code || e), nt("guestBootFailed", { code: e?.code || e })));
          } else {
            boot(game, new Blob([bytes]), (emu) => {
              started(emu);
              io.armHeartbeat(); // EJS guest: the game runs from here (the native one arms at lockstepStart)
            });
          }
        } else if (msg.t === "abort") {
          end(nt("connectionLost"));
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

  async function onOffer(code) {
    if (pc) return;
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
        return; // #back ("Back to library") stays on screen
      }
      status.textContent = t("preparingConnection");
      pc = createPeer();
      pc.ondatachannel = (ev) => onChannel(ev.channel);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
          status.textContent = t("connectFailed");
          if (document.body.classList.contains("linked")) end(nt("connectionLost"));
        }
      };
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await gatheringDone(pc);
      const answer = await encodeDescription(pc.localDescription, null, myPeer);
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
      if (await sendAnswer(offer.inbox, offer.ufrag, answer)) {
        status.textContent = t("connecting");
        const sent = pc;
        setTimeout(() => {
          if (pc === sent && pc.connectionState !== "connected") showAnswer();
        }, 12000);
      } else {
        await showAnswer();
      }
    } catch (e) {
      status.textContent = e.message || String(e);
      pc = null;
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
  });
}
