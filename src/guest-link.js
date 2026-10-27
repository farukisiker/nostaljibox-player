// SPDX-License-Identifier: GPL-3.0-or-later
// Guest side of two-phone play: pairs with the host phone by QR code, receives the game from it
// (kept in memory only, never added to the library) and runs it in lockstep as player 2.
import {
  createPeer, gatheringDone, encodeDescription, decodeDescription, drawQR, openCamera, stopCamera, scanQR,
  shareInvite, pasteCode, findCode, onInviteLink,
} from "../shared/link.js";
import { channelIO, Lockstep } from "./lockstep.js";
import { toast } from "./host-link.js";
import { t } from "../shared/i18n.js";

const $ = (s) => document.querySelector(s);

// boot(game, rom, onStart) starts the emulator; onStart gets it once the game runs.
export function setupGuestLink(boot) {
  const status = $("#join-status");
  let pc = null;
  let camera = null;
  let stopScan = null;
  let sync = null;

  document.body.classList.add("guest");
  $("#join").classList.remove("hidden");

  function onChannel(channel) {
    const io = channelIO(channel, (msg, bytes) => {
      if (msg.t === "rom") {
        $("#join").classList.add("hidden");
        toast(t("loadingGame"));
        boot({ name: msg.name, file: msg.file, core: msg.core }, new Blob([bytes]), (emu) => {
          sync = new Lockstep(emu, io, false, (waiting) => waiting && toast(t("waitingHost")));
          sync.attach();
          sync.setHold(true);
          io.send({ t: "booted" });
          document.body.classList.add("linked");
          toast(t("youArePlayer2"));
        });
      } else if (sync) {
        sync.onMessage(msg, bytes);
      }
    });
    status.textContent = t("receivingGame");
    channel.onclose = () => {
      if (sync) sync.detach();
      sync = null;
      if (window.EJS_emulator && window.EJS_emulator.pause) window.EJS_emulator.pause();
      toast(t("hostLeft"));
      setTimeout(() => (location.href = "../index.html"), 2500);
    };
  }

  async function onOffer(code) {
    if (pc) return;
    if (stopScan) stopScan();
    try {
      const offer = await decodeDescription(code);
      status.textContent = t("preparingConnection");
      pc = createPeer();
      pc.ondatachannel = (ev) => onChannel(ev.channel);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") status.textContent = t("connectFailed");
      };
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await gatheringDone(pc);
      const answer = await encodeDescription(pc.localDescription);
      stopCamera(camera);
      $("#join-scan").classList.add("hidden");
      $("#join-answer").classList.remove("hidden");
      await drawQR($("#join-qr"), answer);
      $("#join-share").onclick = () =>
        shareInvite("answer", answer)
          .then((r) => r && r.copied && toast(t("replyCopied")))
          .catch(() => {});
      status.textContent = t("showReplyHint");
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
    if (pc) pc.close();
  });
}
