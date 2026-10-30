import { evidenceHash } from '@heisreal/consent/evidence';
import type { SurrealQueryable } from 'surrealdb';
import type { SeedVars } from './plan';

/**
 * The reset (D49): one transaction that refuses to run anywhere but dev, wipes the content
 * tables and loads the dataset. All or nothing: a failure leaves dev as it was.
 *
 * It runs as `dev_seed`, a dev-only system user (EDITOR; created by SurrealDB's startup init only
 * when OpenTofu's dev_seed_login is on). A system user skips table permissions, but every event
 * still runs: the story types and shapes (D53), the approval gate (A2) and the read model's
 * mirror check all hold, exactly as for the services. Consent is real (D75): every fixture
 * person has granted the sign-up form in force and the testimony form in force (dev's
 * placeholder versions, data script 0005) in the ledger, with the evidence hash the API records,
 * so the published stories pass the real consent checks with D48's switch off. A grant is
 * appended only when the person's current one isn't on the version in force, so resets don't
 * grow the ledger (append-only: it's never wiped).
 *
 * dev's Clerk test accounts (the dataset's testAccounts) are marked trusted submitters (D112).
 *
 * Wiped: story (and, through its erasure cascade, publicStory and moderationReview), whatever
 * read-model rows or reviews are left, auditLog, idempotencyKey and tag. Kept: people who aren't
 * fixtures (Clerk sign-ins), the consent ledger (append-only), DPA versions, settings and the
 * migration ledger. Fixture people are `user:seed_*`; ones no longer in the dataset are removed.
 *
 * The script text is fixed: the dataset only ever arrives as bound variables (SeedVars).
 */
export const RESET_SQL = /* surql */ `
BEGIN TRANSACTION;

LET $setting = (SELECT environment, devConsentRelaxed FROM ONLY _setting:consent);
IF $setting.environment != 'dev' {
  THROW 'dev-seed: this database is not dev (_setting:consent), so nothing was changed';
};
IF fn::form::latest('signup') = NONE OR fn::form::latest('testimony') = NONE {
  THROW 'dev-seed: no consent forms are published in this database (D75: dev_legal_placeholders), so nothing was changed';
};

DELETE story RETURN NONE;
DELETE publicStory RETURN NONE;
DELETE moderationReview RETURN NONE;
DELETE auditLog RETURN NONE;
DELETE idempotencyKey RETURN NONE;
DELETE tag RETURN NONE;
LET $fixtures = array::concat($people, [$moderator]);
DELETE user WHERE string::starts_with(<string> record::id(id), 'seed_')
  AND record::id(id) NOT IN $fixtures RETURN NONE;

FOR $u IN $fixtures { UPSERT type::record('user', $u) RETURN NONE; };
-- D75: real consent, on the versions in force ($consents: one grant per person and statement).
FOR $c IN $consents {
  LET $user = type::record('user', $c.user);
  LET $form = <record> $c.form;
  LET $now = fn::consent::current($user, $c.type);
  IF $now.event != 'granted' OR $now.form != $form OR !fn::consent::valid($now)
    OR $now.dpaVersion != type::record('dpaVersion', $c.dpa)
    OR ($c.terms AND $now.termsVersion != type::record('termsVersion', $c.terms)) {
    CREATE consent CONTENT {
      subject: $user, type: $c.type, event: 'granted', form: $form,
      dpaVersion: type::record('dpaVersion', $c.dpa),
      termsVersion: IF $c.terms { type::record('termsVersion', $c.terms) } ELSE { NONE },
      mechanism: 'web_form_submission', evidenceHash: $c.evidenceHash,
      evidenceVersion: $c.evidenceVersion
    } RETURN NONE;
  };
};
-- D112: dev's Clerk test accounts are trusted submitters (no open-drafts or weekly limit), so the
-- limits don't interfere with testing. Their account row is made here if they haven't signed in
-- yet (the same row api-user would make). devSeed marks it as dev-seed's; the database refuses
-- that anywhere but dev.
FOR $clerk IN $testAccounts {
  LET $found = (SELECT VALUE id FROM user WHERE clerkUserId = $clerk)[0];
  LET $u = IF $found != NONE { $found } ELSE {
    (CREATE ONLY user CONTENT { clerkUserId: $clerk } RETURN id).id
  };
  UPSERT type::record('submitterLimits', record::id($u))
    SET user = $u, trusted = true, devSeed = true RETURN NONE;
};
FOR $t IN $tags {
  CREATE type::record('tag', $t.id) CONTENT { name: $t.name, category: $t.category } RETURN NONE;
};

FOR $s IN $stories {
  LET $story = type::record('story', $s.id);
  CREATE $story CONTENT object::extend($s.draft, {
    submitter: type::record('user', $s.submitter),
    tagRefs: $s.draft.tagRefs.map(|$t| type::record('tag', $t)),
    status: 'draft'
  }) RETURN NONE;
  FOR $step IN $s.steps {
    IF $step.review != NONE {
      CREATE moderationReview CONTENT {
        story: $story,
        moderator: type::record('user', $moderator),
        decision: $step.review.decision,
        feedbackToSubmitter: $step.review.feedback,
        storyVersion: (SELECT VALUE version FROM ONLY $story)
      } RETURN NONE;
    };
    UPDATE $story SET
      status = $step.status,
      lockedBy = IF $step.lock = true { type::record('user', $moderator) } ELSE { NONE },
      lockedAt = IF $step.lock = true { time::now() } ELSE { NONE },
      rejectionFeedback = $step.feedback,
      approvedAt = IF $step.status = 'approved' { $s.publishedAt } ELSE { approvedAt }
    RETURN NONE;
  };
  IF $s.publishedAt != NONE {
    LET $a = (SELECT * FROM ONLY $story);
    CREATE type::record('publicStory', $s.id) CONTENT {
      version: $a.version, slug: $a.slug, title: $a.title, description: $a.description,
      body: $a.body, bylineName: $a.bylineName, primaryFormat: $a.primaryFormat,
      tagRefs: $a.tagRefs,
      media: $a.media.map(|$m| { format: $m.format, bunnyVideoId: $m.bunnyVideoId,
        thumbnailPath: $m.thumbnailPath, width: $m.width, height: $m.height }),
      image: IF $a.image != NONE { { path: $a.image.path, width: $a.image.width,
        height: $a.image.height, alt: $a.image.alt } },
      publishedAt: $s.publishedAt
    } RETURN NONE;
  };
};

COMMIT TRANSACTION;
`;

