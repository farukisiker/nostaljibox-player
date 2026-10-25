// SPDX-License-Identifier: MIT — part of nostaljibox-player/shared, usable outside the GPL player.
// Minimal ZIP reader: lists entry names from the central directory.
function centralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP dosyası okunamadı.");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    entries.push({
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      method: view.getUint16(p + 10, true),
      compSize: view.getUint32(p + 20, true),
      localOff: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { view, entries };
}

export function listZipEntries(bytes) {
  return centralDirectory(bytes)
    .entries.map((e) => e.name)
    .filter((n) => !n.endsWith("/"));
}
