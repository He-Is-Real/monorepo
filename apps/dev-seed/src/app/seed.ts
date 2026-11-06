import type { SurrealQueryable } from 'surrealdb';
import type { SeedVars } from './plan';

/**
 * The reset (D49): one transaction that refuses to run anywhere but dev, wipes the content
 * tables and loads the dataset. All or nothing: a failure leaves dev as it was.
 *
 * It runs as `dev_seed`, a dev-only system user (EDITOR; created by SurrealDB's startup init only
 * when OpenTofu's dev_seed_login is on). A system user skips table permissions, but every event
 * still runs: the story types and shapes (D53), the status log's steps (R6) and the approval
 * gate (A2) all hold, exactly as for the services. A system user names who added each status
 * entry (person or moderator), and when, so the log reads as if they had. Agreements are real (plan 4e): every
 * fixture person has agreed to the latest terms of use and testimony consent (their pointers on
 * the user row; a system user may set them), so the published stories pass the real rules. A
 * pointer is moved only when it isn't on the latest version already, so a reset keeps the time
 * they agreed. No fixture story has the social media sharing consent: no dummy story may be
 * shared beyond the dev site.
 *
 * dev's Clerk test accounts (the dataset's testAccounts) are marked trusted submitters (D112)
 * and, like the fixture people, agree to the latest terms of use and testimony consent (C1).
 * Its newcomer accounts (newcomerAccounts) go back to never having agreed to either, so their
 * next sign-in meets the terms step; a system user may clear a pointer, nobody else may.
 *
 * Wiped: story (and, through its cascade, its status log), dev-seed's own storyFile rows,
 * idempotencyKey,
 * every theme and every category
 * but Other (which can't be deleted). Kept: people who aren't
 * fixtures (Clerk sign-ins), the legal texts' versions, settings and the migration ledger. Fixture people are `user:seed_*`; ones no longer in the dataset are removed.
 *
 * The script text is fixed: the dataset only ever arrives as bound variables (SeedVars).
 */
export const RESET_SQL = /* surql */ `
BEGIN TRANSACTION;

LET $setting = (SELECT environment FROM ONLY _setting:current);
IF $setting.environment != 'dev' {
  THROW 'dev-seed: this database is not dev (_setting:current), so nothing was changed';
};
LET $terms = fn::legal::latest('termsOfUseAgreement');
LET $testimony = fn::legal::latest('testimonyConsent');
IF $terms = NONE OR $testimony = NONE {
  THROW 'dev-seed: this database has no terms of use or testimony consent (data/0009), so nothing was changed';
};

DELETE story RETURN NONE;
-- R12: dev-seed's own file rows (its stories' ids start seed_); other rows (dev's test accounts'
-- uploads) stay, as the upload limits count them, until housekeeping prunes them.
DELETE storyFile WHERE string::starts_with(<string> record::id(story), 'seed_') RETURN NONE;
DELETE idempotencyKey RETURN NONE;
DELETE theme RETURN NONE;
DELETE themeCategory WHERE id != themeCategory:other RETURN NONE;
UPSERT themeCategory:other SET name = 'Other' RETURN NONE;
LET $fixtures = array::concat($people, [$moderator]);
DELETE user WHERE string::starts_with(<string> record::id(id), 'seed_')
  AND record::id(id) NOT IN $fixtures RETURN NONE;

-- Plan 4e: each fixture person has agreed to the latest terms of use and testimony consent.
FOR $u IN $fixtures {
  LET $user = type::record('user', $u);
  UPSERT $user RETURN NONE;
  UPDATE $user SET termsOfUse = $terms, termsOfUseAgreedAt = time::now()
    WHERE termsOfUse != $terms RETURN NONE;
  UPDATE $user SET testimonyConsent = $testimony, testimonyConsentAgreedAt = time::now()
    WHERE testimonyConsent != $testimony RETURN NONE;
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
  -- C1 (Joel, 2026-11-01): they have agreed to the latest terms of use and testimony consent
  -- too, so the behavioural suites work after every reset.
  UPDATE $u SET termsOfUse = $terms, termsOfUseAgreedAt = time::now()
    WHERE termsOfUse != $terms RETURN NONE;
  UPDATE $u SET testimonyConsent = $testimony, testimonyConsentAgreedAt = time::now()
    WHERE testimonyConsent != $testimony RETURN NONE;
};
-- Plan 4e: dev's newcomer test accounts have agreed to nothing, on every run (data/0009's fill-in
-- recorded the ones that existed then as agreeing). A row is left for api-user to make.
UPDATE user SET termsOfUse = NONE, testimonyConsent = NONE
  WHERE clerkUserId IN $newcomerAccounts RETURN NONE;
FOR $c IN $categories {
  CREATE type::record('themeCategory', $c.id) CONTENT { name: $c.name } RETURN NONE;
};
FOR $t IN $themes {
  CREATE type::record('theme', $t.id) CONTENT {
    name: $t.name, category: type::record('themeCategory', $t.category),
    highlighted: $t.highlighted
  } RETURN NONE;
};
-- An admin page opened before the reset must reload before saving (themes plan v3, A2).
UPSERT themeCatalog:current SET changedBy = NONE RETURN NONE;

FOR $s IN $stories {
  LET $story = type::record('story', $s.id);
  LET $submitter = type::record('user', $s.submitter);
  CREATE $story CONTENT object::extend($s.draft, {
    submitter: $submitter,
    themeRefs: $s.draft.themeRefs.map(|$t| type::record('theme', $t))
  }) RETURN NONE;
  -- R12: its uploads, as storyFile rows of its own that the story points at (a story points only
  -- at its own rows, system users too).
  FOR $f IN [$s.media, $s.image] {
    IF $f != NONE {
      CREATE type::record('storyFile', $f.key) CONTENT object::extend($f.row, {
        story: $story, person: $submitter
      }) RETURN NONE;
    };
  };
  IF $s.media != NONE {
    UPDATE $story SET mediaFile = type::record('storyFile', $s.media.key) RETURN NONE;
  };
  IF $s.image != NONE {
    UPDATE $story SET image = { file: type::record('storyFile', $s.image.key), alt: $s.image.alt }
      RETURN NONE;
  };
  -- R6: each step is a status entry; the database checks it and moves story.currentStatus.
  FOR $step IN $s.steps {
    CREATE storyStatusLog CONTENT {
      story: $story, status: $step.status, actor: $step.actor, at: $step.at,
      by: IF $step.actor = 'moderator' { type::record('user', $moderator) },
      comment: $step.comment,
      publishedAt: IF $step.status = 'approved' { $s.publishedAt }
    } RETURN NONE;
  };
};

COMMIT TRANSACTION;
`;

/** What the database holds after a reset: counted, not assumed. */
export const SUMMARY_SQL = /* surql */ `
SELECT status, count() AS stories FROM
  (SELECT fn::story::status_of($this) AS status FROM story) GROUP BY status;
RETURN {
  publicStories: count(SELECT id FROM story WHERE currentStatus.status = 'approved'),
  files: count(SELECT id FROM storyFile WHERE string::starts_with(<string> record::id(story), 'seed_')),
  statusEntries: count(SELECT id FROM storyStatusLog),
  themes: count(SELECT id FROM theme),
  fixturePeople: count(SELECT id FROM user WHERE string::starts_with(<string> record::id(id), 'seed_'))
};
`;

export interface SeedSummary {
  byStatus: Record<string, number>;
  publicStories: number;
  files: number;
  statusEntries: number;
  themes: number;
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
