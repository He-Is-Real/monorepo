'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload } from 'tus-js-client';
import {
  ApiUserProblem,
  ApiUserUnavailable,
  newIdempotencyKey,
  StaleVersion,
} from '@/lib/api-user';
import { PREFIX } from '@/lib/share-storage';
import { formatWhen, UploadsLeft, uploadsState } from './allowance';
import type {
  ShareApi,
  SubmissionLimits,
  UploadRequest,
  UploadTarget,
} from './share-api';

/**
 * A video or audio story's file (M2 plan PR 7; D68, D80, D113): drag and drop or choose a file,
 * checked against the person's limits first (type, size, and length when the browser can read
 * it), then uploaded straight to Bunny Stream by TUS with the link api-user signed for the
 * draft's own video. Progress, pause and resume, cancel, and a retry that carries on from where
 * it stopped. After a reload the person chooses the same file again and it carries on: with the
 * same link while it lasts, then with a new one for the same video (`resume`). Choosing another
 * file replaces the draft's video (api-user deletes the old one at Bunny).
 *
 * What's kept in this tab's storage, per person and draft: the file's name, size and date (to
 * know it again), whether it finished, and the current link (it lasts an hour). tus-js-client
 * keeps the upload's address per video and file in localStorage, removed once it finishes.
 *
 * A new upload's request (D29; Codex #133 round 1) is kept there too, with its Idempotency-Key,
 * the version and body it was sent with, until its answer settles it. Its answer can be lost
 * after api-user made the video, put it on the draft and counted it: choosing the same file
 * again then sends the very same request, and api-user replays it (the same video, nothing new
 * counted), however the draft's version moved on meanwhile. A `412` means the draft changed
 * elsewhere: it's read again (the same check as a save's), and the request is made at its new
 * version.
 */

export type UploadFormat = 'video' | 'audio';

/** What the step around the panel needs to know. */
export type FileState =
  /** No file yet. */
  | 'none'
  /** Uploading, paused, or stopped by an error: not there yet. */
  | 'unfinished'
  /** This tab uploaded it all. */
  | 'uploaded'
  /** The story has a file from earlier (another tab or device): submit checks it arrived. */
  | 'earlier';

interface Kept {
  name: string;
  size: number;
  lastModified: number;
  videoId: string;
  done: boolean;
  target: UploadTarget;
}

const ACCEPT: Record<UploadFormat, string> = {
  video: 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm',
  audio:
    'audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav,audio/wave,.mp3,.m4a,.wav',
};
/** The types api-user accepts (A4), by MIME type or, when the browser gives none, extension. */
const TYPES: Record<UploadFormat, Record<string, string>> = {
  video: {
    'video/mp4': 'video/mp4',
    'video/quicktime': 'video/quicktime',
    'video/webm': 'video/webm',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
  },
  audio: {
    'audio/mpeg': 'audio/mpeg',
    'audio/mp4': 'audio/mp4',
    'audio/x-m4a': 'audio/x-m4a',
    'audio/wav': 'audio/wav',
    'audio/x-wav': 'audio/x-wav',
    'audio/wave': 'audio/wave',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
  },
};
const KINDS: Record<UploadFormat, string> = {
  video: 'MP4, MOV or WebM',
  audio: 'MP3, M4A or WAV',
};
/** A link with less left than this is renewed before carrying on. */
const RENEW_MS = 5 * 60_000;

// The same button looks as share-flow.tsx.
const button =
  'inline-flex min-h-11 items-center justify-center rounded-md px-5 text-sm font-semibold transition-colors disabled:opacity-60';
const primary = `${button} bg-primary text-primary-foreground hover:bg-primary/90`;
const secondary = `${button} border border-border-hover text-secondary-text hover:border-teal hover:bg-accent hover:text-foreground`;

export function formatBytes(n: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : Number(v.toFixed(v < 10 ? 1 : 0))} ${units[i]}`;
}

export function formatMinutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s} seconds`;
  return s
    ? `${m} minutes ${s} seconds`
    : m === 1
      ? '1 minute'
      : `${m} minutes`;
}