/** What the database holds after a reset: counted, not assumed. */
export const SUMMARY_SQL = /* surql */ `
SELECT status, count() AS stories FROM story GROUP BY status;
RETURN {
  publicStories: count(SELECT id FROM publicStory),
  reviews: count(SELECT id FROM moderationReview),
  tags: count(SELECT id FROM tag),
  fixturePeople: count(SELECT id FROM user WHERE string::starts_with(<string> record::id(id), 'seed_'))
};
`;

export interface SeedSummary {
  byStatus: Record<string, number>;
  publicStories: number;
  reviews: number;
  tags: number;
  fixturePeople: number;
}

/** Runs a query and throws the root cause of the first failed statement. */
async function runQuery(
  db: SurrealQueryable,
  sql: string,
  vars?: Record<string, unknown>,
): Promise<unknown[]> {
  const responses = await db.query(sql, vars).json().responses();
  const errors = responses.flatMap((r) =>
    r.success ? [] : [String(r.error?.message ?? r.error)],
  );
  if (errors.length > 0) {
    // In a failed transaction every other statement says "not executed"; report the cause.
    const cause = errors.find(
      (e) => !e.includes('not executed due to a failed transaction'),
    );
    throw new Error(cause ?? errors[0]);
  }
  return responses.map((r) => (r.success ? r.result : undefined));
}

/**
 * The statements each fixture person grants on the forms in force: every box of the sign-up
 * version (D73: 18+, which is asked there only, D93; account_data; and since D122 the terms of
 * use) and the testimony form's (D67). They don't tick the optional social sharing form, so no
 * dummy story may be shared beyond the dev site.
 */
export const FIXTURE_FORMS = ['signup', 'testimony'] as const;

