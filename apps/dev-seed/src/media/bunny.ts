import {
  type BunnyMedia,
  type ClipSpec,
  type ImageSpec,
  type UploadedClip,
  type UploadedImage,
} from '../app/media';

/**
 * The few Bunny calls upload.ts needs: Stream (video.bunnycdn.com, the library key) and Edge
 * Storage (the storage zone's password). Keys only ever go in the AccessKey header; nothing here
 * prints a header, and errors carry the status and Bunny's message only.
 */
export interface BunnyTarget {
  libraryId: string;
  libraryKey: string;
  storageZone: string;
  storagePassword: string;
  /** Edge Storage API host for the zone's region (London: uk.storage.bunnycdn.com). */
  storageHost: string;
}

/** Bunny Stream video statuses: https://docs.bunny.net/reference/video_getvideo */
export const VIDEO_STATUS = { finished: 4, error: 5, uploadFailed: 6 } as const;

export interface StreamVideo {
  guid: string;
  title: string;
  status: number;
  width: number;
  height: number;
  /** Seconds */
  length: number;
  thumbnailFileName?: string;
}

export type Fetch = typeof fetch;

/** The title a clip is uploaded under, and found again by. */
export const clipTitle = (id: string) => `dev-seed/${id}`;

export class Bunny {
  constructor(
    private readonly target: BunnyTarget,
    private readonly http: Fetch = fetch,
    private readonly sleep = (ms: number) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async call(
    url: string,
    key: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const res = await this.http(url, {
      ...init,
      headers: {
        AccessKey: key,
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok && res.status !== 404) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(
        `${init.method ?? 'GET'} ${new URL(url).pathname}: HTTP ${res.status} ${text}`,
      );
    }
    return res;
  }

  private stream(path: string) {
    return `https://video.bunnycdn.com/library/${encodeURIComponent(this.target.libraryId)}${path}`;
  }

  /** The library's videos with exactly this title (Bunny's search is a substring match). */
  async findVideo(title: string): Promise<StreamVideo[]> {
    const res = await this.call(
      this.stream(
        `/videos?search=${encodeURIComponent(title)}&itemsPerPage=100`,
      ),
      this.target.libraryKey,
    );
    const body = (await res.json()) as { items?: StreamVideo[] };
    return (body.items ?? []).filter((v) => v.title === title);
  }

  async getVideo(guid: string): Promise<StreamVideo> {
    const res = await this.call(
      this.stream(`/videos/${guid}`),
      this.target.libraryKey,
    );
    if (res.status === 404) throw new Error(`video ${guid} not found`);
    return (await res.json()) as StreamVideo;
  }

  async uploadVideo(title: string, bytes: Uint8Array): Promise<string> {
    const created = await this.call(
      this.stream('/videos'),
      this.target.libraryKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      },
    );
    const { guid } = (await created.json()) as { guid: string };
    await this.call(this.stream(`/videos/${guid}`), this.target.libraryKey, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    return guid;
  }

  /** Waits until Bunny has encoded the video (status finished); fails on an error status. */
  async waitForVideo(
    guid: string,
    timeoutMs = 15 * 60_000,
    pollMs = 5_000,
  ): Promise<StreamVideo> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const video = await this.getVideo(guid);
      if (video.status === VIDEO_STATUS.finished) return video;
      if (
        video.status === VIDEO_STATUS.error ||
        video.status === VIDEO_STATUS.uploadFailed
      ) {
        throw new Error(
          `${video.title}: Bunny couldn't encode it (status ${video.status})`,
        );
      }
      if (Date.now() > deadline)
        throw new Error(
          `${video.title}: still encoding after ${timeoutMs / 60_000} min`,
        );
      await this.sleep(pollMs);
    }
  }

  private storage(path: string) {
    const zone = encodeURIComponent(this.target.storageZone);
    return `https://${this.target.storageHost}/${zone}/${path}`;
  }

  /** Whether a file is already in the storage zone, and its size. */
  async storedSize(path: string): Promise<number | null> {
    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : `${path.slice(0, slash)}/`;
    const res = await this.call(this.storage(dir), this.target.storagePassword);
    if (res.status === 404) return null;
    const listing = (await res.json()) as {
      ObjectName: string;
      Length: number;
      IsDirectory: boolean;
    }[];
    const name = path.slice(slash + 1);
    return (
      listing.find((o) => !o.IsDirectory && o.ObjectName === name)?.Length ??
      null
    );
  }

  async putFile(path: string, bytes: Uint8Array): Promise<void> {
    await this.call(this.storage(path), this.target.storagePassword, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
  }
}

/** What to record for an encoded clip, checked against the spec. */
export function recordClip(
  id: string,
  spec: ClipSpec,
  video: StreamVideo,
): UploadedClip {
  if (Math.abs(video.length - spec.durationSeconds) > 1) {
    throw new Error(
      `${id}: Bunny says ${video.length} s, the spec ${spec.durationSeconds} s`,
    );
  }
  if (spec.kind === 'audio') {
    return { videoId: video.guid, durationSeconds: video.length };
  }
  if (video.width !== spec.width || video.height !== spec.height) {
    throw new Error(
      `${id}: Bunny says ${video.width}x${video.height}, the spec ${spec.width}x${spec.height}`,
    );
  }
  return {
    videoId: video.guid,
    thumbnailPath: video.thumbnailFileName
      ? `${video.guid}/${video.thumbnailFileName}`
      : undefined,
    width: video.width,
    height: video.height,
    durationSeconds: video.length,
  };
}

export function recordImage(path: string, spec: ImageSpec): UploadedImage {
  return { path, width: spec.width, height: spec.height };
}

/** bunny-media.json's text: stable key order, so a re-run that finds everything changes nothing. */
export function serialise(media: BunnyMedia): string {
  const sorted = <T>(o: Partial<Record<string, T>>) =>
    Object.fromEntries(
      Object.entries(o).sort(([a], [b]) => a.localeCompare(b)),
    );
  return `${JSON.stringify(
    {
      libraryId: media.libraryId,
      clips: sorted(media.clips),
      images: sorted(media.images),
    },
    null,
    2,
  )}\n`;
}
