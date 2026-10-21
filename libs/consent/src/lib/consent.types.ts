/**
 * The consent types a person can grant and withdraw through the API. Mirrors the `consent.type`
 * enum in libs/database/schema/schema.surql and `ConsentType` in the OpenAPI contracts.
 *
 * D44: the M1 legacy import (task 1.9) adds a one-off `legacy-migration` type, written only
 * by the migrator, never grantable again and never required by a route. It deliberately isn't
 * in this list. Routes require the types below, and the decision "is this requirement met?"
 * is always `fn::consent::granted` in the database (the one definition, D17), so when 1.9
 * teaches the database gates to accept legacy-migration for imported stories, these guards
 * follow without a code change. Ledger readers treat unknown types as opaque.
 */
export const CONSENT_TYPES = [
  'special_category_religious',
  'publish',
  'share_socials',
  'age_18plus',
] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

export function isConsentType(value: unknown): value is ConsentType {
  return (CONSENT_TYPES as readonly unknown[]).includes(value);
}

/**
 * How the person gave consent. `legacy_import` exists in the schema for the migrator only
 * (D22), so the API never accepts it.
 */
export const CONSENT_MECHANISMS = [
  'web_form_submission',
  'account_settings',
  'reconsent_prompt',
] as const;
export type ConsentMechanism = (typeof CONSENT_MECHANISMS)[number];

export function isConsentMechanism(value: unknown): value is ConsentMechanism {
  return (CONSENT_MECHANISMS as readonly unknown[]).includes(value);
}

/**
 * Whose consent a route checks (`x-requires-consent.subject` in the contracts):
 * - `caller`: the signed-in person, checked in their own database session (D27);
 * - `submitter`: the submitter of the story named by a route parameter, checked on the
 *   service's own login (api-admin can read the ledger; api-user's login can't, so there it
 *   always fails closed).
 */
export type ConsentSubject = 'caller' | 'submitter';

export interface ConsentRequirement {
  subject: ConsentSubject;
  /** Every listed type must be currently granted (D17: the latest ledger event). */
  types: readonly ConsentType[];
  /** For `submitter`: the route parameter holding the story id (default `id`). */
  storyParam?: string;
}

const ART9: readonly ConsentType[] = ['special_category_religious'];
const PUBLISHABLE: readonly ConsentType[] = [
  'special_category_religious',
  'publish',
  'age_18plus',
];

/**
 * The requirement of every consent-guarded command in the contracts (D21, plan task 2.3,
 * docs/api-conventions.md "Consent on routes"). Routes use these rather than spelling the
 * types out, so the table lives in one place. The database enforces the same rules in its
 * events (story_consent, story_approval_consent, publicStory_mirrors_story); the guard
 * refuses early and makes every route state its choice.
 */
export const CONSENT_REQUIRED = {
  /** POST /v1/stories (api-user): no testimony is stored without current Art 9 consent. */
  createDraft: { subject: 'caller', types: ART9 },
  /** PATCH /v1/stories/{id} (api-user). */
  editDraft: { subject: 'caller', types: ART9 },
  /** POST /v1/stories/{id}/upload-url (api-user). */
  requestUpload: { subject: 'caller', types: ART9 },
  /** POST /v1/stories/{id}/submit (api-user). */
  submitStory: { subject: 'caller', types: PUBLISHABLE },
  /** POST /v1/moderation/stories/{id}/approve (api-admin): a fresh check of the submitter. */
  approveStory: { subject: 'submitter', types: PUBLISHABLE, storyParam: 'id' },
} as const satisfies Record<string, ConsentRequirement>;
