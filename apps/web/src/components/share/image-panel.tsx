'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiUserProblem,
  ApiUserUnavailable,
  StaleVersion,
} from '@/lib/api-user';
import type { ShareApi, StoryFormat, StoryPicture } from './share-api';
import { formatBytes } from './upload-panel';
import {
  type Attempt,
  forgetAttempt,
  outcomeUnknown,
  useRuns,
  useUploadRequest,
} from './upload-request';

/**
 * A story's picture (M2 plan PR 10; D53, D65, D80): a written story's image, an audio story's
 * picture, or a video's own thumbnail (Joel, 2026-10-30), shown in place of Bunny's.
 *
 * The browser re-encodes the chosen photo to WebP on a canvas, at most 2048 px on its longer side.
 * A canvas carries no metadata, so EXIF (the camera, the time, GPS) never leaves the device; the
 * photo's own orientation is applied first. It checks the shape (1:3..3:1) and size (D53) and
 * shows the result at its real shape with an optional description box (never required, Joel 2026-10-30).
 * "Add this picture" asks api-user for the upload (RequestUpload with `format: image`, the
 * same idempotent request as a video's: upload-request.ts), which puts the picture on the draft,
 * then PUTs the WebP straight to Bunny's storage with the presigned link. Replacing or removing
 * it never deletes the old file (an approved copy may still show it; the clean-up sweep does).
 * The request is kept until the PUT succeeds or finds the file there (412): trying again after a
 * failed or lost PUT replays it, for the same path with a fresh link, never a new grant.
 *
 * What the draft has at the server (`attached`) is tracked apart from what's shown: a picture whose
 * grant went through is on the draft even while its PUT is still to succeed, so removing it is an
 * edit; a replacement not yet granted is only on this device, so discarding it keeps the picture
 * the story has. Every answer is used only by the run that asked, for the draft it asked about:
 * after sign-out, another person, or another draft, nothing is kept or shown (Codex #140).
 *
 * The server holds the facts (Codex #140 round 3), not this panel's memory:
 * - every request names the picture the person saw when they asked (`expectedImage`), and
 *   api-user refuses it (`409 image_changed`) if the story has another one by then, whatever its
 *   version. The panel then shows the story's picture and the person chooses to replace it;
 * - a picture counts as finished only once its PUT succeeded here, or the story says its file
 *   arrived (`image.uploaded`, which api-user checks at the storage). Discarding a replacement
 *   reads the story first and shows its picture as it is: one whose file never arrived stays
 *   unfinished, with "Add" to try its upload again when this tab still has it.
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

/** A picture on the story: its link (none until it can be read back), size and path, and whether its file arrived. */
interface Shown {
  url: string | null;
  width: number;
  height: number;
  /** Its path at the server: what tells two pictures apart. */
  path: string;
  /** Whether its file is there (its PUT succeeded, or the story says so). */
  arrived: boolean;
}

const shownOf = (p: StoryPicture | null): Shown | null =>
  p
    ? {
        url: p.url,
        width: p.width,
        height: p.height,
        path: p.path,
        // null: api-user can't check (image uploads off), so nothing could be uploaded anyway.
        arrived: p.uploaded !== false,
      }
    : null;

