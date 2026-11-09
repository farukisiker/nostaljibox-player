// SPDX-License-Identifier: GPL-3.0-or-later
// Two native iPhones exchange the game's data over a TCP link of the PairInbox plugin instead of a
// WebRTC data channel (NETPLAY.md §12). On a Personal Hotspot owner WKWebView's WebRTC only gathers
// the cellular route, so ICE never connects; Network.framework TCP works there in both directions.
// EmulatorJS/Android pairs, and native pairs with an older app, stay on WebRTC.
//
// Plugin surface (ios/App/App/PairInbox.swift): connect({ hosts, port, token, timeoutMs }) → { id }
// (guest), channelSend({ id, text }), channelSendBase64({ id, data }), channelClose({ id }); events
// channelOpen { id, token } (host), channelText { id, text }, channelBytes { id, data },
// channelClose { id, reason }.
//
// tcpChannel() looks like an RTCDataChannel to channelIO (src/lockstep.js), which wraps it unchanged.
import { toBase64, fromBase64 } from "../../fable/js/lockstep-native.js";
import { rankLanIps, isTimeout } from "../../fable/js/pair-net.js";
import { BACKEND_NATIVE } from "../../fable/js/peer-block.js";

export const CHANNEL_METHODS = ["connect", "channelSend", "channelSendBase64", "channelClose"];
export const LOW_THRESHOLD = 256 * 1024;
export const QUEUE_LIMIT = 256; // events kept for an id whose adapter does not exist yet
const QUEUED_IDS_LIMIT = 64;

export { isTimeout };

/**
 * True when this app's PairInbox has the channel methods: native platform and a "PairInbox" plugin
 * header listing connect, channelSend, channelSendBase64 and channelClose. False on the web, on
 * Android and in an older iPhone app (no such methods in its header).
 */
export function hasChannels(win = globalThis.window) {
  try {
    const cap = win && win.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return false;
    const headers = Array.isArray(cap.PluginHeaders) ? cap.PluginHeaders : [];
    const header = headers.find((h) => h && h.name === "PairInbox");
    const names = new Set((header && Array.isArray(header.methods) ? header.methods : []).map((m) => m && m.name));
    return CHANNEL_METHODS.every((m) => names.has(m));
  } catch {
    return false;
  }
}

// Every plugin call as a promise: Capacitor's proxy may throw (synchronously) for a method its
// header does not list.
export function call(plugin, name, ...args) {
  try {
    return Promise.resolve(plugin[name](...args));
  } catch (e) {
    return Promise.reject(e);
  }
}

// ---------- event routing (one set of plugin listeners per plugin) ----------

const registries = new WeakMap();

function registry(plugin) {
  let reg = registries.get(plugin);
  if (!reg) {
    reg = { adapters: new Map(), queued: new Map(), ready: null };
    registries.set(plugin, reg);
  }
  return reg;
}

function dispatch(reg, kind, ev) {
  const id = ev && ev.id;
  const adapter = reg.adapters.get(id);
  if (adapter) return adapter._event(kind, ev);
  // No adapter yet: data waits (bounded); a close drops the data and is remembered, so an adapter
  // made later for this id starts closed.
  let queue = reg.queued.get(id);
  if (kind === "close") queue = null;
  if (!queue) {
    queue = [];
    reg.queued.delete(id);
    reg.queued.set(id, queue);
    if (reg.queued.size > QUEUED_IDS_LIMIT) reg.queued.delete(reg.queued.keys().next().value);
  }
  if (queue.length < QUEUE_LIMIT) queue.push([kind, ev]);
}

/** Adds the plugin's channelText/channelBytes/channelClose listeners once; await it before connect/accept. */
export function ensureListeners(plugin) {
  const reg = registry(plugin);
  if (!reg.ready) {
    const route = (kind) => (ev) => dispatch(reg, kind, ev);
    reg.ready = Promise.all([
      call(plugin, "addListener", "channelText", route("text")),
      call(plugin, "addListener", "channelBytes", route("bytes")),
      call(plugin, "addListener", "channelClose", route("close")),
    ]).catch((e) => {
      reg.ready = null; // a later pairing may try again
      throw e;
    });
  }
  return reg.ready;
}

// ---------- the RTCDataChannel look-alike ----------

/**
 * The channel with this plugin id, shaped like an RTCDataChannel for channelIO: binaryType,
 * readyState ("open"/"closed"), bufferedAmount (bytes of sends the plugin has not taken yet),
 * bufferedAmountLowThreshold, add/removeEventListener ("close", "bufferedamountlow", { once }),
 * onmessage, onclose, send(string | ArrayBuffer | Uint8Array), close().
 * A remote close (or a failed send) fires the "close" event and then onclose({ reason }); a local
 * close() calls channelClose and fires the "close" event only, so hangUp is not entered again.
 */
