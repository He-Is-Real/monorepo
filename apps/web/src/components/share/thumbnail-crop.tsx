'use client';

import { useEffect, useRef, useState } from 'react';
import Cropper, { type Area, type Point } from 'react-easy-crop';
import { buttonVariants, Text } from '@heisreal/web-ui';
import { centred, clampAspect } from './picture-encode';

/**
 * A video's thumbnail, cut to the video's shape in the browser (thumbnail crop, Joel 2026-11-21:
 * TC-1 A + D, TC-2 A, TC-8 A). Two ways to make one:
 *
 * - `ThumbnailCropper`: a crop box with the video's fixed shape over the chosen photo
 *   (react-easy-crop: drag, pinch, wheel), starting centred and as large as it can be, with a
 *   zoom slider, − and + buttons, "Centre", and live previews of the Browse card and the story
 *   page's player. Keyboard (the doc's "Keyboard and screen readers"): the picture is one stop in
 *   the Tab order; arrows move it (Shift: more), + and − zoom, 0 centres it; a polite spoken line
 *   says where the crop is after a move.
 * - `VideoMoment`: a slider through the video; the browser grabs that frame, already its shape.
 *
 * Nothing here uploads or saves: the panel does that on "Use this thumbnail" / "Use this moment"
 * (TC-6: no autosave while cropping).
 */

const primary = buttonVariants({ wrap: true });
const secondary = buttonVariants({ variant: 'outline', wrap: true });
const square = buttonVariants({ variant: 'outline', size: 'icon' });

/** The Browse card keeps its picture between tall 9:16 and wide 2:1 (cropped around the middle beyond). */
const CARD_MIN = 9 / 16;
const CARD_MAX = 2;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.2;
/** Arrow keys move the picture this many screen pixels; with Shift, five times as far. */
const KEY_STEP = 10;

/** Where the middle of the crop is on the picture, in words. */
function where(fx: number, fy: number): string {
  const v = fy < 0.4 ? 'top' : fy > 0.6 ? 'bottom' : 'middle';
  const h = fx < 0.4 ? 'left' : fx > 0.6 ? 'right' : '';
  if (v === 'middle') return h ? `the ${h} side` : 'the middle';
  return `the ${v}${h ? ` ${h}` : ''}`;
}

/** What is read out after a move: "Zoom 1.5 times. Showing the top left of your picture." */
export function describeCrop(zoom: number, area: Area): string {
  const z = zoom.toFixed(1).replace(/\.0$/, '');
  const fx = (area.x + area.width / 2) / 100;
  const fy = (area.y + area.height / 2) / 100;
  return `Zoom ${z} times. Showing ${where(fx, fy)} of your picture.`;
}

/** A crop in percentages, in the picture's own pixels: unrounded (a tiny picture's pixels count). */
const sourceRect = (
  area: Area,
  natural: { width: number; height: number },
): Area => ({
  x: (area.x / 100) * natural.width,
  y: (area.y / 100) * natural.height,
  width: (area.width / 100) * natural.width,
  height: (area.height / 100) * natural.height,
});

