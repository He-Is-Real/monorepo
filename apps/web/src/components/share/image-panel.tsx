'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiUserProblem,
  ApiUserUnavailable,
  StaleVersion,
} from '@/lib/api-user';
import type { ShareApi, StoryFormat, StoryPicture } from './share-api';
import { formatBytes } from './upload-panel';
import { type Attempt, useRuns, useUploadRequest } from './upload-request';

/**
 * A story's picture (M2 plan PR 10; D53, D65, D80): a written story's image, an audio story's
 * picture, or a video's own thumbnail (Joel, 2026-10-30), shown in place of Bunny's.
 *
 * The browser re-encodes the chosen photo to WebP on a canvas, at most 2048 px on its longer side.
 * A canvas carries no metadata, so EXIF (the camera, the time, GPS) never leaves the device; the
 * photo's own orientation is applied first. It checks the shape (1:3..3:1) and size (D53) and
 * shows the result at its real shape with a description box (required for a written story).
 * "Add this picture" asks api-user for the upload (RequestUpload with `format: image`, the
 * same idempotent request as a video's: upload-request.ts), which puts the picture on the draft,
 * then PUTs the WebP straight to Bunny's storage with the presigned link. Replacing or removing
 * it never deletes the old file (an approved copy may still show it; the clean-up sweep does).
 */

/** The longer side the browser re-encodes to, and the bounds api-user and the database check. */
const MAX_SIDE = 2048;
const MIN_SIDE = 200;
const MAX_BYTES = 5_242_880;
const QUALITY = 0.85;

export type PictureState = 'none' | 'unfinished' | 'done';

interface Prepared {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  /** The chosen file, as upload-request.ts knows it again. */
  file: { name: string; size: number; lastModified: number };
}

type Phase =
  | { at: 'idle' }
  | { at: 'reading' }
  | { at: 'preview'; picture: Prepared }
  | { at: 'sending'; picture: Prepared }
  | { at: 'done'; url: string | null; width: number; height: number };

const NOUN: Record<StoryFormat, string> = {
  written: 'picture',
  audio: 'picture',
  video: 'thumbnail',
};

const button =
  'inline-flex min-h-11 items-center justify-center rounded-md px-5 text-sm font-semibold transition-colors disabled:opacity-60';
const primary = `${button} bg-primary text-primary-foreground hover:bg-primary/90`;
const secondary = `${button} border border-border-hover text-secondary-text hover:border-teal hover:bg-accent hover:text-foreground`;
const input =
  'min-h-11 w-full rounded-md border border-input bg-input-background px-3 py-2.5 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

/** Re-encodes the photo to WebP (no metadata), or answers a plain reason it can't be used. */
async function prepare(file: File): Promise<Prepared | string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return 'We can’t read that file as a picture. Choose a JPEG, PNG or WebP photo.';
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  if (width > height * 3) {
    bitmap.close();
    return 'That picture is too wide. Choose one no more than 3 times as wide as it is tall, or crop it first.';
  }
  if (height > width * 3) {
    bitmap.close();
    return 'That picture is too tall. Choose one no more than 3 times as tall as it is wide, or crop it first.';
  }
  if (width < MIN_SIDE || height < MIN_SIDE) {
    bitmap.close();
    return `That picture is too small. Choose one at least ${MIN_SIDE} pixels on each side.`;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', QUALITY),
  );
  if (!blob || blob.type !== 'image/webp') {
    return 'This browser can’t prepare pictures for upload. Please try another browser.';
  }
  if (blob.size > MAX_BYTES) {
    return `That picture is still ${formatBytes(blob.size)} once prepared. Please choose a simpler one.`;
  }
  return {
    blob,
    url: URL.createObjectURL(blob),
    width,
    height,
    file: {
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
    },
  };
}

/** The picture at its real shape, never wider than the panel or taller than most of the screen. */
function Picture({
  src,
  width,
  height,
  alt,
}: {
  src: string | null;
  width: number;
  height: number;
  alt: string;
}) {
  return (
    <div
      data-picture-preview=""
      className="overflow-hidden rounded-lg bg-surface"
      style={{
        aspectRatio: `${width} / ${height}`,
        width: `min(100%, calc(50svh * ${width} / ${height}))`,
      }}
    >
      {src && (
        // A blob: or signed link the optimiser can't fetch, at a size already known.
        <img
          src={src}
          alt={alt}
          width={width}
          height={height}
          className="block h-full w-full object-cover"
        />
      )}
    </div>
  );
}

