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

/** The contract's `StoryMine`, the parts the flow uses. */
export interface MyStory {
  id: string;
  version: number;
  status: string;
  title: string;
  description: string;
  body: string | null;
  bylineName: string | null;
  primaryFormat: 'video' | 'audio' | 'written';
  tags: Tag[];
  submittedAt: string | null;
  updatedAt: string;
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
      statement: string,
      idempotencyKey = newIdempotencyKey(),
    ) =>
      api.command('/v1/account/consents', {
        method: 'POST',
        body: {
          form,
          formVersion,
          statement,
          mechanism: 'web_form_submission',
        },
        idempotencyKey,
      }),
    create: async (fields: StoryFields, idempotencyKey: string) => {
      const n = normalise(fields);
      return commandResult(
        await api.command<CommandResult>('/v1/stories', {
          method: 'POST',
          body: {
            title: n.title,
            primaryFormat: 'written',
            body: n.body,
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
