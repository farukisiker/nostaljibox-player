// SPDX-License-Identifier: GPL-3.0-or-later
// Run with: node --test native/agents/fable/js/
import test from "node:test";
import assert from "node:assert/strict";
import { once, latch } from "./guards.js";

test("once: onLost, onclose and ICE failed together end the link a single time", () => {
  const toasts = [];
  const end = once((msg) => toasts.push(msg));
  end("Connection lost"); // heartbeat
  end("Lost the connection to the host phone"); // channel.onclose
  end("Connection lost"); // ICE failed
  assert.deepEqual(toasts, ["Connection lost"]);
  assert.equal(end.done, true);
  assert.equal(end("again"), undefined);
});

test("latch: a second offer while the first is still being decoded is dropped; release allows a retry", async () => {
  const offering = latch();
  const started = [];
  let resolveDecode;
  const decode = () => new Promise((r) => (resolveDecode = r));
  async function onOffer(code) {
    if (!offering.take()) return;
    started.push(code);
    await decode(); // decodeDescription + guestBackend(isAvailable) run here
  }
  const first = onOffer("NB3:AAA");
  onOffer("NB3:AAA"); // the camera scans the same QR again
  onOffer("NB3:BBB"); // a pasted link while decoding
  assert.deepEqual(started, ["NB3:AAA"]);
  assert.equal(offering.held, true);
  resolveDecode();
  await first;
  assert.equal(offering.held, true); // success keeps it: one connection per page
  offering.release(); // the error / mismatch path
  const third = onOffer("NB3:CCC");
  assert.deepEqual(started, ["NB3:AAA", "NB3:CCC"]);
  resolveDecode();
  await third;
});