export function ImagePanel({
  calls,
  owner,
  format,
  draftId,
  earlier,
  prepare: prepareDraft,
  setVersion,
  current,
  reload,
  onState,
}: {
  calls: ShareApi;
  owner: string;
  format: StoryFormat;
  draftId: string | null;
  /** The story's picture from its last read. */
  earlier: StoryPicture | null;
  /** Saves the draft (creating it when it can be) and answers its id and version, or a reason. */
  prepare: () => Promise<{ draftId: string; version: number } | string>;
  setVersion: (version: number) => void;
  current: () => { draftId: string | null; version: number | null };
  reload: (draftId: string) => Promise<boolean>;
  onState?: (state: PictureState) => void;
}) {
  const noun = NOUN[format];
  const altRequired = format === 'written';
  const [phase, setPhase] = useState<Phase>({ at: 'idle' });
  const [alt, setAlt] = useState('');
  const [savedAlt, setSavedAlt] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [altProblem, setAltProblem] = useState<string | null>(null);
  const { begin, stop } = useRuns();
  const fileInput = useRef<HTMLInputElement>(null);

  // The picture the story already has (another tab, or before a reload).
  useEffect(() => {
    if (!earlier) return;
    setPhase((p) =>
      p.at === 'idle'
        ? {
            at: 'done',
            url: earlier.url,
            width: earlier.width,
            height: earlier.height,
          }
        : p,
    );
    setAlt(earlier.alt ?? '');
    setSavedAlt(earlier.alt ?? '');
  }, [earlier]);

  useEffect(() => {
    onState?.(
      phase.at === 'done'
        ? 'done'
        : phase.at === 'idle'
          ? 'none'
          : 'unfinished',
    );
  }, [phase.at, onState]);

  // A blob: link is freed once nothing shows it.
  useEffect(() => {
    const url =
      phase.at === 'preview' || phase.at === 'sending'
        ? phase.picture.url
        : null;
    return () => {
      if (url) setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };
  }, [phase]);

  const request = useUploadRequest({
    calls,
    owner,
    slot: 'image-request',
    prepare: prepareDraft,
    reload,
    setVersion,
    onProblem: setProblem,
    // The kept request is sent again only for the very same picture and description.
    reuse: useCallback(
      (kept: Attempt, req) =>
        JSON.stringify(kept.request) === JSON.stringify(req),
      [],
    ),
  });

  async function choose(file: File | undefined) {
    if (!file) return;
    setProblem(null);
    setNotice(null);
    const gone = begin();
    setPhase({ at: 'reading' });
    const prepared = await prepare(file);
    if (gone()) return;
    if (typeof prepared === 'string') {
      setPhase({ at: 'idle' });
      setProblem(prepared);
      return;
    }
    setAltProblem(null);
    setPhase({ at: 'preview', picture: prepared });
  }

  async function add(picture: Prepared) {
    const description = alt.trim();
    if (altRequired && !description) {
      setAltProblem(
        'Describe your picture in a few words, for people who can’t see it.',
      );
      return;
    }
    setAltProblem(null);
    setProblem(null);
    const gone = begin();
    setPhase({ at: 'sending', picture });
    try {
      const ready = await prepareDraft();
      if (gone()) return;
      if (typeof ready === 'string') {
        setPhase({ at: 'preview', picture });
        setProblem(ready);
        return;
      }
      const target = await request(
        picture.file,
        ready,
        {
          format: 'image',
          contentType: 'image/webp',
          fileSizeBytes: picture.blob.size,
          width: picture.width,
          height: picture.height,
          ...(description ? { alt: description } : {}),
        },
        gone,
      );
      if (!target || gone()) {
        if (!gone()) setPhase({ at: 'preview', picture });
        return;
      }
      const res = await fetch(target.uploadUrl, {
        method: target.method,
        // Exactly the two headers the link was signed for (the browser sets the length).
        headers: {
          'Content-Type': target.signed['Content-Type'] ?? '',
          'If-None-Match': target.signed['If-None-Match'] ?? '',
        },
        body: picture.blob,
      }).catch(() => null);
      if (gone()) return;
      // 412: this very file is there already (a replay of a request that went through).
      if (!res || (!res.ok && res.status !== 412)) {
        setPhase({ at: 'preview', picture });
        setProblem(
          `Your ${noun} couldn’t be uploaded. Your story is saved; please try again.`,
        );
        return;
      }
      setSavedAlt(description);
      setPhase({
        at: 'done',
        url: picture.url,
        width: picture.width,
        height: picture.height,
      });
    } catch (err) {
      if (gone()) return;
      setPhase({ at: 'preview', picture });
      setProblem(refusal(err, noun));
    }
  }

  /** EditStory on the picture: removed, or its description changed. */
  async function edit(patch: { image: null | { alt: string | null } }) {
    const { draftId: id, version } = current();
    if (!id || !version) return false;
    try {
      const result = await calls.edit(id, version, patch);
      setVersion(result.version);
      return true;
    } catch (err) {
      if (err instanceof StaleVersion) await reload(id);
      setProblem(
        err instanceof StaleVersion
          ? 'Your story was changed in another tab or window. Please try again.'
          : `Your ${noun} couldn’t be changed. Your story is saved; please try again.`,
      );
      return false;
    }
  }

  async function remove() {
    stop();
    setProblem(null);
    if (phase.at === 'done' && !(await edit({ image: null }))) return;
    setPhase({ at: 'idle' });
    setAlt('');
    setSavedAlt('');
    setNotice(
      format === 'video'
        ? 'Thumbnail removed. Your video shows the thumbnail our video host picks.'
        : `${noun[0].toUpperCase()}${noun.slice(1)} removed.`,
    );
    if (fileInput.current) fileInput.current.value = '';
  }

  async function saveAlt() {
    const description = alt.trim();
    if (altRequired && !description) {
      setAltProblem(
        'Describe your picture in a few words, for people who can’t see it.',
      );
      return;
    }
    setAltProblem(null);
    if (await edit({ image: { alt: description || null } })) {
      setSavedAlt(description);
      setNotice('Description saved.');
    }
  }

  const shown =
    phase.at === 'preview' || phase.at === 'sending'
      ? {
          src: phase.picture.url,
          width: phase.picture.width,
          height: phase.picture.height,
        }
      : phase.at === 'done'
        ? { src: phase.url, width: phase.width, height: phase.height }
        : null;
  const busy = phase.at === 'reading' || phase.at === 'sending';
  const altId = `picture-alt-${format}`;

  return (
    <div data-picture-phase={phase.at} className="flex flex-col gap-3">
      {shown && (
        <Picture
          src={shown.src}
          width={shown.width}
          height={shown.height}
          alt={alt.trim() || `Your ${noun}`}
        />
      )}
      {shown && (
        <div>
          <label htmlFor={altId} className="mb-1.5 block font-semibold">
            Describe the {noun}
            {altRequired ? '' : ' (optional)'}
          </label>
          <input
            id={altId}
            className={input}
            maxLength={500}
            value={alt}
            aria-invalid={!!altProblem}
            aria-describedby={`${altId}-hint`}
            onChange={(e) => setAlt(e.target.value)}
          />
          <p id={`${altId}-hint`} className="mt-1 text-sm text-secondary-text">
            A few words for people who can’t see it, such as “Our church at
            sunrise”.
          </p>
          {altProblem && (
            <p role="alert" className="mt-1 text-sm text-destructive">
              {altProblem}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        {(phase.at === 'preview' || phase.at === 'sending') && (
          <button
            type="button"
            className={primary}
            disabled={busy}
            onClick={() => void add(phase.picture)}
          >
            {phase.at === 'sending' ? 'Adding…' : `Add this ${noun}`}
          </button>
        )}
        {phase.at === 'done' && alt.trim() !== savedAlt && (
          <button
            type="button"
            className={primary}
            onClick={() => void saveAlt()}
          >
            Save description
          </button>
        )}
        <label
          className={`${shown ? secondary : primary} cursor-pointer has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 ${busy ? 'pointer-events-none opacity-60' : ''}`}
        >
          {shown ? `Choose another ${noun}` : `Choose a ${noun}`}
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              e.target.value = '';
              void choose(chosen);
            }}
          />
        </label>
        {shown && (
          <button
            type="button"
            className={secondary}
            disabled={busy}
            onClick={() => void remove()}
          >
            Remove {noun}
          </button>
        )}
      </div>
      {phase.at === 'reading' && (
        <p className="text-sm text-secondary-text" role="status">
          Preparing your {noun}…
        </p>
      )}
      {!shown && phase.at === 'idle' && (
        <p className="text-sm text-secondary-text">
          A JPEG, PNG or WebP photo, no more than 3 times as wide as it is tall
          (or as tall as it is wide). We remove the photo’s hidden details, such
          as where it was taken, before it leaves your device.
        </p>
      )}
      {phase.at === 'done' && (
        <p className="text-sm font-semibold" role="status">
          {noun[0].toUpperCase()}
          {noun.slice(1)} added.
        </p>
      )}
      {notice && (
        <p className="text-sm text-secondary-text" role="status">
          {notice}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

/** api-user's refusal of the picture, in plain words. */
function refusal(err: unknown, noun: string): string {
  if (err instanceof ApiUserUnavailable) {
    return 'We can’t reach our server right now. Your story is saved; please try again in a moment.';
  }
  if (err instanceof StaleVersion) {
    return `Your story was changed in another tab or window. Please add your ${noun} again.`;
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
      return `You’ve started as many uploads as you can for now. Your story is saved: you can add your ${noun} from ${when}.`;
    }
    if (p.detail) return p.detail;
  }
  return `Your ${noun} couldn’t be added. Your story is saved; please try again.`;
}
