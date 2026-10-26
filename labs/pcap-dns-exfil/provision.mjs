import fs from 'node:fs';
import path from 'node:path';
import { flagFor } from '../_shared/appkit.mjs';
import { HOME, briefing, emit, evidenceReadme, write } from '../_shared/provision-helpers.mjs';

const LAB_DIR = process.env.CF_LAB_DIR ?? '/lab';

const SECRET = process.env.CF_SESSION_SECRET ?? '';
const flag = flagFor(SECRET, 'pcap-dns-exfil', 'exfil-token');
const hex = Buffer.from(flag).toString('hex');
// DNS labels max out at 63 octets, so the payload is split into safe chunks.
const labels = hex.match(/.{1,50}/g);

/** Minimal, real libpcap writer (Ethernet + IPv4 + UDP + DNS query). */
function dnsPacket(name, id) {
  const labelsBytes = [];
  for (const label of name.split('.')) {
    labelsBytes.push(Buffer.from([label.length]), Buffer.from(label));
  }
  labelsBytes.push(Buffer.from([0]));
  const qname = Buffer.concat(labelsBytes);
  const dns = Buffer.concat([
    Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    qname,
    Buffer.from([0x00, 0x01, 0x00, 0x01]),
  ]);
  const udp = Buffer.alloc(8);
  udp.writeUInt16BE(49152 + (id % 1000), 0);
  udp.writeUInt16BE(53, 2);
  udp.writeUInt16BE(dns.length + 8, 4);
  const ip = Buffer.alloc(20);
  ip[0] = 0x45;
  ip.writeUInt16BE(20 + udp.length + dns.length, 2);
  ip.writeUInt16BE(id, 4);
  ip[8] = 64;
  ip[9] = 17;
  Buffer.from([10, 20, 0, 15]).copy(ip, 12);
  Buffer.from([10, 20, 0, 53]).copy(ip, 16);
  let sum = 0;
  for (let i = 0; i < 20; i += 2) sum += ip.readUInt16BE(i);
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  ip.writeUInt16BE(~sum & 0xffff, 10);
  const eth = Buffer.concat([
    Buffer.from([0x00, 0x16, 0x3e, 0x11, 0x22, 0x33]),
    Buffer.from([0x00, 0x16, 0x3e, 0x44, 0x55, 0x66]),
    Buffer.from([0x08, 0x00]),
  ]);
  return Buffer.concat([eth, ip, udp, dns]);
}

const queries = [
  'www.vela-retail.example',
  'cdn.vela-retail.example',
  `${labels[0]}.${labels[1]}.exfil.vela-retail.example`,
  'api.vela-retail.example',
  ...(labels[2] ? [`${labels[2]}.exfil.vela-retail.example`] : []),
];
const chunks = [];
for (let i = 0; i < 12; i += 1) {
  const frame = dnsPacket(i < queries.length ? queries[i] : 'telemetry.vela-retail.example', 1000 + i);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(1761186000 + i, 0);
  header.writeUInt32LE(i * 137000, 4);
  header.writeUInt32LE(frame.length, 8);
  header.writeUInt32LE(frame.length, 12);
  chunks.push(header, frame);
}
const global = Buffer.alloc(24);
global.writeUInt32LE(0xa1b2c3d4, 0);
global.writeUInt16LE(2, 4);
global.writeUInt16LE(4, 6);
global.writeUInt32LE(0, 8);
global.writeUInt32LE(0, 12);
global.writeUInt32LE(65535, 16);
global.writeUInt32LE(1, 20);
fs.mkdirSync(path.join(HOME, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'artifacts/capture.pcap'), Buffer.concat([global, ...chunks]));
write(
  'artifacts/README.txt',
  'A short packet capture from the egress sensor (libpcap format).\nDNS is allowed out of the network; this sensor records it.\nLook beyond the hostnames you recognise.\n',
);
// Learner tooling: a tiny real parser so the task is about analysis, not plumbing.
const helper = fs.readFileSync(path.join(LAB_DIR, 'pcap-dns-exfil/tools/dnsq.py'), 'utf8');
write('tools/dnsq.py', helper, 0o755);

briefing({
  Organization: 'Vela Retail',
  Artifact: '~/artifacts/capture.pcap',
  Mission: 'Analyse DNS traffic for data exfiltration, decode the payload and submit the token.',
  Helper: 'python3 ~/tools/dnsq.py ~/artifacts/capture.pcap lists the DNS queries.',
  Evidence: 'Write ~/evidence/dns-exfil.json with exfilDomain, encodedLabels, decodedFlag and notes.',
});
evidenceReadme('Vela DNS exfiltration', 'Create dns-exfil.json: {"exfilDomain": "exfil.vela-retail.example", "encodedLabels": ["..."], "decodedFlag": "CF{...}", "notes": "..."}');
emit({ 'exfil-token': flag });