export function tcpChannel(plugin, id) {
  const reg = registry(plugin);
  const listeners = { close: [], bufferedamountlow: [] };
  // Events that came before this adapter existed are delivered one task later, once the caller has
  // set onmessage/onclose; live events wait behind them so the order holds.
  let backlog = reg.queued.get(id) || null;
  reg.queued.delete(id);

  const emit = (type, ev) => {
    for (const entry of listeners[type].slice()) {
      if (entry.once) removeListener(type, entry.fn);
      entry.fn.call(ch, ev);
    }
  };
  const removeListener = (type, fn) => {
    const list = listeners[type];
    if (!list) return;
    const i = list.findIndex((e) => e.fn === fn);
    if (i >= 0) list.splice(i, 1);
  };
  const remoteClosed = (reason) => {
    if (ch.readyState === "closed") return;
    ch.readyState = "closed";
    if (reg.adapters.get(id) === ch) reg.adapters.delete(id);
    const ev = { type: "close", reason: String(reason || "closed") };
    emit("close", ev);
    if (typeof ch.onclose === "function") ch.onclose(ev);
  };

  const ch = {
    id,
    binaryType: "arraybuffer",
    readyState: "open",
    bufferedAmount: 0,
    bufferedAmountLowThreshold: LOW_THRESHOLD,
    onmessage: null,
    onclose: null,

    addEventListener(type, fn, options) {
      const list = listeners[type];
      if (!list || typeof fn !== "function" || list.some((e) => e.fn === fn)) return;
      list.push({ fn, once: !!(options && typeof options === "object" && options.once) });
    },
    removeEventListener: removeListener,

    send(data) {
      if (ch.readyState !== "open") return;
      let method, args, size;
      if (typeof data === "string") {
        method = "channelSend";
        args = { id, text: data };
        size = data.length;
      } else {
        const bytes = data instanceof Uint8Array
          ? data
          : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        method = "channelSendBase64";
        args = { id, data: toBase64(bytes) };
        size = bytes.byteLength;
      }
      ch.bufferedAmount += size;
      const settle = () => {
        const before = ch.bufferedAmount;
        ch.bufferedAmount = Math.max(0, before - size);
        const low = ch.bufferedAmountLowThreshold;
        if (before > low && ch.bufferedAmount <= low) emit("bufferedamountlow", { type: "bufferedamountlow" });
      };
      call(plugin, method, args).then(settle, (e) => {
        settle();
        // The plugin could not send (connection gone, "no channel"): the link is over.
        remoteClosed((e && e.message) || String(e));
      });
    },

    close() {
      if (ch.readyState === "closed") return;
      ch.readyState = "closed";
      if (reg.adapters.get(id) === ch) reg.adapters.delete(id);
      call(plugin, "channelClose", { id }).catch(() => {});
      emit("close", { type: "close", reason: "closed" });
    },

    // Plugin events routed by id (dispatch).
    _event(kind, ev) {
      if (backlog) backlog.push([kind, ev]);
      else deliver(kind, ev);
    },
  };

  const deliver = (kind, ev) => {
    if (ch.readyState !== "open") return;
    if (kind === "text") {
      if (typeof ch.onmessage === "function") ch.onmessage({ data: String(ev.text == null ? "" : ev.text) });
    } else if (kind === "bytes") {
      if (typeof ch.onmessage === "function") ch.onmessage({ data: fromBase64(ev.data).buffer });
    } else if (kind === "close") {
      remoteClosed(ev.reason);
    }
  };

  reg.adapters.set(id, ch);
  if (backlog) {
    setTimeout(() => {
      const list = backlog;
      backlog = null;
      for (const [kind, ev] of list) deliver(kind, ev);
    }, 0);
  }
  return ch;
}

// ---------- opening a channel ----------

/**
 * Guest: a channel to the host's PairInbox, or null (the caller then answers over WebRTC as before).
 * One connect() per round with all of the host's addresses (best first; the plugin tries them in
 * parallel). A round that ends in "timeout" is followed by one more: the first connection waits
 * behind the iOS Local Network prompt. Any other failure ends at once. At most ~rounds × timeoutMs.
 */
export async function openChannel({ plugin, hosts, port, token, rounds = 2, timeoutMs = 10000, onRound = null }) {
  const list = rankLanIps(hosts);
  if (!plugin || !list.length || !port || !token) return null;
  try {
    await ensureListeners(plugin);
  } catch {
    return null;
  }
  for (let round = 1; round <= rounds; round++) {
    if (onRound) onRound(round, list);
    try {
      const res = await call(plugin, "connect", { hosts: list, port, token, timeoutMs });
      return res && typeof res.id === "number" ? tcpChannel(plugin, res.id) : null;
    } catch (e) {
      if (!isTimeout(e)) return null;
    }
  }
  return null;
}

/**
 * Host: takes the first channel whose token matches (`token`: a string, or a function read when the
 * channel arrives; the invite's ICE ufrag) and hands it to onOpen(channel). Wrong tokens, channels
 * after the first, and anything after stop() are closed. Resolves { stop(), channel }; keep it until
 * hangUp so extra channels keep being closed.
 */
export async function acceptChannel({ plugin, token, onOpen }) {
  if (!plugin) return null;
  await ensureListeners(plugin);
  let channel = null;
  let stopped = false;
  const expected = () => String((typeof token === "function" ? token() : token) || "");
  const sub = await call(plugin, "addListener", "channelOpen", (ev) => {
    const id = ev && ev.id;
    const want = stopped || channel ? "" : expected();
    if (!want || !ev || ev.token !== want) {
      call(plugin, "channelClose", { id }).catch(() => {});
      return;
    }
    channel = tcpChannel(plugin, id);
    onOpen(channel);
  });
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (sub && typeof sub.remove === "function") Promise.resolve(sub.remove()).catch(() => {});
    },
    get channel() {
      return channel;
    },
  };
}

/**
 * Whether the guest tries the TCP channel for this invite: both phones native, the host's invite has
 * the tcp flag (its PairInbox accepts channels) and an inbox with addresses, the code carried the
 * ICE ufrag (compact codes do; it is the token), and this app has the channel methods.
 */
export function shouldTryTcp({ offer, myPeer, supported }) {
  return !!(
    supported &&
    myPeer && myPeer.backend === BACKEND_NATIVE &&
    offer && offer.peer && offer.peer.backend === BACKEND_NATIVE && offer.peer.tcp &&
    offer.inbox && offer.inbox.ips && offer.inbox.ips.length && offer.inbox.port &&
    offer.ufrag
  );
}
