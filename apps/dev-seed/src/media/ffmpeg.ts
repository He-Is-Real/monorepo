import { type ClipSpec, type ImageSpec } from '../app/media';

/**
 * ffmpeg arguments for the dummy media (D47): a moving test pattern with its label burned in and
 * a tone (video), a tone (audio), or a still test pattern with its label (image). Arguments are
 * passed as an array (no shell). The label is read from a file (`textfile`), so it needs no
 * escaping. Small on purpose: low frame rate, high CRF, mono 64 kb/s audio.
 */
export function clipArgs(
  clip: ClipSpec,
  labelFile: string,
  out: string,
): string[] {
  const d = String(clip.durationSeconds);
  const tone = [
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${clip.toneHz}:duration=${d}:sample_rate=44100`,
  ];
  if (clip.kind === 'audio') {
    return [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      ...tone,
      '-ac',
      '1',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '64k',
      out,
    ];
  }
  const size = `${clip.width}x${clip.height}`;
  const fontSize = Math.max(
    14,
    Math.round(Math.min(clip.width ?? 0, clip.height ?? 0) / 14),
  );
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=12:duration=${d}`,
    ...tone,
    '-vf',
    `drawtext=textfile=${labelFile}:font=Sans:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=8:x=(w-text_w)/2:y=(h-text_h)/2`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '32',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-ac',
    '1',
    '-shortest',
    '-movflags',
    '+faststart',
    out,
  ];
}

export function imageArgs(
  image: ImageSpec,
  labelFile: string,
  out: string,
  quality = 70,
): string[] {
  const size = `${image.width}x${image.height}`;
  const fontSize = Math.round(Math.min(image.width, image.height) / 14);
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=1:duration=1`,
    '-vf',
    `noise=alls=24:allf=u,drawtext=textfile=${labelFile}:font=Sans:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=12:x=(w-text_w)/2:y=(h-text_h)/2`,
    '-frames:v',
    '1',
    '-c:v',
    'libwebp',
    '-quality',
    String(quality),
    out,
  ];
}

/** File names for the generated media, by id. */
export const clipFile = (id: string, clip: ClipSpec) =>
  `${id}.${clip.kind === 'audio' ? 'mp3' : 'mp4'}`;
export const imageFile = (id: string) => `${id}.webp`;