/** One file's types, size and length for the format: "MP4, MOV or WebM, up to 4 GB and 15 minutes." */
export function fileLimits(
  limits: SubmissionLimits['uploads'],
  format: UploadFormat,
): string {
  const bytes =
    format === 'audio' ? limits.audioMaxBytes : limits.videoMaxBytes;
  return `${KINDS[format]}, up to ${formatBytes(bytes)} and ${formatMinutes(limits.maxDurationSeconds)}.`;
}

/** The content type api-user accepts for this file, or undefined if it's not one of them. */
export function contentTypeOf(
  file: { name: string; type: string },
  format: UploadFormat,
): string | undefined {
  const ext = /\.[a-z0-9]+$/i.exec(file.name)?.[0].toLowerCase() ?? '';
  return TYPES[format][file.type] ?? TYPES[format][ext];
}

/** The file's length in whole seconds, if the browser can read it (a few seconds at most). */
function readDuration(
  file: File,
  format: UploadFormat,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const el = document.createElement(format);
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (v: number | undefined) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      resolve(v);
    };
    el.preload = 'metadata';
    el.onloadedmetadata = () =>
      done(
        Number.isFinite(el.duration) && el.duration > 0
          ? Math.ceil(el.duration)
          : undefined,
      );
    el.onerror = () => done(undefined);
    setTimeout(() => done(undefined), 5000);
    el.src = url;
  });
}

const keptKey = (owner: string, draftId: string) =>
  `${PREFIX}${owner}:upload:${draftId}`;
function readKept(owner: string, draftId: string): Kept | null {
  try {
    return JSON.parse(
      window.sessionStorage.getItem(keptKey(owner, draftId)) ?? 'null',
    ) as Kept | null;
  } catch {
    return null;
  }
}
function writeKept(owner: string, draftId: string, kept: Kept | null) {
  try {
    if (kept) {
      window.sessionStorage.setItem(
        keptKey(owner, draftId),
        JSON.stringify(kept),
      );
    } else window.sessionStorage.removeItem(keptKey(owner, draftId));
  } catch {
    // storage blocked: this tab keeps it on screen only
  }
}
/** A new upload's request, until its answer settles it. */
interface Attempt {
  key: string;
  version: number;
  request: UploadRequest;
  name: string;
  size: number;
  lastModified: number;
}
const attemptKey = (owner: string, draftId: string) =>
  `${PREFIX}${owner}:upload-request:${draftId}`;
function readAttempt(owner: string, draftId: string): Attempt | null {
  try {
    return JSON.parse(
      window.sessionStorage.getItem(attemptKey(owner, draftId)) ?? 'null',
    ) as Attempt | null;
  } catch {
    return null;
  }
}
function writeAttempt(owner: string, draftId: string, a: Attempt | null) {
  try {
    if (a) {
      window.sessionStorage.setItem(
        attemptKey(owner, draftId),
        JSON.stringify(a),
      );
    } else window.sessionStorage.removeItem(attemptKey(owner, draftId));
  } catch {
    // storage blocked: kept for this call only
  }
}
/** No answer, or a server error: it may have gone through, so its request is kept to replay. */
const outcomeUnknown = (err: unknown) =>
  err instanceof ApiUserUnavailable ||
  (err instanceof ApiUserProblem && err.status >= 500);

const sameFile = (k: Kept | Attempt | null, f: File) =>
  !!k &&
  k.name === f.name &&
  k.size === f.size &&
  k.lastModified === f.lastModified;

type Phase =
  | { at: 'idle' }
  | { at: 'checking'; name: string }
  | { at: 'uploading' | 'paused'; name: string; sent: number; total: number }
  | { at: 'failed'; name: string; sent: number; total: number }
  | { at: 'done'; name: string; total: number };

