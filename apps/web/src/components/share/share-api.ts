'use client';

import {
  type ApiUser,
  ApiUserProblem,
  type ApiUserResponse,
  ApiUserUnavailable,
  newIdempotencyKey,
} from '@/lib/api-user';

/**
 * The submit flow's calls to api-user (api-user.yaml), through web's one api-user client
 * (src/lib/api-user.ts, browser only, D32).
 */

/** The editable fields of a draft, as the flow holds them (strings, never null). */
export interface StoryFields {
  title: string;
  body: string;
  description: string;
  /** The optional first name; empty = "Anonymous". */
  bylineName: string;
  tagSlugs: string[];
}

export const EMPTY_FIELDS: StoryFields = {
  title: '',
  body: '',
  description: '',
  bylineName: '',
  tagSlugs: [],
};

export interface Tag {
  slug: string;
  name: string;
  category: 'theme' | 'journey' | 'emotion';
}

export type StoryFormat = 'video' | 'audio' | 'written';

/** The contract's `StoryMine`, the parts the flow uses. */
export interface MyStory {
  id: string;
  version: number;
  status: string;
  title: string;
  description: string;
  body: string | null;
  bylineName: string | null;
  primaryFormat: StoryFormat;
  /** A video or audio story's file, once one was uploaded to it (M2 plan PR 7). */
  media: { format: string; processing: string | null }[];
  /** A written story's image or an audio story's picture (M2 plan PR 10), signed for its owner. */
  image: StoryPicture | null;
  tags: Tag[];
  submittedAt: string | null;
  updatedAt: string;
}

/** The contract's `StoryMineImage`: the person's own picture on their draft. */
export interface StoryPicture {
  url: string | null;
  width: number;
  height: number;
  alt: string | null;
  /** Its file's path at the server: what tells two pictures apart (`expectedImage`). */
  path: string;
  /** Whether its file arrived (api-user checks the storage); null where it isn't checked. */
  uploaded: boolean | null;
}

/** The contract's `ConsentState`, the parts the flow uses. */
export interface ConsentState {
  current: { type: string; counts: boolean }[];
  signup: { accepted: boolean };
  testimony: {
    version: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    acceptanceRequired: boolean;
  };
}

/** The contract's `SubmissionLimits`: the admin's settings and the person's own (W3, D112). */
export interface SubmissionLimits {
  storyText: { min: number; max: number };
  tags: { min: number; max: number };
  openDrafts: { max: number | null; open: number };
  submissions: { per7Days: number | null; nextAvailableAt: string | null };
  /** Video and audio files (D113): one file's size and length, and new uploads per hour/7 days. */
  uploads: {
    videoMaxBytes: number;
    audioMaxBytes: number;
    maxDurationSeconds: number;
    perHour: number;
    per7Days: number | null;
    nextAvailableAt: string | null;
  };
}

/**
 * The contract's `UploadTarget`: a TUS upload link for the draft's own video (D80), or an image's
 * presigned PUT (M2 plan PR 10). Its `headers` (Bunny's signature for that one file, not a
 * person's token) are `signed` here, so web's D32 rule against touching `.headers` keeps meaning
 * request headers.
 */
export interface UploadTarget {
  id: string;
  version: number;
  provider: 'bunny_tus' | 'bunny_s3';
  uploadUrl: string;
  method: 'POST' | 'PUT';
  signed: Record<string, string>;
  expiresAt: string;
  /** An image's path, now the story's picture (`bunny_s3` only). */
  path?: string;
}

/** The contract's `UploadUrlRequest`. */
export interface UploadRequest {
  format: 'video' | 'audio' | 'image';
  contentType: string;
  fileSizeBytes: number;
  durationSeconds?: number;
  resume?: boolean;
  /** Images: the WebP's real pixel size, and its description. */
  width?: number;
  height?: number;
  alt?: string;
  /** Images: the path of the picture the page showed (null: none); `409 image_changed` if not the story's. */
  expectedImage?: string | null;
}