// D122: grants bind the privacy policy in force, and on a sign-up version asking for them the
// terms of use in force, as the API does.
const FORMS_IN_FORCE = /* surql */ `
LET $s = fn::form::latest('signup');
LET $t = fn::form::latest('testimony');
LET $d = fn::legal::dpa_in_force();
LET $terms = IF $s.coversTerms = true { fn::legal::terms_in_force() } ELSE { NONE };
RETURN [
  { kind: 'signup', form: $s.id, textHash: $s.textHash, statementsHash: $s.statementsHash,
    statements: fn::form::statements($s.id),
    dpa: $d, dpaHash: $d.contentHash, dpaPdf: $d.pdfSha256,
    terms: $terms, termsHash: $terms.textHash, termsPdf: $terms.pdfSha256 },
  { kind: 'testimony', form: $t.id, textHash: $t.textHash, statementsHash: $t.statementsHash,
    statements: fn::form::statements($t.id),
    dpa: $d, dpaHash: $d.contentHash, dpaPdf: $d.pdfSha256 }
];
`;

export interface FixtureConsent {
  user: string;
  type: string;
  /** e.g. testimonyFormVersion:v1 */
  form: string;
  dpa: string;
  /** The terms of use version, on a sign-up version asking for them (D122). */
  terms: string | null;
  evidenceHash: string;
  /** 4 when the privacy policy has a PDF of record (D122), else 3 (libs/consent's evidence.ts). */
  evidenceVersion: 3 | 4;
}

/** Every fixture person's grants on the forms in force, as the API would record them. */
export async function fixtureConsents(
  db: SurrealQueryable,
  people: string[],
): Promise<FixtureConsent[]> {
  const results = await runQuery(db, FORMS_IN_FORCE);
  const forms = results[results.length - 1] as {
    kind: (typeof FIXTURE_FORMS)[number];
    form?: string;
    textHash?: string;
    statementsHash?: string;
    statements?: string[];
    dpa?: string;
    dpaHash?: string;
    dpaPdf?: string | null;
    terms?: string | null;
    termsHash?: string | null;
    termsPdf?: string | null;
  }[];
  const key = (id: string) => id.slice(id.indexOf(':') + 1);
  return forms.flatMap((f) => {
    if (!f.form || !f.textHash || !f.statementsHash || !f.dpa || !f.dpaHash)
      return []; // the reset refuses
    const version = key(f.form);
    const dpa = key(f.dpa);
    const terms = f.terms ? key(f.terms) : null;
    const v4 = !!f.dpaPdf;
    return people.flatMap((user) =>
      (f.statements ?? []).map((type) => ({
        user,
        type,
        form: f.form as string,
        dpa,
        terms,
        evidenceVersion: v4 ? (4 as const) : (3 as const),
        evidenceHash: evidenceHash({
          // Evidence v4 (D122) when the privacy policy has a PDF, else v3 (D114), as the API.
          form: {
            kind: f.kind,
            version,
            textHash: f.textHash as string,
            statementsHash: f.statementsHash as string,
          },
          dpaVersion: dpa,
          dpaContentHash: f.dpaHash as string,
          ...(v4
            ? {
                dpaPdfSha256: f.dpaPdf as string,
                ...(terms
                  ? {
                      terms: {
                        version: terms,
                        textHash: f.termsHash as string,
                        pdfSha256: f.termsPdf as string,
                      },
                    }
                  : {}),
              }
            : {}),
          type,
          event: 'granted',
          mechanism: 'web_form_submission',
        }),
      })),
    );
  });
}

/** Resets the database to the dataset, then counts what's there. */
export async function reset(
  db: SurrealQueryable,
  vars: SeedVars,
): Promise<SeedSummary> {
  const consents = await fixtureConsents(db, [...vars.people, vars.moderator]);
  await runQuery(db, RESET_SQL, {
    ...(vars as unknown as Record<string, unknown>),
    consents,
  });
  const [byStatus, totals] = await runQuery(db, SUMMARY_SQL);
  return {
    byStatus: Object.fromEntries(
      (byStatus as { status: string; stories: number }[]).map((r) => [
        r.status,
        r.stories,
      ]),
    ),
    ...(totals as Omit<SeedSummary, 'byStatus'>),
  };
}
