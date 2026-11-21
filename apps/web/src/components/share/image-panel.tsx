'use client';

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { RestartingText } from '@/components/restarting/restarting-message';
import {
  ApiUserProblem,
  plainMessage,
  restartWait,
  StaleVersion,
} from '@/lib/api-user';
import { PREFIX } from '@/lib/share-storage';
import { TRY_AGAIN_LATER } from '@/lib/try-again-later';
import { DropZone } from './drop-zone';
import type { ShareApi, StoryFormat, StoryPicture } from './share-api';
import { formatBytes } from './upload-panel';
import {
  AGREE_ASKS,
  AgreeAgain,
  agreeFirstMessage,
  agreementFirst,
  type Attempt,
  forgetAttempt,
  outcomeUnknown,
  useRuns,
  useUploadRequest,
} from './upload-request';
import { buttonVariants, Tabs, tabId } from '@heisreal/web-ui';
import { clampAspect, encodeWebp, type Encoded } from './picture-encode';
import { ThumbnailCropper, VideoMoment } from './thumbnail-crop';

/**
 * A story's picture (M2 plan PR 10; D53, D65, D80): a written story's image, an audio story's
 * picture, or a video's own thumbnail (Joel, 2026-10-30), shown in place of Bunny's.
 *
 * The browser re-encodes the chosen photo to WebP on a canvas (picture-encode.ts), at most 2048 px
 * on its longer side, and a small one enlarged with hard pixel edges to about 1,000 px (TC-7 A,
 * Joel 2026-11-21: no smallest size). A canvas carries no metadata, so EXIF (the camera, the time,
 * GPS) never leaves the device; the photo's own orientation is applied first. It checks the shape
 * (1:3..3:1) and the file's size (D53) and shows the result at its real shape, with the chosen
 * file's name. It has no description (Joel, 2026-11-14): readers show a neutral alt text.
 * Choosing a picture adds it straight away, as a video or audio file uploads once chosen (Joel,
 * 2026-11-09), except a video's thumbnail (thumbnail crop, Joel 2026-11-21): it's cut to the
 * video's shape first (TC-1 A + D, TC-2 A), and nothing is uploaded or saved until "Use this
 * thumbnail" or "Use this moment" (TC-6 A). The video's shape comes from the step (`video`); until
 * it's known the chooser waits with a plain line (TC-4). A new video takes the thumbnail off
 * (TC-3 B). Then the panel asks api-user for the upload (RequestUpload with `format: image`, the
 * same idempotent request as a video's: upload-request.ts), which puts the picture on the draft,
 * then PUTs the WebP straight to Bunny's storage with the presigned link. A line says whether it's
 * being prepared, uploading or added; one that failed keeps "Try again". Replacing or removing
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
 *   unfinished, with "Try again" to upload it again when this tab still has it.
 *
 * A request refused until the person agrees to a newer terms of use or testimony consent (plan
 * 4e) opens the flow's agree-again screen (`AgreeAgain`); once they agree, the picture is asked
 * for again, and if they go back it stays to add, with the reason.
 */

/** What the person reads when their prepared picture is over the largest picture file. */
const tooLarge = (size: number | null, maxBytes: number | null) =>
  size !== null && maxBytes !== null
    ? `This picture is too large: ${formatBytes(size)} once prepared, and the most we can take is ${formatBytes(maxBytes)}. Please choose a smaller one.`
    : 'This picture is too large. Please choose a smaller one.';

/**
 * `uploading`: being prepared or sent now; `unfinished`: chosen or on the story, its file not
 * there; `cropping`: a video's thumbnail being cut, not yet used (nothing uploaded); `stale`: a
 * new video's old thumbnail that couldn't be taken off yet (TC-3 B), with "Try again".
 */
export type PictureState =
  'none' | 'uploading' | 'unfinished' | 'cropping' | 'stale' | 'done';

/** The video a thumbnail is cut for (thumbnail crop TC-2, TC-3, TC-4; Joel 2026-11-21). */
export interface ThumbnailVideo {
  /** Its shape as shown, or null until it's known (then the chooser waits). */
  shape: { width: number; height: number } | null;
  /** Whether this tab has the video's file (else it's carried on from elsewhere). */
  inTab: boolean;
  /** This tab's video when this browser can play it: "A moment from your video". */
  playable: File | null;
  /** Steps each time a new video replaces the story's: the thumbnail comes off (TC-3 B). */
  replaced: number;
}

