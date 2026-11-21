/**
 * What the browser can tell about a chosen video or audio file before it uploads (thumbnail crop
 * TC-4, Joel 2026-11-21): its length, and for a video its shape (width and height as it's shown,
 * a phone's "turn this" note applied) and whether this browser can play it.
 *
 * The browser's own quick look comes first (the same one that reads the length). When it can't
 * play the file, the shape is read from an MP4 or MOV file's header with mp4box.js (its `moov`
 * box, wherever it is in the file), which phones record. Nothing is uploaded for either.
 */
export interface MediaFacts {
  /** Whole seconds, when the browser could read it. */
  seconds?: number;
  /** The shape as shown, when known. */
  width?: number;
  height?: number;
  /** Whether this browser can play the video (the "moment from your video" tab). */
  playable: boolean;
}

/** The browser's quick look (a few seconds at most). */
function look(file: File, kind: 'video' | 'audio'): Promise<MediaFacts> {
  return new Promise((resolve) => {
    const el = document.createElement(kind);
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (facts: MediaFacts) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      resolve(facts);
    };
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const seconds =
        Number.isFinite(el.duration) && el.duration > 0
          ? Math.ceil(el.duration)
          : undefined;
      const v = el as HTMLVideoElement;
      // A file whose sound plays but whose picture doesn't reads as 0 × 0: not playable here.
      const shown = kind === 'video' && v.videoWidth > 0 && v.videoHeight > 0;
      done({
        seconds,
        ...(shown ? { width: v.videoWidth, height: v.videoHeight } : {}),
        playable: shown,
      });
    };
    el.onerror = () => done({ playable: false });
    setTimeout(() => done({ playable: false }), 5000);
    el.src = url;
  });
}

/** The ISO boxes at the file's top level: where `ftyp` and `moov` are (no media read). */
async function topBoxes(
  file: File,
): Promise<Map<string, { at: number; size: number }>> {
  const found = new Map<string, { at: number; size: number }>();
  let at = 0;
  // A phone's file has a handful of top-level boxes; this stops at anything odd.
  for (let i = 0; i < 64 && at + 8 <= file.size; i++) {
    const head = new DataView(await file.slice(at, at + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(
      head.getUint8(4),
      head.getUint8(5),
      head.getUint8(6),
      head.getUint8(7),
    );
    if (size === 1 && head.byteLength >= 16) {
      size = Number(head.getBigUint64(8));
    } else if (size === 0) {
      size = file.size - at;
    }
    if (size < 8) break;
    if (!found.has(type)) found.set(type, { at, size });
    if (found.has('ftyp') && found.has('moov')) break;
    at += size;
  }
  return found;
}

/** The largest header we read: a phone video's `moov` is well under this. */
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

/**
 * An MP4 or MOV file's shape as shown, from its header: the first video track's size, turned by
 * its rotation matrix (90° or 270° swap the sides). Undefined when it can't be read.
 */
export async function headerShape(
  file: File,
): Promise<{ width: number; height: number } | undefined> {
  try {
    const boxes = await topBoxes(file);
    const ftyp = boxes.get('ftyp');
    const moov = boxes.get('moov');
    if (!ftyp || !moov || moov.size > MAX_MOOV_BYTES) return undefined;
    // mp4box reads the two boxes as if they were the whole file: the shape needs nothing else.
    const bytes = new Uint8Array(ftyp.size + moov.size);
    bytes.set(
      new Uint8Array(
        await file.slice(ftyp.at, ftyp.at + ftyp.size).arrayBuffer(),
      ),
      0,
    );
    bytes.set(
      new Uint8Array(
        await file.slice(moov.at, moov.at + moov.size).arrayBuffer(),
      ),
      ftyp.size,
    );
    const { createFile, MP4BoxBuffer } = await import('mp4box');
    return await new Promise((resolve) => {
      const mp4 = createFile();
      mp4.onError = () => resolve(undefined);
      mp4.onReady = (info) => {
        const track = info.videoTracks[0];
        if (!track || !(track.track_width > 0) || !(track.track_height > 0)) {
          resolve(undefined);
          return;
        }
        const [a, b] = Array.from(track.matrix ?? []);
        // Turned a quarter: the matrix's first entry is 0 and its second isn't.
        const turned = a === 0 && b !== 0;
        resolve({
          width: Math.round(turned ? track.track_height : track.track_width),
          height: Math.round(turned ? track.track_width : track.track_height),
        });
      };
      mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes.buffer, 0));
      mp4.flush();
      // Nothing came of it: not a file mp4box can read.
      resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

/** The file's facts: the browser's look, then (a video it can't play) the file's header. */
export async function readMediaFacts(
  file: File,
  kind: 'video' | 'audio',
): Promise<MediaFacts> {
  const seen = await look(file, kind);
  if (kind === 'audio' || seen.width) return seen;
  const shape = await headerShape(file);
  return shape ? { ...seen, ...shape } : seen;
}