export function UploadPanel({
  calls,
  owner,
  format,
  limits,
  draftId,
  hasEarlierFile,
  prepare,
  setVersion,
  reload,
  onState,
  onCounted,
}: {
  calls: ShareApi;
  owner: string;
  format: UploadFormat;
  limits: SubmissionLimits['uploads'];
  /** The draft, once it exists (the panel learns of a file uploaded to it before). */
  draftId: string | null;
  /** The story already has a file (from its last read). */
  hasEarlierFile: boolean;
  /**
   * Saves the draft (creating it once it has a title) and answers its id and version, or a
   * plain reason it can't yet.
   */
  prepare: () => Promise<{ draftId: string; version: number } | string>;
  setVersion: (version: number) => void;
  /** Reads the draft again after a `412` (as a save does); false once it can't be edited. */
  reload: (draftId: string) => Promise<boolean>;
  onState: (state: FileState) => void;
  /** A new upload was counted, or refused for the limits: read them again. */
  onCounted: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ at: 'idle' });
  const [problem, setProblem] = useState<React.ReactNode>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useRef<Upload | null>(null);
  const current = useRef<{ file: File; draftId: string } | null>(null);
  const [kept, setKept] = useState<Kept | null>(null);
  const maxBytes =
    format === 'audio' ? limits.audioMaxBytes : limits.videoMaxBytes;
  const noun = format === 'audio' ? 'audio file' : 'video';

  // A file this tab started for this draft before a reload.
  useEffect(() => {
    if (!draftId) return;
    const k = readKept(owner, draftId);
    setKept(k);
    if (k?.done) setPhase({ at: 'done', name: k.name, total: k.size });
  }, [owner, draftId]);

  // Cancelled here: the story's video is the one just abandoned, so there's no file to keep.
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    if (phase.at === 'done') onState('uploaded');
    else if (phase.at !== 'idle' || (kept && !kept.done)) onState('unfinished');
    else onState(hasEarlierFile && !cancelled ? 'earlier' : 'none');
  }, [phase.at, kept, hasEarlierFile, cancelled, onState]);

  // Each run's token. Leaving the step (Back, another account) or a newer run makes an older
  // run's late answers unused: nothing kept, no upload started that nobody can see or cancel.
  const runs = useRef(0);
  const begin = useCallback(() => {
    const mine = ++runs.current;
    return () => runs.current !== mine;
  }, []);

  // Leaving the step pauses the upload; it carries on when the person comes back to it.
  useEffect(
    () => () => {
      runs.current++;
      void upload.current?.abort();
    },
    [],
  );

  const remember = useCallback(
    (id: string, k: Kept | null) => {
      writeKept(owner, id, k);
      setKept(k);
    },
    [owner],
  );

  /**
   * A new video for the file, once per request: a kept one for this file that never got a
   * settled answer is sent again as it was (its key, version and body), else a new one. After a
   * `412` the draft is read again and the request made once more at its version.
   */
  const newUpload = useCallback(
    async (
      file: File,
      first: { draftId: string; version: number },
      request: UploadRequest,
      gone: () => boolean,
    ): Promise<UploadTarget | null> => {
      // Left behind (Back, another account, a newer run): ask for nothing, keep nothing.
      if (gone()) return null;
      let ready = first;
      for (let again = false; ; again = true) {
        const kept = readAttempt(owner, ready.draftId);
        const attempt: Attempt =
          kept && sameFile(kept, file) && kept.request.format === request.format
            ? kept
            : {
                key: newIdempotencyKey(),
                version: ready.version,
                request,
                name: file.name,
                size: file.size,
                lastModified: file.lastModified,
              };
        writeAttempt(owner, ready.draftId, attempt);
        try {
          const target = await calls.uploadUrl(
            ready.draftId,
            attempt.version,
            attempt.request,
            attempt.key,
          );
          if (gone()) return null;
          writeAttempt(owner, ready.draftId, null);
          // A replay answers the version its request made; the draft may be past it since.
          if (target.version > ready.version) setVersion(target.version);
          return target;
        } catch (err) {
          if (outcomeUnknown(err) || gone()) throw err;
          writeAttempt(owner, ready.draftId, null);
          if (!(err instanceof StaleVersion) || again) throw err;
          // Changed elsewhere (another tab, or a request of this one whose answer was lost):
          // read it again, then ask at its version.
          if (!(await reload(ready.draftId)) || gone()) throw err;
          const now = await prepare();
          if (gone()) return null;
          if (typeof now === 'string') {
            setProblem(now);
            return null;
          }
          ready = now;
        }
      }
    },
    [calls, owner, prepare, reload, setVersion],
  );

  /** A link for the file: the kept one while it lasts, else a new one for the same video. */
  const linkFor = useCallback(
    async (
      file: File,
      contentType: string,
      durationSeconds: number | undefined,
      gone: () => boolean,
    ): Promise<{ target: UploadTarget; draftId: string } | null> => {
      const ready = await prepare();
      if (gone()) return null;
      if (typeof ready === 'string') {
        setProblem(ready);
        return null;
      }
      const request: UploadRequest = {
        format,
        contentType,
        fileSizeBytes: file.size,
        ...(durationSeconds ? { durationSeconds } : {}),
      };
      const k = readKept(owner, ready.draftId);
      if (sameFile(k, file) && k && !k.done) {
        if (Date.parse(k.target.expiresAt) - Date.now() > RENEW_MS) {
          return { target: k.target, draftId: ready.draftId };
        }
        try {
          const target = await calls.uploadUrl(ready.draftId, ready.version, {
            ...request,
            resume: true,
          });
          if (gone()) return null;
          remember(ready.draftId, { ...k, target });
          return { target, draftId: ready.draftId };
        } catch (err) {
          if (gone()) return null;
          // Nothing left to carry on (it finished, or the video was replaced elsewhere): a
          // new upload below. (A resume writes nothing, so it needs no kept key.)
          if (!(
            err instanceof ApiUserProblem && err.code === 'nothing_to_resume'
          )) {
            throw err;
          }
        }
      }
      const target = await newUpload(file, ready, request, gone);
      if (!target) return null;
      onCounted();
      remember(ready.draftId, {
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        videoId: target.signed['VideoId'] ?? '',
        done: false,
        target,
      });
      return { target, draftId: ready.draftId };
    },
    [calls, format, newUpload, onCounted, owner, prepare, remember],
  );

  const run = useCallback(
    async (
      file: File,
      contentType: string,
      durationSeconds: number | undefined,
      gone: () => boolean,
    ) => {
      setProblem(null);
      setNotice(null);
      setPhase({ at: 'checking', name: file.name });
      let link;
      try {
        link = await linkFor(file, contentType, durationSeconds, gone);
      } catch (err) {
        if (gone()) return;
        setPhase({ at: 'idle' });
        setProblem(refusal(err, noun));
        if (
          err instanceof ApiUserProblem &&
          err.code === 'upload_limit_reached'
        )
          onCounted();
        return;
      }
      if (gone()) return;
      if (!link) {
        setPhase({ at: 'idle' });
        return;
      }
      const { target, draftId: id } = link;
      const videoId = target.signed['VideoId'] ?? '';
      current.current = { file, draftId: id };
      const tus = new Upload(file, {
        endpoint: target.uploadUrl,
        headers: target.signed,
        // Bunny's TUS metadata: the type, and a title that is the story id only (D69).
        metadata: { filetype: contentType, title: id },
        fingerprint: async () =>
          `heisreal-${videoId}-${file.size}-${file.lastModified}`,
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        retryDelays: [0, 1000, 3000],
        onProgress: (sent, total) =>
          setPhase({ at: 'uploading', name: file.name, sent, total }),
        onSuccess: () => {
          const k = readKept(owner, id);
          if (k) remember(id, { ...k, done: true });
          setPhase({ at: 'done', name: file.name, total: file.size });
        },
        onError: () => {
          setPhase((p) => ({
            at: 'failed',
            name: file.name,
            sent: 'sent' in p ? p.sent : 0,
            total: file.size,
          }));
        },
      });
      upload.current = tus;
      setPhase({ at: 'uploading', name: file.name, sent: 0, total: file.size });
      const previous = await tus.findPreviousUploads().catch(() => []);
      if (gone()) return;
      if (previous[0]) tus.resumeFromPreviousUpload(previous[0]);
      tus.start();
    },
    [linkFor, noun, onCounted, owner, remember],
  );

  async function choose(file: File | undefined) {
    if (!file) return;
    // At a limit, a new file waits (D113), however it comes (chooser or drop): only the file
    // this tab started, or a request whose answer was lost, carries on, as neither counts again.
    const until = uploadsState(limits).until;
    if (
      until &&
      !(kept && !kept.done && sameFile(kept, file)) &&
      !(draftId && sameFile(readAttempt(owner, draftId), file))
    ) {
      setProblem(
        `You’ve started as many uploads as you can for now. Your story is saved: you can upload your ${noun} from ${formatWhen(until)}.`,
      );
      return;
    }
    setCancelled(false);
    if (phase.at === 'uploading') upload.current?.abort();
    const contentType = contentTypeOf(file, format);
    if (!contentType) {
      setProblem(
        `That kind of file can’t be uploaded. Choose an ${KINDS[format]} file.`,
      );
      return;
    }
    if (file.size > maxBytes) {
      setProblem(
        `That file is ${formatBytes(file.size)}. The most you can upload is ${formatBytes(maxBytes)}: please choose a smaller one.`,
      );
      return;
    }
    setPhase({ at: 'checking', name: file.name });
    const gone = begin();
    const seconds = await readDuration(file, format);
    if (gone()) return;
    if (seconds && seconds > limits.maxDurationSeconds) {
      setPhase({ at: 'idle' });
      setProblem(
        `That ${noun} is ${formatMinutes(seconds)} long. The most you can upload is ${formatMinutes(limits.maxDurationSeconds)}: please choose a shorter one.`,
      );
      return;
    }
    await run(file, contentType, seconds, gone);
  }

  function pause() {
    void upload.current?.abort();
    setPhase((p) => (p.at === 'uploading' ? { ...p, at: 'paused' } : p));
  }

  function carryOn() {
    const c = current.current;
    if (!c) return;
    const contentType = contentTypeOf(c.file, format);
    if (contentType) void run(c.file, contentType, undefined, begin());
  }

  function cancel() {
    runs.current++;
    void upload.current?.abort();
    upload.current = null;
    const c = current.current;
    if (c) remember(c.draftId, null);
    current.current = null;
    setCancelled(true);
    setPhase({ at: 'idle' });
    setProblem(null);
    setNotice(
      `Upload cancelled. Your story is saved; choose your ${noun} when you’re ready.`,
    );
    if (fileInput.current) fileInput.current.value = '';
  }

  const percent =
    'total' in phase && 'sent' in phase && phase.total > 0
      ? Math.floor((phase.sent / phase.total) * 100)
      : 0;
  const busy = phase.at === 'uploading' || phase.at === 'checking';
  // At a limit, a new file waits (D113): said here instead of answered with an error. Carrying
  // on with a file this tab started, or sending again a request whose answer was lost, counts
  // nothing new, so it stays open.
  const carriesOn =
    (kept && !kept.done) || (!!draftId && !!readAttempt(owner, draftId));
  const held = !!uploadsState(limits).until && !carriesOn && !busy;

  return (
    <div data-upload-phase={phase.at}>
      <div
        className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-6 text-center ${
          over ? 'border-teal bg-accent' : 'border-border-hover'
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void choose(e.dataTransfer.files?.[0]);
        }}
        data-drop-zone=""
      >
        <p className="text-secondary-text">
          {phase.at === 'done'
            ? `Want to use a different ${noun}? Drag it here, or`
            : `Drag your ${noun} here, or`}
        </p>
        <label
          className={`${phase.at === 'done' ? secondary : primary} cursor-pointer has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 ${busy || held ? 'pointer-events-none opacity-60' : ''}`}
        >
          {phase.at === 'done' ? 'Choose another file' : 'Choose a file'}
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT[format]}
            className="sr-only"
            disabled={busy || held}
            aria-describedby="upload-limits upload-allowance"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              // Emptied at once, so choosing the same file again (to try again) is a change.
              e.target.value = '';
              void choose(chosen);
            }}
          />
        </label>
        <p id="upload-limits" className="text-sm text-secondary-text">
          {fileLimits(limits, format)}
        </p>
        <div className="text-sm text-secondary-text">
          <UploadsLeft limits={limits} noun={noun} id="upload-allowance" />
        </div>
      </div>

      {kept && !kept.done && phase.at === 'idle' && (
        <p className="mt-4 text-sm text-foreground" role="status">
          Your upload of “{kept.name}” didn’t finish. Choose the same file again
          to carry on from where it stopped.
        </p>
      )}
      {hasEarlierFile && !kept && !cancelled && phase.at === 'idle' && (
        <p className="mt-4 text-sm text-secondary-text">
          This story already has a {noun}. Choose a file only if you want to
          replace it.
        </p>
      )}

      {phase.at === 'checking' && (
        <p className="mt-4 text-sm text-secondary-text" role="status">
          Getting “{phase.name}” ready…
        </p>
      )}

      {(phase.at === 'uploading' ||
        phase.at === 'paused' ||
        phase.at === 'failed') && (
        <div className="mt-4">
          <p className="mb-2 text-sm [overflow-wrap:anywhere]">
            {phase.name}: {formatBytes(phase.sent)} of{' '}
            {formatBytes(phase.total)}
          </p>
          <div
            role="progressbar"
            aria-label={`Uploading ${phase.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${percent}%`}
            className="h-3 overflow-hidden rounded-full bg-surface"
          >
            <div
              className="h-full bg-teal transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-2 text-sm text-secondary-text" role="status">
            {phase.at === 'uploading'
              ? `${percent}% uploaded. Keep this page open until it’s done.`
              : phase.at === 'paused'
                ? `Paused at ${percent}%.`
                : ''}
          </p>
          {phase.at === 'failed' && (
            <p role="alert" className="mt-2 text-destructive">
              The upload stopped. Your story is saved, and you can carry on from
              where it stopped.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-3">
            {phase.at === 'uploading' && (
              <button type="button" className={secondary} onClick={pause}>
                Pause
              </button>
            )}
            {phase.at === 'paused' && (
              <button type="button" className={primary} onClick={carryOn}>
                Resume
              </button>
            )}
            {phase.at === 'failed' && (
              <button type="button" className={primary} onClick={carryOn}>
                Try again
              </button>
            )}
            <button type="button" className={secondary} onClick={cancel}>
              Cancel upload
            </button>
          </div>
        </div>
      )}

      {phase.at === 'done' && (
        <p
          className="mt-4 font-semibold [overflow-wrap:anywhere]"
          role="status"
        >
          Uploaded: {phase.name} ({formatBytes(phase.total)})
        </p>
      )}
      {notice && (
        <p className="mt-4 text-sm text-secondary-text" role="status">
          {notice}
        </p>
      )}
      {problem && (
        <p role="alert" className="mt-4 text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

/** api-user's refusal of RequestUpload, in plain words. */
function refusal(err: unknown, noun: string): string {
  if (err instanceof ApiUserUnavailable) {
    return 'We can’t reach our server right now. Your story is saved; please try again in a moment.';
  }
  if (err instanceof StaleVersion) {
    return 'Your story was changed in another tab or window. Please choose your file again.';
  }
  if (err instanceof ApiUserProblem) {
    const p = err.problem as ApiUserProblem['problem'] & {
      availableAt?: string;
    };
    if (p.code === 'upload_limit_reached' && p.availableAt) {
      const when = new Intl.DateTimeFormat('en-GB', {
        weekday: 'long',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'Europe/London',
      }).format(new Date(p.availableAt));
      return `You’ve started as many uploads as you can for now. Your story is saved: you can upload your ${noun} from ${when}.`;
    }
    if (p.detail) return p.detail;
  }
  return `Your ${noun} couldn’t be uploaded. Your story is saved; please try again.`;
}