/** A photo chosen for a video's thumbnail, the right way up, kept in this tab only (TC-6 A). */
interface Photo {
  /** A blob: link to the chosen file, for the cropper. */
  url: string;
  bitmap: ImageBitmap;
  file: { name: string; size: number; lastModified: number };
}
const release = (photo: Photo) => {
  photo.bitmap.close();
  URL.revokeObjectURL(photo.url);
};

interface Prepared {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  /** The chosen file, as upload-request.ts knows it again. */
  file: { name: string; size: number; lastModified: number };
  /** The photo it was cut from (a video's thumbnail): "Change how it's cropped". */
  photo?: Photo;
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
  /** The chosen file's name, when this tab chose it (pictureName); null otherwise. */
  name: string | null;
}

/**
 * The chosen picture's file name, kept in this tab's storage per person and draft with the path it
 * was added as (Joel, 2026-11-14: show what was attached). Never sent to the server: after a
 * reload in another tab or on another device, no name is shown.
 */
const nameKey = (owner: string, draftId: string) =>
  `${PREFIX}${owner}:picture-name:${draftId}`;
export function pictureName(
  owner: string,
  draftId: string,
  path: string,
): string | null {
  try {
    const kept = JSON.parse(
      window.sessionStorage.getItem(nameKey(owner, draftId)) ?? 'null',
    ) as { path: string; name: string } | null;
    return kept?.path === path ? kept.name : null;
  } catch {
    return null;
  }
}
function keepPictureName(
  owner: string,
  draftId: string,
  kept: { path: string; name: string } | null,
) {
  try {
    if (kept)
      window.sessionStorage.setItem(
        nameKey(owner, draftId),
        JSON.stringify(kept),
      );
    else window.sessionStorage.removeItem(nameKey(owner, draftId));
  } catch {
    // storage blocked: the name is shown while the panel is on the page only
  }
}

/** What the step is told about a phase. */
const stateOf = (phase: Phase): PictureState =>
  phase.at === 'done' && phase.arrived
    ? 'done'
    : phase.at === 'idle'
      ? 'none'
      : phase.at === 'cropping'
        ? 'cropping'
        : phase.at === 'reading' || phase.at === 'sending'
          ? 'uploading'
          : 'unfinished';

const shownOf = (
  p: StoryPicture | null,
  name: (path: string) => string | null,
): Shown | null =>
  p
    ? {
        url: p.url,
        width: p.width,
        height: p.height,
        path: p.path,
        // null: api-user can't check (image uploads off), so nothing could be uploaded anyway.
        arrived: p.uploaded !== false,
        name: name(p.path),
      }
    : null;

type Phase =
  | { at: 'idle' }
  | { at: 'reading' }
  /** `granted`: its grant went through (or may have), so it's on the draft. */
  | { at: 'preview'; picture: Prepared; granted: boolean }
  | { at: 'sending'; picture: Prepared }
  /** A video's thumbnail being cut; `before` is what Cancel goes back to. */
  | { at: 'cropping'; photo: Photo; before: Phase }
  | ({ at: 'done' } & Shown);

const NOUN: Record<StoryFormat, string> = {
  written: 'picture',
  audio: 'picture',
  video: 'thumbnail',
};

// The library's button looks (BT-1 A), on plain buttons and links; their words wrap at large
// text sizes rather than widening the page.
const primary = buttonVariants({ wrap: true });
const secondary = buttonVariants({ variant: 'outline', wrap: true });

/** The chosen photo the right way up, or a plain reason it can't be read. */
async function decode(file: File): Promise<ImageBitmap | string> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return 'We can’t read that file as a picture. Choose a JPEG, PNG or WebP photo.';
  }
}

/** The encoded picture, ready to add, or a plain reason (over the largest picture file). */
function ready(
  encoded: Encoded | string,
  file: Prepared['file'],
  maxBytes: number,
): Prepared | string {
  if (typeof encoded === 'string') return encoded;
  if (encoded.blob.size > maxBytes)
    return tooLarge(encoded.blob.size, maxBytes);
  return {
    blob: encoded.blob,
    url: URL.createObjectURL(encoded.blob),
    width: encoded.width,
    height: encoded.height,
    file,
  };
}

