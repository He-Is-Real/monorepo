/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripMediaMetadata } from './strip-media-metadata';

// M2 (Joel, 2026-11-06): a video's or audio file's location and device never leave the device.
// The fixtures are tiny files ffmpeg wrote with a location (+51.5074-000.1278/) and a phone's make
// and model, as QuickTime keys (`com.apple.quicktime.*`), plain tags and `loci`: a MOV with its
// index (`moov`) after the media, an MP4 with it first, and an M4A. Shapes ffmpeg can't write
// (Apple's `meta` straight in `moov`, Android's `©xyz`, XMP, 64-bit sizes) are built here.

const LOCATION = ['51.5074', '000.1278', 'ISO6709', 'loci', '©xyz'];
const DEVICE = ['TestPhone', '©mak', '©mod'];
const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));
const has = (bytes: Uint8Array, text: string) =>
  Buffer.from(bytes).includes(Buffer.from(text, 'latin1'));

interface Found {
  type: string;
  start: number;
  end: number;
}
/** Every box, walking into the ones that hold boxes (as a player reads the file). */
function boxes(b: Uint8Array, start = 0, end = b.length, out: Found[] = []) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = start; at < end;) {
    let size = v.getUint32(at);
    let header = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(at + 8));
      header = 16;
    }
    if (size === 0) size = end - at;
    expect(size).toBeGreaterThanOrEqual(header);
    expect(at + size).toBeLessThanOrEqual(end);
    const type = Buffer.from(b.subarray(at + 4, at + 8)).toString('latin1');
    out.push({ type, start: at, end: at + size });
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta'].includes(type)) {
      boxes(b, at + header, at + size, out);
    }
    at += size;
  }
  return out;
}

async function strip(bytes: Uint8Array, type = 'video/mp4') {
  const out = await stripMediaMetadata(new Blob([bytes], { type }));
  return new Uint8Array(await out.arrayBuffer());
}

/** The bytes that changed lie only in metadata boxes of the original, now `free`. */
function changedOnlyMetadata(before: Uint8Array, after: Uint8Array) {
  expect(after.length).toBe(before.length);
  const metadata = boxes(before).filter((x) =>
    ['udta', 'meta', 'uuid'].includes(x.type),
  );
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      expect(metadata.some((m) => m.start <= i && i < m.end)).toBe(true);
    }
  }
  // The same boxes in the same places, metadata ones now `free`; media and index untouched.
  const kept = boxes(after);
  expect(kept.map((x) => [x.start, x.end])).toEqual(
    boxes(before)
      .filter(
        (x) => !metadata.some((m) => m.start < x.start && x.start < m.end),
      )
      .map((x) => [x.start, x.end]),
  );
  const outermost = metadata.filter(
    (m) => !metadata.some((o) => o.start < m.start && m.start < o.end),
  );
  for (const m of outermost) {
    expect(kept.find((x) => x.start === m.start)?.type).toBe('free');
  }
}

describe('a phone’s video or audio file loses its location and device before upload', () => {
  it.each([
    ['phone.mov', 'video/quicktime', 'its index after the media'],
    ['faststart.mp4', 'video/mp4', 'its index first'],
    ['voice.m4a', 'audio/mp4', 'audio'],
  ])('%s (%s, %s)', async (name, type) => {
    const before = fixture(name);
    expect([...LOCATION, ...DEVICE].filter((t) => has(before, t))).toEqual(
      expect.arrayContaining(['51.5074', 'ISO6709', 'loci', 'TestPhone']),
    );
    const after = await strip(before, type);
    expect([...LOCATION, ...DEVICE].filter((t) => has(after, t))).toEqual([]);
    changedOnlyMetadata(before, after);
    // Still a file a player reads: the index with its header and tracks, and all of the media.
    const kept = boxes(after).map((x) => x.type);
    expect(kept).toEqual(
      expect.arrayContaining(['moov', 'mvhd', 'trak', 'mdat']),
    );
  });

  // Built by hand: the shapes phones write that ffmpeg doesn't.
  const box = (type: string, ...parts: (Uint8Array | string)[]) => {
    const body = Buffer.concat(
      parts.map((p) =>
        typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p),
      ),
    );
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length);
    head.write(type, 4, 'latin1');
    return new Uint8Array(Buffer.concat([head, body]));
  };
  const bigBox = (type: string, body: Uint8Array) => {
    const head = Buffer.alloc(16);
    head.writeUInt32BE(1);
    head.write(type, 4, 'latin1');
    head.writeBigUInt64BE(BigInt(16 + body.length), 8);
    return new Uint8Array(Buffer.concat([head, Buffer.from(body)]));
  };
  const xmp = Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex');
  const media = new Uint8Array(4096).map((_, i) => (i * 31) % 251);

  it('an iPhone’s and an Android phone’s shapes, XMP and a 64-bit media box', async () => {
    const before = new Uint8Array(
      Buffer.concat([
        box('ftyp', 'qt  \0\0\0\0qt  '),
        bigBox('mdat', media),
        box(
          'moov',
          box('mvhd', new Uint8Array(100)),
          box(
            'trak',
            box('tkhd', new Uint8Array(84)),
            box('udta', box('©mak', 'TestPhone')),
          ),
          // Apple: `meta` straight in `moov`, with keys and their values.
          box(
            'meta',
            box('hdlr', '\0\0\0\0\0\0\0\0mdta'),
            box(
              'keys',
              'com.apple.quicktime.location.ISO6709',
              'com.apple.quicktime.make',
            ),
            box(
              'ilst',
              box('data', '+51.5074-000.1278/'),
              box('data', 'TestPhone'),
            ),
          ),
          // Android: `©xyz` in `udta`.
          box(
            'udta',
            box('©xyz', '+51.5074-000.1278/'),
            box('©mod', 'TestPhone 9'),
          ),
        ),
        box('uuid', xmp, '<x:xmpmeta>exif:GPSLatitude 51.5074</x:xmpmeta>'),
        box('meta', '\0\0\0\0', box('ilst', 'TestPhone')),
      ]),
    );
    const after = await strip(before);
    expect([...LOCATION, ...DEVICE].filter((t) => has(after, t))).toEqual([]);
    changedOnlyMetadata(before, after);
    expect(Buffer.from(after).includes(Buffer.from(media))).toBe(true);
  });

  it('a file with no metadata, or one that isn’t an MP4, MOV or M4A, uploads as it is', async () => {
    const clean = new Blob([
      box('ftyp', 'isom\0\0\0\0isom'),
      box('moov', box('mvhd', new Uint8Array(100))),
      box('mdat', media),
    ]);
    expect(await stripMediaMetadata(clean)).toBe(clean);
    for (const start of [
      'RIFF\x24\0\0\0WAVEfmt ',
      'ID3\x04\0\0\0\0\0\0',
      '\x1aE\xdf\xa3\x9fB\x86\x81',
    ]) {
      const other = new Blob([Buffer.from(start, 'latin1'), media]);
      expect(await stripMediaMetadata(other)).toBe(other);
    }
    // Boxes that don't add up (the index runs past the end): left as it is.
    const cut = fixture('phone.mov').subarray(0, 4000);
    const broken = new Blob([cut]);
    expect(await stripMediaMetadata(broken)).toBe(broken);
  });
});
