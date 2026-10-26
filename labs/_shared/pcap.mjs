/**
 * Minimal libpcap reader used by the DNS-exfiltration lab.
 * Supports Ethernet + IPv4 + UDP + DNS question parsing only; this is a
 * training capture, not a general-purpose packet parser.
 */
export function parseDnsNames(buf) {
  const names = [];
  if (buf.length < 24) return names;
  // A little-endian capture starts with d4 c3 b2 a1, which reads as 0xa1b2c3d4.
  const magic = buf.readUInt32LE(0);
  if (magic !== 0xa1b2c3d4 && magic !== 0xd4c3b2a1) return names;
  const littleEndian = magic === 0xa1b2c3d4;
  let offset = 24;
  while (offset + 16 <= buf.length) {
    const ts = buf.readUInt32LE(offset);
    const incl = littleEndian ? buf.readUInt32LE(offset + 8) : buf.readUInt32BE(offset + 8);
    offset += 16;
    if (incl <= 0 || offset + incl > buf.length) break;
    const frame = buf.subarray(offset, offset + incl);
    offset += incl;
    if (frame.length < 34) continue;
    const ethType = frame.readUInt16BE(12);
    if (ethType !== 0x0800) continue;
    const ipStart = 14;
    const ihl = (frame[ipStart] & 0x0f) * 4;
    if (frame[ipStart + 9] !== 17) continue;
    const dnsStart = ipStart + ihl + 8;
    if (frame.length < dnsStart + 13) continue;
    let p = dnsStart + 12;
    const labels = [];
    let guard = 0;
    while (p < frame.length && guard < 32) {
      const len = frame[p];
      p += 1;
      if (len === 0) break;
      if (len & 0xc0) break; // compression pointer: not used in queries here
      labels.push(frame.subarray(p, p + len).toString('latin1'));
      p += len;
      guard += 1;
    }
    if (labels.length) names.push({ name: labels.join('.'), labels, ts });
  }
  return names;
}

/** Extracts the hex payload labels that belong to a given exfiltration domain. */
export function exfilLabels(names, suffix) {
  const out = [];
  for (const entry of names) {
    if (!entry.name.endsWith(suffix)) continue;
    const head = entry.labels.slice(0, entry.labels.length - suffix.split('.').length);
    for (const label of head) if (/^[0-9a-f]{8,}$/.test(label)) out.push(label);
  }
  return out;
}
