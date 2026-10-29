/**
 * The consent types a person can grant and withdraw through the API: each is one statement (a
 * box) on a consent form (D84). Mirrors the `consent.type` enum in
 * libs/database/schema/schema.surql and `ConsentType` in the OpenAPI contracts. Which form has
 * which statement is the database's `fn::form::statements` (D93): the sign-up form (D73) has
 * `age_18plus` and `account_data`; the testimony form has `special_category_religious` and, if
 * it covers publishing on heisreal.today, `publish`; the optional social sharing form has
 * `share_socials`.
 *
 * D44: the legacy import (Real stories) adds a one-off `legacy-migration` type, written only
 * by the migrator, never grantable again and never required by a route. It deliberately isn't
 * in this list. Routes require the types below, and the decision "is this requirement met?"
 * is always `fn::consent::granted` in the database (the one definition, D17). Ledger readers
 * treat unknown types as opaque.
 */
export const CONSENT_TYPES = [
  'special_category_religious',
  'publish',
  'share_socials',
  'age_18plus',
  'account_data',
] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

/**
 * The three consent forms (D84, D93): `signupFormVersion`, `testimonyFormVersion` and
 * `socialSharingFormVersion` in the schema.
 */
export const CONSENT_FORMS = ['signup', 'testimony', 'social'] as const;
export type ConsentForm = (typeof CONSENT_FORMS)[number];

/**
 * Which form asks each statement (D73, D67, D93). The database's `fn::form::statements` decides
 * per version (`publish` only on testimony versions covering publishing); this is the form to
 * show for a statement.
 */
export const STATEMENT_FORM: Record<ConsentType, ConsentForm> = {
  special_category_religious: 'testimony',
  publish: 'testimony',
  share_socials: 'social',
  age_18plus: 'signup',
  account_data: 'signup',
};

export function isConsentForm(value: unknown): value is ConsentForm {
  return (CONSENT_FORMS as readonly unknown[]).includes(value);
}

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
  /**
   * Something new starts (a draft, a submission): the caller must also be on the forms in force
   * (D93: the sign-up version in force accepted, and no newer testimony version requiring
   * acceptance for new submissions; `fn::consent::may_draft`). Caller only.
   */
  formsInForce?: boolean;
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
  createDraft: { subject: 'caller', types: ART9, formsInForce: true },
  /** PATCH /v1/stories/{id} (api-user). */
  editDraft: { subject: 'caller', types: ART9 },
  /** POST /v1/stories/{id}/upload-url (api-user). */
  requestUpload: { subject: 'caller', types: ART9 },
  /** POST /v1/stories/{id}/submit (api-user). */
  submitStory: { subject: 'caller', types: PUBLISHABLE, formsInForce: true },
  /**
   * PUT /v1/account/favourites/{storyId} (api-user): a heart is stored only with the sign-up
   * form's consent, "store my account and favourites" and 18+ (D73), on any version that counts
   * (D93: a newer sign-up version gates only new drafts and submissions).
   */
  addFavourite: { subject: 'caller', types: ['account_data', 'age_18plus'] },
  /** POST /v1/moderation/stories/{id}/approve (api-admin): a fresh check of the submitter. */
  approveStory: { subject: 'submitter', types: PUBLISHABLE, storyParam: 'id' },
} as const satisfies Record<string, ConsentRequirement>;
