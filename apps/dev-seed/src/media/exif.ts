/**
 * Writes (and reads back) a small EXIF block with a GPS position into a WebP file, so the dummy
 * images carry the kind of location metadata a phone photo does. D53: the browser strips
 * metadata before upload and the server checks before approval; these files give that check
 * something to catch. Standard library only; the EXIF is little-endian TIFF, as WebP's EXIF
 * chunk holds it (no "Exif\0\0" prefix).
 */

const TYPE = { BYTE: 1, ASCII: 2, LONG: 4, RATIONAL: 5 } as const;
const TAG = {
  imageDescription: 0x010e,
  gpsInfo: 0x8825,
  gpsVersionId: 0x0000,
  gpsLatitudeRef: 0x0001,
  gpsLatitude: 0x0002,
  gpsLongitudeRef: 0x0003,
  gpsLongitude: 0x0004,
} as const;

export interface GpsPosition {
  latitude: number;
  longitude: number;
}

/** Degrees as EXIF's three rationals: degrees, minutes, seconds (to 1/10,000 s). */
function dms(value: number): [number, number][] {
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutes = Math.floor((abs - degrees) * 60);
  const seconds = Math.round(((abs - degrees) * 60 - minutes) * 60 * 10_000);
  return [
    [degrees, 1],
    [minutes, 1],
    [seconds, 10_000],
  ];
}

/** The TIFF/EXIF bytes: an image description and a GPS position. */
export function exifBlock(description: string, gps: GpsPosition): Buffer {
  const desc = Buffer.from(`${description}\0`, 'latin1');
  const descPadded = desc.length + (desc.length % 2);
  const ifd0At = 8;
  const ifd0Size = 2 + 2 * 12 + 4;
  const descAt = ifd0At + ifd0Size;
  const gpsAt = descAt + descPadded;
  const gpsSize = 2 + 5 * 12 + 4;
  const latAt = gpsAt + gpsSize;
  const lonAt = latAt + 24;
  const out = Buffer.alloc(lonAt + 24);

  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifd0At, 4);

  let at = ifd0At;
  const entry = (
    tag: number,
    type: number,
    count: number,
    value: (b: Buffer, o: number) => void,
  ) => {
    out.writeUInt16LE(tag, at);
    out.writeUInt16LE(type, at + 2);
    out.writeUInt32LE(count, at + 4);
    value(out, at + 8);
    at += 12;
  };

  // IFD0: entries sorted by tag.
  out.writeUInt16LE(2, at);
  at += 2;
  entry(TAG.imageDescription, TYPE.ASCII, desc.length, (b, o) =>
    b.writeUInt32LE(descAt, o),
  );
  entry(TAG.gpsInfo, TYPE.LONG, 1, (b, o) => b.writeUInt32LE(gpsAt, o));
  out.writeUInt32LE(0, at); // no next IFD
  desc.copy(out, descAt);

  // GPS IFD.
  at = gpsAt;
  out.writeUInt16LE(5, at);
  at += 2;
  entry(TAG.gpsVersionId, TYPE.BYTE, 4, (b, o) => b.set([2, 3, 0, 0], o));
  entry(TAG.gpsLatitudeRef, TYPE.ASCII, 2, (b, o) =>
    b.write(gps.latitude >= 0 ? 'N' : 'S', o, 'latin1'),
  );
  entry(TAG.gpsLatitude, TYPE.RATIONAL, 3, (b, o) => b.writeUInt32LE(latAt, o));
  entry(TAG.gpsLongitudeRef, TYPE.ASCII, 2, (b, o) =>
    b.write(gps.longitude >= 0 ? 'E' : 'W', o, 'latin1'),
  );
  entry(TAG.gpsLongitude, TYPE.RATIONAL, 3, (b, o) =>
    b.writeUInt32LE(lonAt, o),
  );
  out.writeUInt32LE(0, at);

  const rationals = (offset: number, value: number) =>
    dms(value).forEach(([n, d], i) => {
      out.writeUInt32LE(n, offset + i * 8);
      out.writeUInt32LE(d, offset + i * 8 + 4);
    });
  rationals(latAt, gps.latitude);
  rationals(lonAt, gps.longitude);
  return out;
}

