/**
 * The stories' Bunny Stream library, as housekeeping sees it: list every video and delete one.
 * The library key (`bunny-stream-api-key`, read through the bunny root's stream_key_readers
 * grant) goes to Bunny's API only and is never logged.
 */
export interface LibraryVideo {
  guid: string;
  title: string;
  /** When Bunny created it (RequestUpload's create); null if Bunny's answer can't be read. */
  created: Date | null;
  /** The collection it's in (site videos are in `site-assets`); null for none. */
  collectionId: string | null;
}

export interface StreamLibrary {
  /** Every video in the library (at most MAX_PAGES pages; `complete` says whether it saw all). */
  list(): Promise<{ videos: LibraryVideo[]; complete: boolean }>;
  /** Deletes it; one that's already gone is fine. */
  delete(guid: string): Promise<void>;
}

const API = 'https://video.bunnycdn.com';
const TIMEOUT_MS = 15_000;
const PER_PAGE = 100;
/** 10,000 videos: far more than dev holds; the rest wait for the next night if ever reached. */
const MAX_PAGES = 100;
/** Bunny's video ids are GUIDs; anything else never reaches a URL. */
export const VIDEO_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Bunny writes UTC times without a zone (`2026-10-30T03:30:00.123`). */
export function bunnyTime(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  const zoned = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`;
  const date = new Date(zoned);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class BunnyStreamLibrary implements StreamLibrary {
  constructor(
    private readonly libraryId: string,
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private call(method: string, path: string) {
    return this.fetcher(`${API}/library/${this.libraryId}/videos${path}`, {
      method,
      headers: { AccessKey: this.key, Accept: 'application/json' },
      // The library key goes to Bunny's API only, never on to wherever a redirect points.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async list(): Promise<{ videos: LibraryVideo[]; complete: boolean }> {
    const videos: LibraryVideo[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.call(
        'GET',
        `?page=${page}&itemsPerPage=${PER_PAGE}&orderBy=date`,
      );
      if (!res.ok) throw new Error(`Bunny Stream list answered ${res.status}`);
      const body = (await res.json()) as {
        totalItems?: unknown;
        items?: unknown;
      };
      if (!Array.isArray(body.items)) {
        throw new Error('Bunny Stream list answered no items');
      }
      for (const raw of body.items as Record<string, unknown>[]) {
        if (typeof raw.guid !== 'string') continue;
        videos.push({
          guid: raw.guid,
          title: typeof raw.title === 'string' ? raw.title : '',
          created: bunnyTime(raw.dateUploaded),
          collectionId:
            typeof raw.collectionId === 'string' && raw.collectionId !== ''
              ? raw.collectionId
              : null,
        });
      }
      const total = typeof body.totalItems === 'number' ? body.totalItems : 0;
      if (body.items.length < PER_PAGE || page * PER_PAGE >= total) {
        return { videos, complete: true };
      }
    }
    return { videos, complete: false };
  }

  async delete(guid: string): Promise<void> {
    if (!VIDEO_ID.test(guid)) throw new Error('Not a Bunny video id');
    const res = await this.call('DELETE', `/${guid}`);
    if (!res.ok && res.status !== 404) {
      throw new Error(`Bunny Stream delete answered ${res.status}`);
    }
  }
}