type Phase =
  | { at: 'idle' }
  | { at: 'reading' }
  /** `granted`: its grant went through (or may have), so it's on the draft. */
  | { at: 'preview'; picture: Prepared; granted: boolean }
  | { at: 'sending'; picture: Prepared }
  | ({ at: 'done' } & Shown);

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
  const [phase, setPhase] = useState<Phase>({ at: 'idle' });
  /** The picture on the draft at the server, as last known: what a removal takes off. */
  const [attached, setAttachedState] = useState<Shown | null>(null);
  const attachedRef = useRef<Shown | null>(null);
  const setAttached = (shown: Shown | null) => {
    attachedRef.current = shown;
    setAttachedState(shown);
  };
  /**
   * A picture granted (or maybe granted: no answer) whose file isn't there yet, and its path when
   * known: what "Add" uploads again if the story still has it after a replacement is discarded.
   */
  const held = useRef<{ picture: Prepared; path: string | null } | null>(null);
  /** The picture the person chose, kept while another tab's picture is shown (replace it?). */
  const [pending, setPending] = useState<Prepared | null>(null);
  const [alt, setAlt] = useState('');
  const [savedAlt, setSavedAlt] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { begin } = useRuns();
  /** The blob: links this panel made, freed once nothing shows them and the draft hasn't them. */
  const blobs = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);

  // The picture the story already has (another tab, or before a reload).
  useEffect(() => {
    if (!earlier) return;
    const shown = shownOf(earlier);
    attachedRef.current = shown;
    setAttachedState(shown);
    setPhase((p) => (p.at === 'idle' && shown ? { at: 'done', ...shown } : p));
    setAlt(earlier.alt ?? '');
    setSavedAlt(earlier.alt ?? '');
  }, [earlier]);

  useEffect(() => {
    onState?.(
      phase.at === 'done' && phase.arrived
        ? 'done'
        : phase.at === 'idle'
          ? 'none'
          : 'unfinished',
    );
  }, [phase, onState]);

  // A blob: link is freed once nothing shows it and it isn't the draft's picture (which a
  // discarded replacement goes back to).
  useEffect(() => {
    const inUse = [
      phase.at === 'preview' || phase.at === 'sending'
        ? phase.picture.url
        : phase.at === 'done'
          ? phase.url
          : null,
      attached?.url,
      pending?.url,
      held.current?.picture.url,
    ];
    for (const url of blobs.current) {
      if (inUse.includes(url)) continue;
      blobs.current.delete(url);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }, [phase, attached, pending]);
  useEffect(() => {
    const made = blobs.current;
    return () => {
      for (const url of made)
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };
  }, []);

  const request = useUploadRequest({
    calls,
    owner,
    slot: 'image-request',
    prepare: prepareDraft,
    reload,
    setVersion,
    onProblem: setProblem,
    // The kept request is sent again for the very same picture; a changed description is saved
    // once it's added (Save description), not made into another grant. It's sent as it was, for
    // the picture it named then: a replay of one that went through answers its own path, and one
    // that didn't is checked against the story's picture as any request is.
    reuse: useCallback(
      (kept: Attempt, req) =>
        JSON.stringify({
          ...kept.request,
          alt: undefined,
          expectedImage: undefined,
        }) ===
        JSON.stringify({ ...req, alt: undefined, expectedImage: undefined }),
      [],
    ),
    keep: true,
  });

  /** The story's picture at the server now (and its version, kept if it moved on). */
  async function read(id: string): Promise<Shown | null> {
    const story = await calls.story(id);
    const { version } = current();
    if (current().draftId === id && (!version || story.version > version)) {
      setVersion(story.version);
    }
    if (story.image) {
      setAlt(story.image.alt ?? '');
      setSavedAlt(story.image.alt ?? '');
    }
    return shownOf(story.image);
  }

  async function choose(file: File | undefined) {
    if (!file) return;
    setProblem(null);
    setNotice(null);
    setPending(null);
    const gone = begin();
    setPhase({ at: 'reading' });
    const prepared = await prepare(file);
    if (gone()) return;
    if (typeof prepared === 'string') {
      setPhase({ at: 'idle' });
      setProblem(prepared);
      return;
    }
    blobs.current.add(prepared.url);
    setPhase({ at: 'preview', picture: prepared, granted: false });
  }

  async function add(picture: Prepared, granted: boolean) {
    const description = alt.trim();
    setProblem(null);
    setNotice(null);
    setPending(null);
    const gone = begin();
    setPhase({ at: 'sending', picture });
    /** The story's picture as this panel showed it when the person chose to add theirs. */
    const knew = attachedRef.current;
    const back = (onDraft: boolean, reason: string | null) => {
      setPhase({ at: 'preview', picture, granted: onDraft });
      setProblem(reason);
    };
    // Left behind: signed out, another person, or (once it has one) another draft (Codex #140).
    let left = gone;
    try {
      const ready = await prepareDraft();
      if (gone()) return;
      if (typeof ready === 'string') return back(granted, ready);
      left = () => gone() || current().draftId !== ready.draftId;
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
          expectedImage: knew?.path ?? null,
        },
        gone,
      );
      if (left()) return;
      // No target: `prepare`'s reason is already shown (onProblem).
      if (!target) {
        setPhase({ at: 'preview', picture, granted });
        return;
      }
      // Granted: the picture is on the draft now, whether or not its file arrives.
      const shown: Shown = {
        url: picture.url,
        width: picture.width,
        height: picture.height,
        path: target.path ?? '',
        arrived: false,
      };
      setAttached(shown);
      held.current = { picture, path: shown.path };
      const res = await fetch(target.uploadUrl, {
        method: target.method,
        // Exactly the two headers the link was signed for (the browser sets the length).
        headers: {
          'Content-Type': target.signed['Content-Type'] ?? '',
          'If-None-Match': target.signed['If-None-Match'] ?? '',
        },
        body: picture.blob,
      }).catch(() => null);
      if (left()) return;
      // 412: this very file is there already (a replay of a request whose PUT went through).
      // Otherwise the request stays kept, so trying again replays it for the same path.
      if (!res || (!res.ok && res.status !== 412)) {
        return back(
          true,
          `Your ${noun} couldn’t be uploaded. Your story is saved; please try again.`,
        );
      }
      forgetAttempt(owner, 'image-request', ready.draftId);
      held.current = null;
      const arrived = { ...shown, arrived: true };
      setAttached(arrived);
      // A replay keeps the description it was first sent with; a newer one is offered to save.
      setSavedAlt(target.sent.alt?.trim() ?? '');
      setPhase({ at: 'done', ...arrived });
    } catch (err) {
      if (left()) return;
      if (
        err instanceof ApiUserProblem &&
        err.problem.code === 'image_changed'
      ) {
        return changed(picture, current().draftId);
      }
      // No answer: it may have gone through, so it counts as on the draft (its path unknown).
      if (outcomeUnknown(err)) held.current = { picture, path: null };
      back(granted || outcomeUnknown(err), refusal(err, noun));
    }
  }

  /**
   * api-user refused the picture: the story has another one than the person saw (another tab or
   * window, or an earlier try whose answer was lost). Show the story's picture now; replacing it
   * is the person's choice, asked for with this picture in view.
   */
  async function changed(picture: Prepared, id: string | null) {
    const gone = begin();
    const left = () => gone() || current().draftId !== id;
    let now: Shown | null;
    try {
      if (!id) throw new Error('no draft');
      now = await read(id);
    } catch {
      if (left()) return;
      setPhase({ at: 'preview', picture, granted: false });
      setProblem(
        `Your story’s ${noun} was changed in another tab or window. Please try again in a moment.`,
      );
      return;
    }
    if (left()) return;
    setAttached(now);
    if (now) {
      setPending(picture);
      setPhase({ at: 'done', ...now });
      setProblem(
        `Your story’s ${noun} was changed in another tab or window. This is the ${noun} it has now. To use the one you chose instead, choose “Replace with my ${noun}”.`,
      );
    } else {
      setPhase({ at: 'preview', picture, granted: false });
      setProblem(
        `Your story’s ${noun} was removed in another tab or window. Add yours again if you still want it.`,
      );
    }
  }

  /**
   * EditStory on the picture: removed, or its description changed. Its answer is used only by
   * this run and for this draft: after sign-out, another person or another draft, nothing is
   * kept (no version written to the tab, no draft read again) and nothing shown (Codex #140).
   */
  async function edit(
    patch: { image: null | { alt: string | null } },
    gone: () => boolean,
  ): Promise<string | null> {
    const { draftId: id, version } = current();
    if (!id || !version) return null;
    const left = () => gone() || current().draftId !== id;
    try {
      const result = await calls.edit(id, version, patch);
      if (left()) return null;
      setVersion(result.version);
      return id;
    } catch (err) {
      if (left()) return null;
      if (err instanceof StaleVersion) {
        await reload(id).catch(() => false);
        if (left()) return null;
      }
      setProblem(
        err instanceof StaleVersion
          ? 'Your story was changed in another tab or window. Please try again.'
          : `Your ${noun} couldn’t be changed. Your story is saved; please try again.`,
      );
      return null;
    }
  }

  async function remove() {
    const gone = begin();
    setProblem(null);
    setNotice(null);
    setPending(null);
    if (fileInput.current) fileInput.current.value = '';
    const cleared = (notice: string) => {
      setPhase({ at: 'idle' });
      setAlt('');
      setSavedAlt('');
      setNotice(notice);
    };
    const removed =
      format === 'video'
        ? 'Thumbnail removed. Your video shows the thumbnail our video host picks.'
        : `${noun[0].toUpperCase()}${noun.slice(1)} removed.`;
    const id = current().draftId;
    // A replacement not granted is only on this device: the story keeps the picture it has. Which
    // one that is, and whether its file arrived, is read from the story, never assumed.
    if (phase.at === 'preview' && !phase.granted) {
      if (!id) return cleared(removed);
      const knew = attached;
      let now: Shown | null;
      try {
        now = await read(id);
      } catch {
        if (gone() || current().draftId !== id) return;
        setProblem(
          `We can’t check your story’s ${noun} right now. Please try again in a moment.`,
        );
        return;
      }
      if (gone() || current().draftId !== id) return;
      setAttached(now);
      if (!now) {
        forgetAttempt(owner, 'image-request', id);
        held.current = null;
        return cleared(knew ? `Your story has no ${noun}.` : removed);
      }
      const unfinished = held.current;
      if (!now.arrived && unfinished && unfinished.path === now.path) {
        // This tab's own picture whose upload didn't finish: "Add" tries it again (same path).
        setPhase({ at: 'preview', picture: unfinished.picture, granted: true });
        setProblem(
          `Your earlier ${noun} didn’t finish uploading. Add it again to finish, or remove it.`,
        );
        return;
      }
      setPhase({ at: 'done', ...now });
      if (now.arrived && knew?.path !== now.path) {
        setNotice(
          `Your story still has the ${noun} you added before. Remove it too if you don’t want it.`,
        );
      }
      return;
    }
    // On the draft (added, or granted with its file still to arrive): taken off at the server
    // first, at the draft's version.
    if (phase.at === 'done' || phase.at === 'preview') {
      const edited = await edit({ image: null }, gone);
      if (!edited) return;
      forgetAttempt(owner, 'image-request', edited);
      held.current = null;
      setAttached(null);
    }
    cleared(removed);
  }

  async function saveAlt() {
    const description = alt.trim();
    const gone = begin();
    if (await edit({ image: { alt: description || null } }, gone)) {
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
            Describe the {noun} (optional)
          </label>
          <input
            id={altId}
            className={input}
            maxLength={500}
            value={alt}
            aria-describedby={`${altId}-hint`}
            onChange={(e) => setAlt(e.target.value)}
          />
          <p id={`${altId}-hint`} className="mt-1 text-sm text-secondary-text">
            A few words for people who can’t see it, such as “Our church at
            sunrise”.
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        {(phase.at === 'preview' || phase.at === 'sending') && (
          <button
            type="button"
            className={primary}
            disabled={busy}
            onClick={() =>
              void add(phase.picture, phase.at === 'preview' && phase.granted)
            }
          >
            {phase.at === 'sending' ? 'Adding…' : `Add this ${noun}`}
          </button>
        )}
        {phase.at === 'done' && pending && (
          <button
            type="button"
            className={primary}
            onClick={() => void add(pending, false)}
          >
            Replace with my {noun}
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
            {phase.at === 'preview' && !phase.granted && attached
              ? `Keep the earlier ${noun}`
              : `Remove ${noun}`}
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
      {phase.at === 'done' && !pending && phase.arrived && (
        <p className="text-sm font-semibold" role="status">
          {noun[0].toUpperCase()}
          {noun.slice(1)} added.
        </p>
      )}
      {phase.at === 'done' && !pending && !phase.arrived && (
        <p className="text-sm font-semibold" role="status">
          Your story has this {noun}, but it didn’t finish uploading. Choose it
          again, or remove it.
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