interface Chunk {
  fourcc: string;
  data: Buffer;
}

function readChunks(webp: Buffer): Chunk[] {
  if (
    webp.toString('latin1', 0, 4) !== 'RIFF' ||
    webp.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    throw new Error('not a WebP file');
  }
  const chunks: Chunk[] = [];
  for (let at = 12; at + 8 <= webp.length;) {
    const fourcc = webp.toString('latin1', at, at + 4);
    const size = webp.readUInt32LE(at + 4);
    chunks.push({ fourcc, data: webp.subarray(at + 8, at + 8 + size) });
    at += 8 + size + (size % 2);
  }
  return chunks;
}

function writeChunks(chunks: Chunk[]): Buffer {
  const parts = chunks.flatMap(({ fourcc, data }) => {
    const header = Buffer.alloc(8);
    header.write(fourcc, 0, 'latin1');
    header.writeUInt32LE(data.length, 4);
    return data.length % 2 ? [header, data, Buffer.alloc(1)] : [header, data];
  });
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...parts]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/** The WebP with `exif` as its EXIF chunk (the extended format, VP8X, is added if needed). */
export function withExif(
  webp: Buffer,
  exif: Buffer,
  width: number,
  height: number,
): Buffer {
  const chunks = readChunks(webp).filter((c) => c.fourcc !== 'EXIF');
  let vp8x = chunks.find((c) => c.fourcc === 'VP8X');
  if (!vp8x) {
    const data = Buffer.alloc(10);
    data.writeUIntLE(width - 1, 4, 3);
    data.writeUIntLE(height - 1, 7, 3);
    vp8x = { fourcc: 'VP8X', data };
    chunks.unshift(vp8x);
  }
  vp8x.data = Buffer.from(vp8x.data);
  vp8x.data[0] |= 0x08; // EXIF present
  return writeChunks([...chunks, { fourcc: 'EXIF', data: exif }]);
}

/** The GPS position in a WebP's EXIF chunk, or null when it has none. */
export function readGps(webp: Buffer): GpsPosition | null {
  const exif = readChunks(webp).find((c) => c.fourcc === 'EXIF')?.data;
  if (!exif || exif.toString('latin1', 0, 2) !== 'II') return null;
  const ifd = (offset: number) => {
    const entries = new Map<number, number>();
    const n = exif.readUInt16LE(offset);
    for (let i = 0; i < n; i++) {
      const at = offset + 2 + i * 12;
      entries.set(exif.readUInt16LE(at), at);
    }
    return entries;
  };
  const gpsEntry = ifd(exif.readUInt32LE(4)).get(TAG.gpsInfo);
  if (gpsEntry === undefined) return null;
  const gps = ifd(exif.readUInt32LE(gpsEntry + 8));
  const coordinate = (valueTag: number, refTag: number, negative: string) => {
    const valueAt = gps.get(valueTag);
    const refAt = gps.get(refTag);
    if (valueAt === undefined || refAt === undefined) return NaN;
    const at = exif.readUInt32LE(valueAt + 8);
    const [d, m, s] = [0, 1, 2].map(
      (i) => exif.readUInt32LE(at + i * 8) / exif.readUInt32LE(at + i * 8 + 4),
    );
    const sign =
      exif.toString('latin1', refAt + 8, refAt + 9) === negative ? -1 : 1;
    return sign * (d + m / 60 + s / 3600);
  };
  return {
    latitude: coordinate(TAG.gpsLatitude, TAG.gpsLatitudeRef, 'S'),
    longitude: coordinate(TAG.gpsLongitude, TAG.gpsLongitudeRef, 'W'),
  };
}
