/**
 * Removes where and on what a video or audio file was recorded before it leaves the device (M2,
 * Joel 2026-11-06): Bunny's MP4 copies can keep a file's location, and a published video's MP4
 * copies are reachable with its player's token.
 *
 * MP4, MOV and M4A files (ISO base media / QuickTime) keep that metadata in boxes of their own:
 * `udta` (Android's `©xyz`, `loci`, QuickTime's `©mak`/`©mod`), `meta` (Apple's `keys` + `ilst`:
 * `com.apple.quicktime.location.ISO6709`, make, model) and XMP in a `uuid` box. Each one found at
 * the top level or in `moov`, a `trak`, its `mdia` or `minf` becomes a `free` box of the same size
 * with its contents zeroed. Nothing moves, so no box size or chunk offset changes and the media
 * data isn't touched or re-encoded. Only the `moov` box (the index, small next to the media) is
 * read into memory; the rest of the upload is slices of the file itself.
 *
 * Anything else (MP3, WAV, WebM, or a file whose boxes don't add up) comes back unchanged and
 * uploads as before. Nothing is logged: the file is the person's.
 */

/** Boxes whose whole content is metadata. */
const METADATA = new Set(['udta', 'meta']);
/** Boxes that can hold `udta` or `meta` and are otherwise kept. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf']);
/** XMP's `uuid` box (Adobe's XMP spec, part 3). */
const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';
/** The first box of an MP4, MOV or M4A file (older QuickTime files may start without `ftyp`). */
const FIRST = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot']);
class NotIsoMedia extends Error {}

interface Box {
  type: string;
  /** Header length: 8, or 16 with a 64-bit size. */
  header: number;
  size: number;
}

/** The box at `at` in `view`, which holds bytes up to `end` (relative to `view`). */
function boxAt(view: DataView, at: number, end: number): Box {
  if (end - at < 8) throw new NotIsoMedia();
  let size = view.getUint32(at);
  let header = 8;
  if (size === 1) {
    if (end - at < 16) throw new NotIsoMedia();
    size = Number(view.getBigUint64(at + 8));
    header = 16;
  } else if (size === 0) {
    size = end - at;
  }
  if (size < header || at + size > end) throw new NotIsoMedia();
  let type = '';
  for (let i = 4; i < 8; i++) {
    const c = view.getUint8(at + i);
    // Box types are printable ASCII, or © (0xA9) in QuickTime's.
    if ((c < 0x20 || c > 0x7e) && c !== 0xa9) throw new NotIsoMedia();
    type += String.fromCharCode(c);
  }
  return { type, header, size };
}

function isXmp(bytes: Uint8Array, at: number, box: Box): boolean {
  if (box.type !== 'uuid' || box.size < box.header + 16) return false;
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += bytes[at + box.header + i].toString(16).padStart(2, '0');
  }
  return id === XMP_UUID;
}

/** Turns the box at `at` into a `free` box of the same size, its contents zeroed. */
function blank(bytes: Uint8Array, at: number, box: Box) {
  bytes.set([0x66, 0x72, 0x65, 0x65], at + 4); // 'free'
  bytes.fill(0, at + box.header, at + box.size);
}

/** Blanks every metadata box in `bytes[start, end)` and the containers in it; true if any. */
function blankIn(bytes: Uint8Array, start: number, end: number): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let changed = false;
  for (let at = start; at < end;) {
    const box = boxAt(view, at, end);
    if (METADATA.has(box.type) || isXmp(bytes, at, box)) {
      blank(bytes, at, box);
      changed = true;
    } else if (CONTAINERS.has(box.type)) {
      changed = blankIn(bytes, at + box.header, at + box.size) || changed;
    }
    at += box.size;
  }
  return changed;
}

async function read(file: Blob, start: number, end: number) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/**
 * The file without its location and device metadata (same size, same media data), or the file
 * itself when it has none or isn't an MP4, MOV or M4A file this can read.
 */
export async function stripMediaMetadata<T extends Blob>(
  file: T,
): Promise<T | Blob> {
  try {
    const edits: { at: number; bytes: Uint8Array }[] = [];
    for (let at = 0; at < file.size;) {
      // The header only, its size checked against what's left of the file.
      const head = await read(file, at, Math.min(at + 16, file.size));
      const box = boxAt(new DataView(head.buffer), 0, file.size - at);
      if (at === 0 && !FIRST.has(box.type)) return file;
      if (box.type === 'moov') {
        const moov = await read(file, at, at + box.size);
        if (blankIn(moov, box.header, box.size))
          edits.push({ at, bytes: moov });
      } else if (METADATA.has(box.type)) {
        const bytes = await read(file, at, at + box.size);
        blank(bytes, 0, box);
        edits.push({ at, bytes });
      } else if (box.type === 'uuid') {
        // Only its id at first: most `uuid` boxes aren't XMP and are left alone.
        const id = await read(
          file,
          at,
          at + Math.min(box.size, box.header + 16),
        );
        if (isXmp(id, 0, box)) {
          const bytes = await read(file, at, at + box.size);
          blank(bytes, 0, box);
          edits.push({ at, bytes });
        }
      }
      at += box.size;
    }
    if (edits.length === 0) return file;
    const parts: BlobPart[] = [];
    let from = 0;
    for (const { at, bytes } of edits) {
      parts.push(file.slice(from, at), bytes as Uint8Array<ArrayBuffer>);
      from = at + bytes.byteLength;
    }
    parts.push(file.slice(from));
    return new Blob(parts, { type: file.type });
  } catch {
    // Not one we can read (NotIsoMedia), or a header cut short by the end of the file.
    return file;
  }
}