export interface CommandResult {
  id: string;
  version: number;
}

/** The fields as the server stores them: trimmed, blank first name = none. */
export function normalise(f: StoryFields): StoryFields {
  return {
    title: f.title.trim(),
    body: f.body,
    description: f.description.trim(),
    bylineName: f.bylineName.trim(),
    tagSlugs: [...f.tagSlugs],
  };
}

export function fieldsOf(story: MyStory): StoryFields {
  return normalise({
    title: story.title,
    body: story.body ?? '',
    description: story.description,
    bylineName: story.bylineName ?? '',
    tagSlugs: story.tags.map((t) => t.slug),
  });
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export const sameField = (
  a: StoryFields,
  b: StoryFields,
  k: keyof StoryFields,
) => same(a[k], b[k]);

/** The fields where `local` differs from `saved`, as a merge patch (D28). */
export function mergePatch(
  local: StoryFields,
  saved: StoryFields,
): Record<string, unknown> {
  const n = normalise(local);
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(n) as (keyof StoryFields)[]) {
    if (sameField(n, saved, k)) continue;
    patch[k] = k === 'bylineName' ? n.bylineName || null : n[k];
  }
  return patch;
}

/** A problem's plain message for the person, or a fallback. */
export function plainMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiUserProblem && err.problem.detail) {
    return err.problem.detail;
  }
  return fallback;
}

/**
 * A command's `{ id, version }`. A success without them (an empty or unexpected body) says
 * nothing about what was done, so it counts as no answer (Codex #118 round 4): callers keep
 * their Idempotency-Key, body and the copy on this device, and try again.
 */
export function commandResult(
  res: ApiUserResponse<CommandResult>,
): CommandResult {
  const d = res.data as Partial<CommandResult> | undefined;
  if (
    !d ||
    typeof d !== 'object' ||
    typeof d.id !== 'string' ||
    !d.id ||
    !Number.isInteger(d.version)
  ) {
    throw new ApiUserUnavailable('api-user answered without the result');
  }
  return { id: d.id, version: d.version as number };
}

/** The TUS creation headers api-user.yaml requires; without any of them Bunny refuses it. */
const BUNNY_HEADERS: Record<UploadTarget['provider'], string[]> = {
  bunny_tus: [
    'AuthorizationSignature',
    'AuthorizationExpire',
    'VideoId',
    'LibraryId',
  ],
  bunny_s3: ['Content-Type', 'If-None-Match'],
};
const METHODS = { bunny_tus: 'POST', bunny_s3: 'PUT' } as const;

/**
 * RequestUpload's whole `UploadTarget`. A success without a usable link (an empty body, `{}`, a
 * field missing) may still have made the grant, so like {@link commandResult} it counts as no
 * answer (Codex #133 round 2): the caller keeps its Idempotency-Key, version and body.
 */
function uploadTarget(data: unknown): UploadTarget {
  const { headers, ...d } = (
    data && typeof data === 'object' ? data : {}
  ) as Partial<
    Omit<UploadTarget, 'signed'> & { headers: Record<string, unknown> }
  >;
  const signed = headers && typeof headers === 'object' ? headers : {};
  const link = (u: unknown) => {
    try {
      return typeof u === 'string' && !!new URL(u);
    } catch {
      return false;
    }
  };
  if (
    typeof d.id !== 'string' ||
    !d.id ||
    !Number.isInteger(d.version) ||
    (d.provider !== 'bunny_tus' && d.provider !== 'bunny_s3') ||
    !link(d.uploadUrl) ||
    d.method !== METHODS[d.provider] ||
    typeof d.expiresAt !== 'string' ||
    Number.isNaN(Date.parse(d.expiresAt)) ||
    !BUNNY_HEADERS[d.provider].every(
      (h) => typeof signed[h] === 'string' && !!signed[h],
    ) ||
    !Object.values(signed).every((v) => typeof v === 'string') ||
    (d.provider === 'bunny_s3' && (typeof d.path !== 'string' || !d.path))
  ) {
    throw new ApiUserUnavailable('api-user answered without the upload link');
  }
  return {
    id: d.id,
    version: d.version as number,
    provider: d.provider,
    uploadUrl: d.uploadUrl as string,
    method: d.method,
    signed: signed as Record<string, string>,
    expiresAt: d.expiresAt,
    ...(d.provider === 'bunny_s3' ? { path: d.path } : {}),
  };
}

