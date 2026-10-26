#!/usr/bin/env python3
"""List DNS queries from a libpcap capture (training helper).

Usage: python3 ~/tools/dnsq.py ~/artifacts/capture.pcap
Only Ethernet/IPv4/UDP/port-53 question names are decoded.
"""
import struct
import sys


def read_pcap(path):
    data = open(path, 'rb').read()
    magic = struct.unpack('<I', data[:4])[0]
    if magic not in (0xA1B2C3D4, 0xD4C3B2A1):
        raise SystemExit('not a libpcap file')
    # d4 c3 b2 a1 on disk == 0xA1B2C3D4 when read little-endian.
    little = magic == 0xA1B2C3D4
    off = 24
    frames = []
    while off + 16 <= len(data):
        incl = struct.unpack('<I' if little else '>I', data[off + 8:off + 12])[0]
        off += 16
        if incl <= 0 or off + incl > len(data):
            break
        frames.append(data[off:off + incl])
        off += incl
    return frames


def dns_name(frame):
    if len(frame) < 42 or frame[12:14] != b'\x08\x00':
        return None
    ihl = (frame[14] & 0x0F) * 4
    if frame[23] != 17:  # UDP
        return None
    start = 14 + ihl + 8 + 12
    labels, p = [], start
    while p < len(frame) and len(labels) < 32:
        n = frame[p]
        p += 1
        if n == 0 or n & 0xC0:
            break
        labels.append(frame[p:p + n].decode('latin1'))
        p += n
    return '.'.join(labels) if labels else None


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    for frame in read_pcap(sys.argv[1]):
        name = dns_name(frame)
        if name:
            print(name)


if __name__ == '__main__':
    main()