/** Re-encodes the whole photo to WebP (no metadata), or answers a plain reason it can't be used. */
async function prepare(
  file: File,
  maxBytes: number,
): Promise<Prepared | string> {
  const bitmap = await decode(file);
  if (typeof bitmap === 'string') return bitmap;
  const { width, height } = bitmap;
  if (width > height * 3) {
    bitmap.close();
    return 'That picture is too wide. Choose one no more than 3 times as wide as it is tall, or crop it first.';
  }
  if (height > width * 3) {
    bitmap.close();
    return 'That picture is too tall. Choose one no more than 3 times as tall as it is wide, or crop it first.';
  }
  const encoded = await encodeWebp(bitmap, { x: 0, y: 0, width, height });
  bitmap.close();
  return ready(
    encoded,
    { name: file.name, size: file.size, lastModified: file.lastModified },
    maxBytes,
  );
}

/** The video's shape in words. */
const shapeName = (aspect: number) =>
  aspect > 1.01 ? 'landscape' : aspect < 0.99 ? 'portrait' : 'square';

/** Why a thumbnail came off when the video changed (TC-3 B). */
const TAKEN_OFF =
  'We’ve taken your thumbnail off because you changed your video. Choose one again if you still want it.';

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
  maxBytes,
  video,
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
  /** The largest picture file (the limits' `uploads.imageMaxBytes`): checked before anything is sent. */
  maxBytes: number;
  /** A video story's video, which its thumbnail is cut to. */
  video?: ThumbnailVideo;
}) {
  const noun = NOUN[format];
  const [phase, setPhaseState] = useState<Phase>({ at: 'idle' });
  const phaseRef = useRef<Phase>(phase);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  /**
   * A new video's old thumbnail still to come off (TC-3 B): set until a removal or another
   * thumbnail takes it off, and the step is held back meanwhile.
   */
  const [stale, setStaleState] = useState(false);
  const staleRef = useRef(false);
  const showsOld = (p: Phase) => p.at === 'done' || p.at === 'preview';
  /** What the step is told: the phase's state, or `stale` while the old thumbnail is still on. */
  const tell = () =>
    onStateRef.current?.(
      staleRef.current && showsOld(phaseRef.current)
        ? 'stale'
        : stateOf(phaseRef.current),
    );
  const setStale = (next: boolean) => {
    staleRef.current = next;
    setStaleState(next);
    tell();
  };
  /** The step hears of each phase as it's set, not a render later: its Continue checks it after waiting. */
  const setPhase = (next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
    tell();
  };
  /** The picture on the draft at the server, as last known: what a removal takes off. */
  const [attached, setAttachedState] = useState<Shown | null>(null);
  const attachedRef = useRef<Shown | null>(null);
  const setAttached = (shown: Shown | null) => {
    attachedRef.current = shown;
    setAttachedState(shown);
  };
  /**
   * A picture granted (or maybe granted: no answer) whose file isn't there yet, and its path when
   * known: what "Try again" uploads again if the story still has it after a replacement is discarded.
   */
  const held = useRef<{ picture: Prepared; path: string | null } | null>(null);
  /** The picture the person chose, kept while another tab's picture is shown (replace it?). */
  const [pending, setPending] = useState<Prepared | null>(null);
  /** Whether the panel is still on the page (the step, the person and the draft it was made for). */
  const alive = useRef(true);
  /** Stops the picture's file on its way up when the panel leaves the page (Joel's V-2 answer). */
  const sending = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    // A panel mounted afresh tells the step where it starts: an earlier panel's state isn't its own (Codex #211).
    tell();
    return () => {
      alive.current = false;
      sending.current?.abort();
    };
  }, []);
  const [problem, setProblem] = useState<React.ReactNode>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { begin } = useRuns();
  const agreeAgain = useContext(AgreeAgain);
  /** The blob: links this panel made, freed once nothing shows them and the draft hasn't them. */
  const blobs = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);
  /** The photos this tab has for the thumbnail (TC-6 A: never uploaded), freed once unused. */
  const photos = useRef(new Set<Photo>());
  /** The thumbnail on the story that was cut here, and from what: "Change how it's cropped". */
  const [cutFrom, setCutFrom] = useState<{ photo: Photo; path: string } | null>(
    null,
  );
  const cutFromRef = useRef(cutFrom);
  cutFromRef.current = cutFrom;
  /** Frees the photos nothing uses any more (the one being cut, or the one the thumbnail came from). */
  const tidy = (keep: (Photo | undefined)[]) => {
    for (const p of photos.current) {
      if (keep.includes(p)) continue;
      photos.current.delete(p);
      release(p);
    }
  };
  useEffect(() => {
    const made = photos.current;
    return () => {
      for (const p of made) release(p);
      made.clear();
    };
  }, []);
  const [tab, setTab] = useState<'picture' | 'moment'>('picture');
  const aspect = video?.shape
    ? clampAspect(video.shape.width / video.shape.height)
    : null;

  // The picture the story already has (another tab, or before a reload).
  useEffect(() => {
    if (!earlier) return;
    const shown = shownOf(earlier, (path) =>
      draftId ? pictureName(owner, draftId, path) : null,
    );
    attachedRef.current = shown;
    setAttachedState(shown);
    if (phaseRef.current.at === 'idle' && shown) {
      setPhase({ at: 'done', ...shown });
    }
    // Only when the story's picture is read again (its draft and person come with it).
  }, [earlier]);

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
    // The kept request is sent again for the very same picture, as it was, for the picture it
    // named then: a replay of one that went through answers its own path, and one that didn't is
    // checked against the story's picture as any request is.
    reuse: useCallback(
      (kept: Attempt, req) =>
        JSON.stringify({ ...kept.request, expectedImage: undefined }) ===
        JSON.stringify({ ...req, expectedImage: undefined }),
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
    return shownOf(story.image, (path) => pictureName(owner, id, path));
  }

  async function choose(file: File | undefined) {
    if (!file) return;
    if (format === 'video') return cut(file);
    setProblem(null);
    setNotice(null);
    setPending(null);
    // Uploading from the moment it's chosen, so a Continue already waiting won't move on without it.
    setPhase({ at: 'reading' });
    const gone = begin();
    const prepared = await prepare(file, maxBytes);
    if (gone()) return;
    if (typeof prepared === 'string') {
      setPhase({ at: 'idle' });
      setProblem(prepared);
      return;
    }
    blobs.current.add(prepared.url);
    // Added at once, no click needed (Joel, 2026-11-09); a failure stops at the preview.
    await add(prepared, false);
  }

  /** A video's thumbnail: the photo opens in the cropper, at the video's shape (nothing sent). */
  async function cut(file: File) {
    if (!aspect) return;
    setProblem(null);
    setNotice(null);
    setPending(null);
    const now = phaseRef.current;
    const before = now.at === 'cropping' ? now.before : now;
    setPhase({ at: 'reading' });
    const gone = begin();
    const bitmap = await decode(file);
    if (gone()) {
      if (typeof bitmap !== 'string') bitmap.close();
      return;
    }
    if (typeof bitmap === 'string') {
      setPhase(before);
      setProblem(bitmap);
      return;
    }
    const photo: Photo = {
      url: URL.createObjectURL(file),
      bitmap,
      file: {
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
      },
    };
    photos.current.add(photo);
    tidy([photo, cutFromRef.current?.photo]);
    setPhase({ at: 'cropping', photo, before });
  }

  /** "Use this thumbnail": the chosen part, redrawn and added. */
  async function applyCut(
    photo: Photo,
    before: Phase,
    pixels: { x: number; y: number; width: number; height: number },
  ) {
    setProblem(null);
    const gone = begin();
    setPhase({ at: 'reading' });
    const prepared = ready(
      await encodeWebp(photo.bitmap, pixels),
      photo.file,
      maxBytes,
    );
    if (gone()) return;
    if (typeof prepared === 'string') {
      setPhase({ at: 'cropping', photo, before });
      setProblem(prepared);
      return;
    }
    blobs.current.add(prepared.url);
    await add({ ...prepared, photo }, false);
  }

  /** "Use this moment": the video's frame, redrawn and added. */
  async function applyMoment(
    frame: HTMLVideoElement,
    rect: { x: number; y: number; width: number; height: number },
    name: string,
  ) {
    setProblem(null);
    setNotice(null);
    setPending(null);
    const before = phaseRef.current;
    const gone = begin();
    setPhase({ at: 'reading' });
    const encoded = await encodeWebp(frame, rect);
    const prepared = ready(
      encoded,
      {
        name,
        size: typeof encoded === 'string' ? 0 : encoded.blob.size,
        lastModified: Date.now(),
      },
      maxBytes,
    );
    if (gone()) return;
    if (typeof prepared === 'string') {
      setPhase(before);
      setProblem(prepared);
      return;
    }
    blobs.current.add(prepared.url);
    await add(prepared, false);
  }

  // A new video takes the thumbnail off, whatever its shape (TC-3 B), and says so; a crop not yet
  // used is dropped (nothing of it was sent).
  const replaced = video?.replaced ?? 0;
  const seenReplaced = useRef(replaced);
  useEffect(() => {
    if (replaced === seenReplaced.current) return;
    seenReplaced.current = replaced;
    setCutFrom(null);
    tidy([]);
    const was = phaseRef.current;
    const under = was.at === 'cropping' ? was.before : was;
    if (was.at === 'cropping') setPhase(under);
    if (attachedRef.current || under.at === 'done' || under.at === 'preview') {
      // Held until it's off: a failed removal keeps "Try again" and the step waits.
      setStale(true);
      void remove(TAKEN_OFF);
    } else if (was.at === 'cropping') {
      setNotice(TAKEN_OFF);
    }
    // Only when the step says the video was replaced.
  }, [replaced]);

  async function add(
    picture: Prepared,
    granted: boolean,
    asked = 0,
  ): Promise<void> {
    setProblem(null);
    setNotice(null);
    setPending(null);
    const gone = begin();
    setPhase({ at: 'sending', picture });
    /** The story's picture as this panel showed it when the person chose to add theirs. */
    const knew = attachedRef.current;
    const back = (onDraft: boolean, reason: React.ReactNode) => {
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
        name: picture.file.name,
      };
      if (shown.path) {
        keepPictureName(owner, ready.draftId, {
          path: shown.path,
          name: picture.file.name,
        });
      }
      setAttached(shown);
      // The new thumbnail replaced the old one on the story.
      if (staleRef.current) setStale(false);
      held.current = { picture, path: shown.path };
      const controller = new AbortController();
      sending.current = controller;
      const res = await fetch(target.uploadUrl, {
        method: target.method,
        signal: controller.signal,
        // Exactly the two headers the link was signed for (the browser sets the length).
        headers: {
          'Content-Type': target.signed['Content-Type'] ?? '',
          'If-None-Match': target.signed['If-None-Match'] ?? '',
        },
        body: picture.blob,
      })
        .catch(() => null)
        .finally(() => {
          if (sending.current === controller) sending.current = null;
        });
      if (left()) return;
      // 412: this very file is there already (a replay of a request whose PUT went through).
      // Otherwise the request stays kept, so trying again replays it for the same path.
      if (!res || (!res.ok && res.status !== 412)) {
        return back(true, `${TRY_AGAIN_LATER} Your story is saved.`);
      }
      forgetAttempt(owner, 'image-request', ready.draftId);
      held.current = null;
      const arrived = { ...shown, arrived: true };
      setAttached(arrived);
      setCutFrom(
        picture.photo ? { photo: picture.photo, path: shown.path } : null,
      );
      if (picture.photo) tidy([picture.photo]);
      setPhase({ at: 'done', ...arrived });
    } catch (err) {
      if (left()) return;
      if (
        err instanceof ApiUserProblem &&
        err.problem.code === 'image_changed'
      ) {
        return changed(picture, current().draftId);
      }
      const which = agreementFirst(err);
      if (which) {
        // Once they agree, the picture is asked for again: its kept request is replayed, so a
        // grant made before the refusal is finished rather than made (and counted) again.
        if (asked < AGREE_ASKS && (await agreeAgain(which))) {
          if (left()) return;
          return add(picture, granted, asked + 1);
        }
        if (left()) return;
        return back(granted, agreeFirstMessage(which, `add your ${noun}`));
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
      setProblem(TRY_AGAIN_LATER);
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
   * EditStory on the picture: removed. Its answer is used only by this run and for this draft: after sign-out, another person or another draft, nothing is
   * kept (no version written to the tab, no draft read again) and nothing shown (Codex #140).
   */
  async function edit(
    patch: { image: null },
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
          : plainMessage(
              err,
              `Your ${noun} couldn’t be changed. Your story is saved; please try again.`,
              'Your story is saved.',
            ),
      );
      return null;
    }
  }

  /** Takes the picture off; `why` is said instead of the usual line (a new video, TC-3 B). */
  async function remove(why?: string) {
    const gone = begin();
    setProblem(null);
    setNotice(null);
    setPending(null);
    if (fileInput.current) fileInput.current.value = '';
    const cleared = (notice: string) => {
      setStale(false);
      setPhase({ at: 'idle' });
      setNotice(why ?? notice);
    };
    const removed =
      format === 'video'
        ? 'Thumbnail removed. Your video shows the thumbnail our video host picks.'
        : `${noun[0].toUpperCase()}${noun.slice(1)} removed.`;
    const id = current().draftId;
    // As the panel is now, after the wait: a save before it may have changed what it shows.
    const was = phaseRef.current;
    // A replacement not granted is only on this device: the story keeps the picture it has. Which
    // one that is, and whether its file arrived, is read from the story, never assumed.
    if (was.at === 'preview' && !was.granted) {
      if (!id) return cleared(removed);
      const knew = attachedRef.current;
      let now: Shown | null;
      try {
        now = await read(id);
      } catch {
        if (gone() || current().draftId !== id) return;
        setProblem(TRY_AGAIN_LATER);
        return;
      }
      if (gone() || current().draftId !== id) return;
      setAttached(now);
      if (!now) {
        forgetAttempt(owner, 'image-request', id);
        keepPictureName(owner, id, null);
        held.current = null;
        return cleared(knew ? `Your story has no ${noun}.` : removed);
      }
      const unfinished = held.current;
      if (!now.arrived && unfinished && unfinished.path === now.path) {
        // This tab's own picture whose upload didn't finish: "Try again" uploads it (same path).
        setPhase({ at: 'preview', picture: unfinished.picture, granted: true });
        setProblem(
          `Your earlier ${noun} didn’t finish uploading. Try again to finish, or remove it.`,
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
    if (was.at === 'done' || was.at === 'preview') {
      const edited = await edit({ image: null }, gone);
      if (!edited) return;
      forgetAttempt(owner, 'image-request', edited);
      keepPictureName(owner, edited, null);
      held.current = null;
      setAttached(null);
      setCutFrom(null);
    }
    cleared(removed);
  }

  const shown =
    phase.at === 'preview' || phase.at === 'sending'
      ? {
          src: phase.picture.url,
          width: phase.picture.width,
          height: phase.picture.height,
          name: phase.picture.file.name,
        }
      : phase.at === 'done'
        ? {
            src: phase.url,
            width: phase.width,
            height: phase.height,
            name: phase.name,
          }
        : null;
  const busy = phase.at === 'reading' || phase.at === 'sending';
  /** A video's thumbnail waits until the video's shape is known (TC-4). */
  const waiting = format === 'video' && !aspect;
  const cropping = phase.at === 'cropping' ? phase : null;
  /** "A moment from your video" only when this browser can play this tab's video (TC-1 D). */
  const moment = format === 'video' && !waiting && !cropping && video?.playable;
  const chosenTab = moment ? tab : 'picture';
  const recrop =
    phase.at === 'done' && cutFrom?.path === phase.path ? cutFrom : null;

  const chooser = (
    <DropZone
      // Like the chooser, which is off while a picture is prepared or sent.
      onFile={(file) => {
        if (!busy) void choose(file);
      }}
    >
      <p className="text-secondary-text">
        {shown || cropping
          ? `Want to use a different ${noun}? Drag it here, or`
          : 'Drag it here, or'}
      </p>
      <label
        className={`${shown || cropping ? secondary : primary} cursor-pointer has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 ${busy ? 'pointer-events-none opacity-60' : ''}`}
      >
        {shown || cropping ? `Choose another ${noun}` : `Choose a ${noun}`}
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
      {!shown && !cropping && phase.at === 'idle' && (
        <p className="text-sm text-secondary-text">
          {format === 'video'
            ? 'A JPEG, PNG or WebP photo. We cut it to your video’s shape, and remove the photo’s hidden details, such as where it was taken, before it leaves your device.'
            : 'A JPEG, PNG or WebP photo, no more than 3 times as wide as it is tall (or as tall as it is wide). We remove the photo’s hidden details, such as where it was taken, before it leaves your device.'}
        </p>
      )}
    </DropZone>
  );

  return (
    <div data-picture-phase={phase.at} className="flex flex-col gap-3">
      {shown && (
        <Picture
          src={shown.src}
          width={shown.width}
          height={shown.height}
          alt={`Your ${noun}`}
        />
      )}
      {(shown?.name || cropping) && (
        <p data-attached-name="" className="[overflow-wrap:anywhere]">
          <span className="font-semibold">
            {cropping ? 'Chosen:' : 'Attached:'}
          </span>{' '}
          {cropping ? cropping.photo.file.name : shown?.name}
        </p>
      )}
      {cropping && aspect && (
        <ThumbnailCropper
          // A new photo or shape starts centred again.
          key={`${cropping.photo.url} ${aspect}`}
          src={cropping.photo.url}
          aspect={aspect}
          shapeName={shapeName(aspect)}
          busy={busy}
          onUse={(pixels) =>
            void applyCut(cropping.photo, cropping.before, pixels)
          }
          onCancel={() => {
            setProblem(null);
            setPhase(cropping.before);
          }}
        />
      )}
      {waiting ? (
        <p data-thumbnail-waiting="" className="text-secondary-text">
          {video?.inTab
            ? 'We can’t read your video’s shape in this browser, so we’ll ask for your thumbnail once our video host has it ready (usually a few minutes). You can carry on with your story and come back to this step.'
            : 'We’ll ask for your thumbnail once our video host has your video ready (usually a few minutes), so it can be cut to your video’s shape. You can carry on with your story and come back to this step.'}
        </p>
      ) : moment ? (
        <div>
          <Tabs
            label="Thumbnail from"
            idBase="thumbnail"
            panelId="thumbnail-panel"
            value={chosenTab}
            onValueChange={setTab}
            items={[
              { value: 'picture', label: 'A picture' },
              { value: 'moment', label: 'A moment from your video' },
            ]}
          />
          <div
            id="thumbnail-panel"
            role="tabpanel"
            aria-labelledby={tabId('thumbnail', chosenTab)}
            className="pt-4"
          >
            {chosenTab === 'moment' ? (
              <VideoMoment
                file={moment}
                busy={busy}
                onUse={(frame, rect, name) =>
                  void applyMoment(frame, rect, name)
                }
              />
            ) : (
              chooser
            )}
          </div>
        </div>
      ) : (
        chooser
      )}
      {shown && (
        <div className="flex flex-wrap gap-3">
          {phase.at === 'preview' && !stale && (
            <button
              type="button"
              className={primary}
              onClick={() => void add(phase.picture, phase.granted)}
            >
              Try again
            </button>
          )}
          {showsOld(phase) && stale && !pending && (
            <button
              type="button"
              className={primary}
              disabled={busy}
              onClick={() => void remove(TAKEN_OFF)}
            >
              Try again
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
          {recrop && !pending && !waiting && !stale && (
            <button
              type="button"
              className={secondary}
              disabled={busy}
              onClick={() => {
                setProblem(null);
                setNotice(null);
                setPhase({
                  at: 'cropping',
                  photo: recrop.photo,
                  before: phase,
                });
              }}
            >
              Change how it’s cropped
            </button>
          )}
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
        </div>
      )}
      {phase.at === 'reading' && (
        <p className="text-sm text-secondary-text" role="status">
          Preparing your {noun}…
        </p>
      )}
      {phase.at === 'sending' && (
        <p className="text-sm text-secondary-text" role="status">
          Uploading your {noun}…
        </p>
      )}
      {phase.at === 'done' && !pending && !stale && phase.arrived && (
        <p className="text-sm font-semibold" role="status">
          <span aria-hidden="true">✓ </span>
          {noun[0].toUpperCase()}
          {noun.slice(1)} added. You can continue.
        </p>
      )}
      {phase.at === 'done' && !pending && !stale && !phase.arrived && (
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
        <p role="alert" className="text-danger-text">
          {problem}
        </p>
      )}
    </div>
  );
}

/** api-user's refusal of the picture, in plain words. */
function refusal(err: unknown, noun: string): React.ReactNode {
  const restarting = restartWait(err);
  if (restarting !== undefined) {
    // The database restarting: named, with when to try again (Joel, 2026-11-09).
    return <RestartingText seconds={restarting} kept="Your story is saved." />;
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
    // An admin lowered the largest picture file since this page read the limits.
    const errors = (p as { errors?: { pointer?: string }[] }).errors;
    if (
      p.code === 'validation_failed' &&
      errors?.some((e) => e.pointer === '/fileSizeBytes')
    ) {
      return tooLarge(null, null);
    }
  }
  // On our side: only the plain message (Joel, 2026-11-09); else the refusal's own words.
  return plainMessage(
    err,
    `Your ${noun} couldn’t be added. Your story is saved; please try again.`,
    'Your story is saved.',
  );
}
