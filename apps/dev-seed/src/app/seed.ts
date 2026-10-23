import type { SurrealQueryable } from 'surrealdb';
import type { SeedVars } from './plan';

/**
 * The reset (D49): one transaction that refuses to run anywhere but dev, wipes the content
 * tables and loads the dataset. All or nothing: a failure leaves dev as it was.
 *
 * It runs as `dev_seed`, a dev-only system user (EDITOR; created by SurrealDB's startup init only
 * when OpenTofu's dev_seed_login is on). A system user skips table permissions, but every event
 * still runs: the story types and shapes (D53), the approval gate (A2) and the read model's
 * mirror check all hold, exactly as for the services. Consent is satisfied by D48's dev-only
 * switch, never by fake consent records.
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
IF !fn::consent::relaxed() {
  THROW 'dev-seed: consent checks are not relaxed in this database (D48: dev_consent_relaxed), so nothing was changed';
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

/** Resets the database to the dataset, then counts what's there. */
export async function reset(
  db: SurrealQueryable,
  vars: SeedVars,
): Promise<SeedSummary> {
  await runQuery(db, RESET_SQL, vars as unknown as Record<string, unknown>);
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