/** The chosen part of the picture in a box of `aspect`, cut around its middle if the shapes differ. */
function Framed({
  src,
  natural,
  area,
  aspect,
  className,
  style,
  children,
}: {
  src: string;
  natural: { width: number; height: number };
  area: Area;
  aspect: number;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const px = sourceRect(area, natural);
  // Cut around its middle to the box's shape (no rounding: a tiny picture's pixels count).
  const box =
    px.width / px.height > aspect
      ? {
          ...px,
          x: px.x + (px.width - px.height * aspect) / 2,
          width: px.height * aspect,
        }
      : {
          ...px,
          y: px.y + (px.height - px.width / aspect) / 2,
          height: px.width / aspect,
        };
  return (
    <div
      className={`relative overflow-hidden rounded-lg bg-surface ${className ?? ''}`}
      style={{ aspectRatio: `${aspect}`, ...style }}
    >
      {/* A blob: link the optimiser can't fetch. */}
      <img
        src={src}
        alt=""
        className="absolute max-w-none"
        style={{
          width: `${(natural.width / box.width) * 100}%`,
          height: `${(natural.height / box.height) * 100}%`,
          left: `${(-box.x / box.width) * 100}%`,
          top: `${(-box.y / box.height) * 100}%`,
        }}
      />
      {children}
    </div>
  );
}

/** The story page's play button, drawn over its preview. */
function PlayMark() {
  return (
    <span
      aria-hidden="true"
      className="absolute top-1/2 left-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-background/80"
    >
      <svg viewBox="0 0 24 24" className="ml-0.5 size-4 fill-foreground">
        <path d="M7 4l13 8-13 8z" />
      </svg>
    </span>
  );
}

export function ThumbnailCropper({
  src,
  aspect,
  shapeName,
  busy,
  onUse,
  onCancel,
}: {
  /** The chosen photo (a blob: link), the right way up. */
  src: string;
  /** The video's shape, width ÷ height (kept within 1:3..3:1). */
  aspect: number;
  /** "landscape", "portrait" or "square". */
  shapeName: string;
  busy: boolean;
  /** The chosen part, in the photo's own pixels (unrounded, so a tiny photo keeps the shape). */
  onUse: (pixels: Area) => void;
  onCancel: () => void;
}) {
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [natural, setNatural] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const media = useRef<{ width: number; height: number } | null>(null);
  const cropSize = useRef<{ width: number; height: number } | null>(null);
  const [spoken, setSpoken] = useState('');
  /** Only a move by the person is read out, not the starting crop. */
  const moved = useRef(false);

  useEffect(() => {
    if (!moved.current || !area) return;
    const t = setTimeout(() => setSpoken(describeCrop(zoom, area)), 250);
    return () => clearTimeout(t);
  }, [area, zoom]);

  /** The crop kept over the picture, as the cropper keeps a drag. */
  const within = (p: Point, z: number): Point => {
    const m = media.current;
    const c = cropSize.current;
    if (!m || !c) return p;
    const mx = Math.abs((m.width * z) / 2 - c.width / 2);
    const my = Math.abs((m.height * z) / 2 - c.height / 2);
    return {
      x: Math.min(mx, Math.max(-mx, p.x)),
      y: Math.min(my, Math.max(-my, p.y)),
    };
  };
  const zoomTo = (z: number) => {
    moved.current = true;
    setZoom(Math.min(MAX_ZOOM, Math.max(1, Math.round(z * 100) / 100)));
  };
  const centre = () => {
    moved.current = true;
    setCrop({ x: 0, y: 0 });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? KEY_STEP * 5 : KEY_STEP;
    const by: Record<string, Point> = {
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
    };
    const move = by[e.key];
    if (move) {
      e.preventDefault();
      moved.current = true;
      setCrop((c) => within({ x: c.x + move.x, y: c.y + move.y }, zoom));
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomTo(zoom + ZOOM_STEP);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomTo(zoom - ZOOM_STEP);
    } else if (e.key === '0') {
      e.preventDefault();
      moved.current = true;
      setZoom(1);
      setCrop({ x: 0, y: 0 });
    }
  };

  const cardAspect = Math.min(CARD_MAX, Math.max(CARD_MIN, aspect));

  return (
    <div data-cropper="" className="flex flex-col gap-3">
      <div className="relative h-72 overflow-hidden rounded-lg bg-surface sm:h-96">
        <Cropper
          image={src}
          crop={crop}
          zoom={zoom}
          maxZoom={MAX_ZOOM}
          aspect={aspect}
          showGrid={false}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onInteractionStart={() => {
            moved.current = true;
          }}
          onCropComplete={(pct) => setArea(pct)}
          onMediaLoaded={(m) =>
            setNatural({ width: m.naturalWidth, height: m.naturalHeight })
          }
          setMediaSize={(m) => {
            media.current = m;
          }}
          onCropSizeChange={(c) => {
            cropSize.current = c;
          }}
          classes={{
            // The site's focus ring, drawn inside the box (the picture may fill the frame).
            cropAreaClassName: 'focus-visible:outline-offset-[-5px]',
          }}
          cropperProps={{
            role: 'group',
            'aria-roledescription': 'cropper',
            'aria-label':
              'Thumbnail crop: arrow keys move the picture, plus and minus zoom',
            onKeyDown,
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={square}
          aria-label="Zoom out"
          onClick={() => zoomTo(zoom - ZOOM_STEP)}
        >
          −
        </button>
        <input
          type="range"
          aria-label="Zoom"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={(e) => zoomTo(Number(e.target.value))}
          className="min-h-11 min-w-0 flex-1 accent-primary"
        />
        <button
          type="button"
          className={square}
          aria-label="Zoom in"
          onClick={() => zoomTo(zoom + ZOOM_STEP)}
        >
          +
        </button>
        <button type="button" className={secondary} onClick={centre}>
          Centre
        </button>
      </div>
      <Text
        size="small"
        tone="quiet"
        italic
        aria-live="polite"
        data-crop-spoken=""
        className="min-h-[1.5em]"
      >
        {spoken}
      </Text>
      {area && natural && (
        <div className="flex flex-wrap items-end gap-4" data-crop-previews="">
          <figure className="flex flex-col gap-1">
            <Framed
              src={src}
              natural={natural}
              area={area}
              aspect={cardAspect}
              style={{ width: `${Math.min(10, 10 * cardAspect)}rem` }}
            />
            <Text as="figcaption" size="small" tone="quiet">
              On Browse
            </Text>
          </figure>
          <figure className="flex flex-col gap-1">
            <Framed
              src={src}
              natural={natural}
              area={area}
              aspect={aspect}
              style={{ width: `${Math.min(14, 9 * aspect)}rem` }}
            >
              <PlayMark />
            </Framed>
            <Text as="figcaption" size="small" tone="quiet">
              On your story’s page
            </Text>
          </figure>
        </div>
      )}
      <Text size="small" tone="quiet">
        Your video is {shapeName}, so your thumbnail is cut to the same shape.
      </Text>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={primary}
          disabled={busy || !area || !natural}
          onClick={() => area && natural && onUse(sourceRect(area, natural))}
        >
          Use this thumbnail
        </button>
        <button
          type="button"
          className={secondary}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const clock = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Waits for the video to show the frame it's seeking to. */
function settled(video: HTMLVideoElement): Promise<void> {
  if (!video.seeking && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('loadeddata', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.addEventListener('loadeddata', done);
  });
}

/**
 * "A moment from your video" (TC-1 D): the video in this tab, a slider through it, and "Use this
 * moment", which hands the panel that frame (already the video's shape; one outside 1:3..3:1 is
 * cut around its middle).
 */
export function VideoMoment({
  file,
  busy,
  onUse,
}: {
  file: File;
  busy: boolean;
  onUse: (
    frame: HTMLVideoElement,
    rect: { x: number; y: number; width: number; height: number },
    name: string,
  ) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [length, setLength] = useState(0);
  const [at, setAt] = useState(0);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    setBroken(false);
    setAt(0);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  if (broken) {
    return (
      <Text tone="quiet" role="status">
        This browser can’t show your video here, so choose a picture instead.
      </Text>
    );
  }

  const use = async () => {
    const v = video.current;
    if (!v) return;
    await settled(v);
    if (!(v.videoWidth > 0 && v.videoHeight > 0)) {
      setBroken(true);
      return;
    }
    const rect = centred(
      v.videoWidth,
      v.videoHeight,
      clampAspect(v.videoWidth / v.videoHeight),
    );
    onUse(v, rect, `${file.name} at ${clock(v.currentTime)}`);
  };

  return (
    <div data-moment="" className="flex flex-col gap-3">
      {url && (
        <video
          ref={video}
          src={url}
          muted
          playsInline
          preload="auto"
          aria-label="Your video at the chosen moment"
          className="max-h-[50svh] w-full rounded-lg bg-surface object-contain"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            setLength(Number.isFinite(d) && d > 0 ? d : 0);
          }}
          onError={() => setBroken(true)}
        />
      )}
      <label className="flex flex-col gap-1">
        <Text as="span" size="inherit" weight="bold">
          Moment
        </Text>
        <input
          type="range"
          min={0}
          max={length || 0}
          step={0.1}
          value={at}
          disabled={!length}
          aria-valuetext={`${clock(at)} of ${clock(length)}`}
          onChange={(e) => {
            const t = Number(e.target.value);
            setAt(t);
            if (video.current) video.current.currentTime = t;
          }}
          className="min-h-11 w-full accent-primary"
        />
      </label>
      <Text size="small" tone="quiet" aria-hidden="true">
        {clock(at)} / {clock(length)}
      </Text>
      <div>
        <button
          type="button"
          className={primary}
          disabled={busy || !length}
          onClick={() => void use()}
        >
          Use this moment
        </button>
      </div>
    </div>
  );
}