export function shareApi(api: ApiUser) {
  return {
    consents: async () =>
      (await api.get<ConsentState>('/v1/account/consents'))
        .data as ConsentState,
    limits: async () =>
      (await api.get<SubmissionLimits>('/v1/account/limits'))
        .data as SubmissionLimits,
    tags: async () =>
      ((await api.get<{ data: Tag[] }>('/v1/tags')).data?.data ?? []) as Tag[],
    openDrafts: async () =>
      ((
        await api.get<{ data: MyStory[] }>(
          '/v1/account/stories?status=draft&limit=10',
        )
      ).data?.data ?? []) as MyStory[],
    story: async (id: string) =>
      (await api.get<MyStory>(`/v1/account/stories/${encodeURIComponent(id)}`))
        .data as MyStory,
    /** GrantConsent on the version in force shown (D84); one key per tick. */
    grant: (
      form: 'testimony' | 'social',
      formVersion: string,
      privacyPolicyVersion: string,
      statement: string,
      idempotencyKey = newIdempotencyKey(),
    ) =>
      api.command('/v1/account/consents', {
        method: 'POST',
        // D122: the privacy policy shown, which the grant binds (409 if another is in force).
        body: {
          form,
          formVersion,
          statement,
          mechanism: 'web_form_submission',
          privacyPolicyVersion,
        },
        idempotencyKey,
      }),
    create: async (
      fields: StoryFields,
      idempotencyKey: string,
      format: StoryFormat = 'written',
    ) => {
      const n = normalise(fields);
      return commandResult(
        await api.command<CommandResult>('/v1/stories', {
          method: 'POST',
          body: {
            title: n.title,
            primaryFormat: format,
            // A video or audio story's text is optional (D53): none until it has some.
            body: format === 'written' || n.body.trim() ? n.body : null,
            description: n.description,
            bylineName: n.bylineName || null,
            tagSlugs: n.tagSlugs,
          },
          idempotencyKey,
        }),
      );
    },
    edit: async (id: string, version: number, patch: Record<string, unknown>) =>
      commandResult(
        await api.command<CommandResult>(
          `/v1/stories/${encodeURIComponent(id)}`,
          { method: 'PATCH', body: patch, version, mergePatch: true },
        ),
      ),
    /**
     * RequestUpload (M2 plan PR 7): a TUS link for the draft's video (a new one, or `resume`), or
     * (PR 10) a presigned PUT for its picture.
     * A new one counts against the person's upload limits, so a retry after a lost answer sends
     * the same Idempotency-Key, version and body, and gets the same video back (D29).
     */
    uploadUrl: async (
      id: string,
      version: number,
      request: UploadRequest,
      idempotencyKey = newIdempotencyKey(),
    ): Promise<UploadTarget> => {
      const res = await api.command<unknown>(
        `/v1/stories/${encodeURIComponent(id)}/upload-url`,
        { method: 'POST', body: request, version, idempotencyKey },
      );
      return uploadTarget(res.data);
    },
    submit: async (id: string, version: number, idempotencyKey: string) =>
      commandResult(
        await api.command<CommandResult>(
          `/v1/stories/${encodeURIComponent(id)}/submit`,
          { method: 'POST', version, idempotencyKey },
        ),
      ),
  };
}

export type ShareApi = ReturnType<typeof shareApi>;
