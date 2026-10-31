import { BadRequestException } from '@nestjs/common';
import { STORY_CEILINGS, trimmedTextLength } from '@heisreal/database';

/**
 * Validation of the story commands' bodies (components.yaml `CreateDraftStory`, `StoryPatch`)
 * against the hard ceilings; the store then checks the settings' limits (W3). The database checks
 * both (schema.surql, `story`, `story_text_limits`); this answers `400` with field errors first. Errors never echo what was sent (it could be testimony text).
 */

export const FORMATS = ['video', 'audio', 'written'] as const;
export type Format = (typeof FORMATS)[number];

/** The editable fields, as the database names them. `null` = clear it (NONE). */
export interface StoryFields {
  title?: string;
  description?: string;
  body?: string | null;
  bylineName?: string | null;
  tagIds?: string[];
}

export interface CreateInput extends StoryFields {
  title: string;
  primaryFormat: Format;
}

interface FieldError {
  pointer: string;
  message: string;
}

const LIMITS = { title: 140, description: 5000, bylineName: 80 } as const;
// A tag's id (R2): opaque, the record id without `tag:`, as story ids are.
const TAG_ID = /^[A-Za-z0-9_]{1,64}$/;
const length = (s: string) => [...s].length;

function fail(errors: FieldError[]): never {
  throw new BadRequestException({
    code: 'validation_failed',
    message: 'The story has fields that aren’t valid',
    errors,
  });
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail([{ pointer: '', message: 'a JSON object' }]);
  }
  return body as Record<string, unknown>;
}

function fields(
  b: Record<string, unknown>,
  allowed: readonly string[],
  errors: FieldError[],
): StoryFields {
  for (const key of Object.keys(b)) {
    if (!allowed.includes(key)) {
      errors.push({ pointer: `/${key}`, message: 'not a field you can set' });
    }
  }
  const out: StoryFields = {};
  if ('title' in b) {
    const t = b['title'];
    if (typeof t !== 'string' || !t.trim() || length(t.trim()) > LIMITS.title) {
      errors.push({
        pointer: '/title',
        message: `1–${LIMITS.title} characters`,
      });
    } else out.title = t.trim();
  }
  if ('description' in b) {
    const d = b['description'];
    if (typeof d !== 'string' || length(d) > LIMITS.description) {
      errors.push({
        pointer: '/description',
        message: `at most ${LIMITS.description} characters`,
      });
    } else out.description = d.trim();
  }
  if ('body' in b) {
    const t = b['body'];
    if (t === null) out.body = null;
    else if (typeof t !== 'string' || length(t) > STORY_CEILINGS.textLength) {
      errors.push({
        pointer: '/body',
        message: `at most ${STORY_CEILINGS.textLength} characters`,
      });
    } else out.body = t;
  }
  if ('bylineName' in b) {
    const n = b['bylineName'];
    if (n === null) out.bylineName = null;
    else if (typeof n !== 'string' || length(n.trim()) > LIMITS.bylineName) {
      errors.push({
        pointer: '/bylineName',
        message: `a name of at most ${LIMITS.bylineName} characters, or null`,
      });
    } else out.bylineName = n.trim() || null; // blank = anonymous
  }
  if ('tagIds' in b) {
    const tags = b['tagIds'];
    if (
      !Array.isArray(tags) ||
      tags.length > STORY_CEILINGS.tags ||
      tags.some((t) => typeof t !== 'string' || !TAG_ID.test(t)) ||
      new Set(tags).size !== tags.length
    ) {
      errors.push({
        pointer: '/tagIds',
        message: `at most ${STORY_CEILINGS.tags} different tag ids`,
      });
    } else out.tagIds = tags as string[];
  }
  return out;
}

/** CreateDraftStory's body. A written story needs its text from the start (D53). */
export function parseCreate(body: unknown): CreateInput {
  const b = asObject(body);
  const errors: FieldError[] = [];
  const f = fields(
    b,
    ['title', 'description', 'body', 'bylineName', 'primaryFormat', 'tagIds'],
    errors,
  );
  const format = b['primaryFormat'];
  if (!(FORMATS as readonly unknown[]).includes(format)) {
    errors.push({ pointer: '/primaryFormat', message: FORMATS.join(', ') });
  }
  if (!('title' in b)) errors.push({ pointer: '/title', message: 'required' });
  if (format === 'written' && !trimmedTextLength(f.body ?? '')) {
    errors.push({
      pointer: '/body',
      message: 'a written story needs its text',
    });
  }
  if (errors.length) fail(errors);
  return { ...f, title: f.title as string, primaryFormat: format as Format };
}

/** EditStory's JSON Merge Patch (never the status or the format, D28). */
export function parsePatch(body: unknown): StoryFields {
  const b = asObject(body);
  const errors: FieldError[] = [];
  const f = fields(
    b,
    ['title', 'description', 'body', 'bylineName', 'tagIds'],
    errors,
  );
  if (errors.length) fail(errors);
  return f;
}

/** Over the settings' limits (W3): text too long or too many themes (`400`). */
export function overLimit(errors: FieldError[]): never {
  throw new BadRequestException({
    code: 'validation_failed',
    message: 'The story is over the limits',
    errors,
  });
}

/** A tag slug the database doesn't know (`400`, `/tagIds`). */
export function unknownTags(): never {
  fail([{ pointer: '/tagIds', message: 'a tag that doesn’t exist' }]);
}

/** A written story's text can't be emptied (D53: it needs its text). */
export function textRequired(): never {
  fail([{ pointer: '/body', message: 'a written story needs its text' }]);
}

/** `If-Match: "<version>"` (D29): the version, or undefined when missing. */
export function parseIfMatch(
  header: string | undefined,
): number | undefined | 'invalid' {
  if (header === undefined || header.trim() === '') return undefined;
  const m = /^"([1-9]\d{0,8})"$/.exec(header.trim());
  return m ? Number(m[1]) : 'invalid';
}

/**
 * The story's slug: words from its title and a random suffix that stays for its whole life, so
 * the slug follows the title while it's a draft and is unique (`story_slug` index).
 */
export function slugFor(title: string, suffix: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return words ? `${words}-${suffix}` : `story-${suffix}`;
}

/** The suffix of an existing slug (its last segment). */
export const slugSuffix = (slug: string) =>
  slug.slice(slug.lastIndexOf('-') + 1);
