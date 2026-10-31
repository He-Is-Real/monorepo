// A stand-in api-user for the e2e tests (T3), as the browser calls it from web's origin, with
// CORS like the real service (libs/http's corsOptions: web's origins only, no credentials, the
// preflight for Authorization). contract.e2e.ts checks every answer against
// libs/contracts/openapi/api-user.yaml.
//
// - `GET /v1/account`, the signed-in header's account bootstrap: an account that has accepted
//   the sign-up form and needs no testimony re-acceptance, so pages carry on as usual (sessions
//   starting `unaccepted` haven't accepted the sign-up form: the site sends them to the step).
//   Tests of the consent step and banner answer it themselves (consent.e2e.ts).
// - `POST /v1/account/consents`, one box ticked on a form version: only dev's v2 of each form is
//   in force, under dev's placeholder privacy policy (and on sign-up the terms) in force (D122) (stub-api.mjs serves the same), with the real service's checks: the version in
//   force (409), a statement on that form (409), an `Idempotency-Key` (400; the same key with
//   another body 422, the same body answers as before). No state but the keys, which are
//   random per test.
// - The submit flow (M2 plan PR 4): consent state, limits, themes, the person's stories, and
//   create, edit and submit, per test session (see the section below).
// - Video and audio (M2 plan PR 7): `POST /v1/stories/{id}/upload-url` (RequestUpload, with the
//   real service's checks and one video per draft) and a minimal TUS server at `/tusupload`
//   standing in for Bunny Stream: creation (`POST`, the signed headers checked), `HEAD` and
//   `PATCH`. A test can make the next PATCHes fail or hold them (`POST /__e2e/sessions/<id>/tus`)
//   and read what arrived (`GET /__e2e/sessions/<id>/uploads`); submit needs the file to have
//   arrived, as api-user asks Bunny. `POST /__e2e/sessions/<id>/settings` changes a session's
//   settings after its page loaded.
// - Pictures (M2 plan PR 10): `format: image` on the same route (a written story's image, an
//   audio story's picture, a video's own thumbnail) puts the picture on the draft at a path the
//   stub picks, `stories/<id>/<random>.webp`, and answers a presigned PUT to `/__s3/<path>`,
//   standing in for Bunny's S3 endpoint: it checks the signature, the type, the exact size and
//   one use (412), keeps the bytes, and serves them back (GET) as the draft's signed image link.
//   `GET /__e2e/sessions/<id>/uploads` reads them back (base64), so a test can check what left
//   the browser. `PATCH` takes `image: null` (remove) and `image: { alt }`. As api-user, a
//   picture's request names the picture it replaces (`expectedImage`; `409 image_changed` if the
//   story has another), and `GET` of one story says whether its picture's file arrived.
// - The profile (M2 plan PR 8): `POST /v1/stories/{id}/withdraw`, `DELETE /v1/stories/{id}` and
//   `POST /v1/account/consents/{type}/withdraw`, with api-user's status rules. A seeded story may
//   carry its `status`, `slug`, moderator's `rejectionFeedback` and whether it may be `shared`
//   beyond heisreal.today (O4: chosen per story, granted with `storyId` and withdrawn with
//   `POST /v1/account/consents/share_socials/withdraw` and `{ storyId }`, or granted with the
//   submission: submit's `shareBeyondSite`, in the same idempotent command). Erasure (PR 11):
//   `DELETE /v1/account`, and withdrawing the testimony or sign-up consent, erase the session:
//   its token gets 401 afterwards.
// - Download my data (M2 plan PR 12): `GET /v1/account/export`, the session's own stories,
//   consents and hearts in api-user's shape (a session starting `export-fails` gets 503).
// - Hearts (M2): `PUT`/`DELETE /v1/account/favourites/{storyId}` and `GET /v1/account/favourites`
//   (a page of cards, or `?storyId=…` for "which of these are hearted"). Cards come from the
//   stub api-public-read (STUB_PUBLIC_URL, `/__test/cards`), as the real one reads publicStory,
//   so a story hidden there leaves the list too.
// - api-admin's legal document routes (D121, D125), on the same port for the stub (web's
//   API_ADMIN_URL points here; the real ones are two services): `GET /v1/admin/legal-documents/
//   {privacy|terms}/versions` and `POST …/versions`, Admin and above only (sessions starting
//   `admin` are Admins; everyone else 403). Each document starts with dev's placeholder versions;
//   a publish is checked like the real one (its text, and 409 unless the version it was based on
//   is still in force) and kept per session. A session seeded with `noLegalDocuments` starts with none (a fresh
//   environment's first publication).
// - api-admin's submission limits (W3, D112): `GET`/`PUT /v1/admin/submission-settings`, Admins
//   only, kept per session from data 0006's values; a save is checked like the real one (bounds,
//   minimum ≤ maximum, 428 without If-Match, 412 unless it's the version read).
// - api-admin's themes (themes plan v3): `GET`/`PUT /v1/admin/themes`, Admins only, kept per
//   session from a small catalogue (Topics, Feelings, Journeys and Other, with story counts); a
//   save of the whole picture is checked like the real one (Other kept, names tidied, no
//   duplicates ignoring case, 428 without If-Match, 412 unless it's the version read).
//
// It accepts only the fixtures' token (account-control.tsx): `e2e.<payload>.fixture`, whose payload
// is the fixture person (`sub`) and an optional session a test picks (localStorage
// `e2e-session`); anything else is 401.
// Hearts are kept per token, so tests running in parallel never see each other's. A session
// starting `no-consent` has lost the sign-up consent since the page loaded (its account answer
// still says accepted): hearting answers 403 `consent_required` (D73).
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const port = Number(process.env.STUB_USER_PORT ?? 4313);
const publicUrl = process.env.STUB_PUBLIC_URL ?? 'http://127.0.0.1:4310';
const origins = (process.env.STUB_USER_ORIGINS ?? '')
  .split(',')
  .filter(Boolean);
const SESSION = /^Bearer e2e\.([A-Za-z0-9_-]{1,200})\.fixture$/;
const FIXTURE_USER = 'user_e2efixture';
/** The fixture token's session ('' for none), or null if it isn't the fixture person's. */
function sessionOf(authorization) {
  const match = SESSION.exec(authorization ?? '');
  if (!match) return null;
  try {
    const { sub, session } = JSON.parse(
      Buffer.from(match[1], 'base64url').toString('utf8'),
    );
    if (sub !== FIXTURE_USER) return null;
    return typeof session === 'string' && /^[a-z0-9-]{0,64}$/.test(session)
      ? session
      : null;
  } catch {
    return null;
  }
}
const ACCOUNT = {
  id: 'e2efixture',
  version: null,
  role: 'User',
  createdAt: '2026-10-25T12:00:00.000Z',
  signupConsent: { accepted: true },
  testimonyConsent: { acceptanceRequired: false },
};
const ID = /^[A-Za-z0-9_]{1,64}$/;

/** Hearts per session token: story id → when (a counter, newest highest). */
const hearts = new Map();
let clock = 0;

/** The statements of each form's version in force, v2 (D84, D93, D122). */
const FORMS = {
  signup: ['age_18plus', 'account_data', 'terms_of_use'],
  testimony: ['special_category_religious', 'publish'],
  social: ['share_socials'],
};
const MECHANISMS = [
  'web_form_submission',
  'account_settings',
  'reconsent_prompt',
];
/** Idempotency-Key → { body, answer } (D29). */
const replies = new Map();
let events = 0;
/** Sessions whose account was erased (`DELETE /v1/account`, or an erasing withdrawal): 401 after. */
const erased = new Set();
/** api-user's ERASING_WITHDRAWALS (D88, D73). */
const ERASING = ['special_category_religious', 'account_data'];

const send = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const readBytes = (req) =>
  new Promise((done) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => done(Buffer.concat(chunks)));
  });

// --- api-admin: the legal documents (D121, D125) --------------------------------------------
const LEGAL = resolve(import.meta.dirname, '../../../libs/legal');
const repoVersion = (number, file, publishedAt) => ({
  number,
  publishedAt,
  publishedBy: null,
  source: 'repo',
  devPlaceholder: true,
  text: readFileSync(`${LEGAL}/${file}`, 'utf8'),
});
/** Dev's placeholder versions of a document (data 0007), as api-admin lists them. */
const devVersions = (document) =>
  document === 'privacy'
    ? [
        repoVersion(2, 'dpa/dev_policy.md', '2026-10-30T12:00:00.000Z'),
        repoVersion(1, 'dpa/dev_placeholder.md', '2026-10-25T12:00:00.000Z'),
      ]
    : [repoVersion(1, 'terms/dev_placeholder.md', '2026-10-30T12:00:00.000Z')];
/** Session → document → versions (newest first). */
const adminState = new Map();
const versionsFor = (session, document) => {
  if (!adminState.has(session)) adminState.set(session, new Map());
  const docs = adminState.get(session);
  if (!docs.has(document)) docs.set(document, devVersions(document));
  return docs.get(document);
};
const listOf = (document, versions) => ({
  document,
  current: versions.length
    ? { number: versions[0].number, text: versions[0].text }
    : null,
  data: versions.map(({ text: _t, ...v }) => v),
});
const invalid = (res, pointer, code, message = code) => {
  res.writeHead(400, {
    'content-type': 'application/problem+json',
    'cache-control': 'no-store',
  });
  res.end(
    JSON.stringify({
      type: 'about:blank',
      title: 'Validation failed',
      status: 400,
      code: 'validation_failed',
      errors: [{ pointer, code, message }],
    }),
  );
};

/** `POST …/versions` (PublishLegalDocument), checked like api-admin. */
async function publishDocument(req, res, session, document) {
  const body = await readJson(req);
  const text =
    typeof body?.text === 'string' ? body.text.replace(/\r\n?/g, '\n') : '';
  if (!text.trim()) return invalid(res, '/text', 'invalid_text');
  const versions = versionsFor(session, document);
  // Another admin published meanwhile: the version edited isn't in force now.
  if ((body.basedOn ?? null) !== (versions[0]?.number ?? null))
    return problem(res, 409, 'Conflict', 'document_changed');
  const number = (versions[0]?.number ?? 0) + 1;
  const publishedAt = new Date().toISOString();
  versions.unshift({
    number,
    publishedAt,
    publishedBy: 'e2efixture',
    source: 'admin',
    devPlaceholder: false,
    text,
  });
  res.setHeader('location', `/v1/admin/legal-documents/${document}/versions`);
  return send(res, 201, { number, publishedAt });
}

// --- api-admin: the submission limits (W3, D112, D113) ---------------------------------------
const MIB = 1_048_576;
/** As api-admin's BOUNDS. */
const SETTING_BOUNDS = {
  storyTextMin: { min: 1, max: 50_000 },
  storyTextMax: { min: 1, max: 50_000 },
  themesMin: { min: 0, max: 20 },
  themesMax: { min: 0, max: 20 },
  openDraftsMax: { min: 1, max: 1000 },
  submissionsPer7Days: { min: 1, max: 1000 },
  uploadRequestsPerHour: { min: 1, max: 10_000 },
  uploadsPer7Days: { min: 1, max: 1000 },
  videoMaxBytes: { min: MIB, max: 10 * 1024 * MIB },
  audioMaxBytes: { min: MIB, max: 2 * 1024 * MIB },
  mediaMaxSeconds: { min: 60, max: 10_800 },
};
/** Session → `{ version, changedBy, settings }`, starting from data 0006's values. */
const settingsState = new Map();
const settingsFor = (session) => {
  if (!settingsState.has(session))
    settingsState.set(session, {
      version: 1,
      changedBy: null,
      settings: {
        storyTextMin: 200,
        storyTextMax: 10_000,
        themesMin: 1,
        themesMax: 5,
        openDraftsMax: 3,
        submissionsPer7Days: 1,
        uploadRequestsPerHour: 10,
        uploadsPer7Days: 5,
        videoMaxBytes: 4096 * MIB,
        audioMaxBytes: 500 * MIB,
        mediaMaxSeconds: 900,
      },
    });
  return settingsState.get(session);
};

/** `GET /v1/admin/submission-settings`: a strong ETag from the version, as api-admin. */
function sendSettings(req, res, session) {
  const s = settingsFor(session);
  const etag = `"${s.version}"`;
  const headers = { etag, 'cache-control': 'private, no-store' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'content-type': 'application/json' });
  return res.end(
    JSON.stringify({
      version: s.version,
      updatedAt: '2026-10-30T12:00:00.000Z',
      changedBy: s.changedBy,
      settings: s.settings,
      bounds: SETTING_BOUNDS,
    }),
  );
}

/** `PUT /v1/admin/submission-settings` (UpdateSubmissionSettings), checked like api-admin. */
async function saveSettings(req, res, session) {
  const s = settingsFor(session);
  const ifMatch = req.headers['if-match'];
  if (!ifMatch)
    return problem(res, 428, 'Precondition required', 'if_match_required');
  const body = (await readJson(req)) ?? {};
  for (const [field, { min, max }] of Object.entries(SETTING_BOUNDS)) {
    const v = body[field];
    if (!Number.isInteger(v) || v < min || v > max)
      return invalid(res, `/${field}`, 'out_of_range');
  }
  if (body.storyTextMin > body.storyTextMax)
    return invalid(res, '/storyTextMin', 'min_over_max');
  if (body.themesMin > body.themesMax)
    return invalid(res, '/themesMin', 'min_over_max');
  // Another admin saved meanwhile.
  if (ifMatch !== `"${s.version}"`)
    return problem(res, 412, 'Precondition failed', 'stale_version');
  s.version += 1;
  s.changedBy = 'e2efixture';
  s.settings = Object.fromEntries(
    Object.keys(SETTING_BOUNDS).map((f) => [f, body[f]]),
  );
  res.setHeader('etag', `"${s.version}"`);
  return send(res, 200, { id: 'current', version: s.version });
}

// --- api-admin: the themes (themes plan v3) ----------------------------------------------------
/** Each session's categories and themes, as GET /v1/admin/themes sends them, and the version. */
const adminThemes = new Map();
const adminThemesFor = (session) => {
  if (!adminThemes.has(session)) {
    const t = (id, name, highlighted, storyCount = 0) => ({
      id,
      name,
      highlighted,
      storyCount,
    });
    adminThemes.set(session, {
      version: 3,
      categories: [
        {
          id: 'c_feelings',
          name: 'Feelings',
          themes: [
            t('t_grief', 'Grief', false, 2),
            t('t_hope', 'Hope', true, 5),
          ],
        },
        {
          id: 'c_journeys',
          name: 'Journeys',
          themes: [
            t('t_coming', 'Coming to faith', false),
            t('t_doubt', 'Doubt', false, 4),
          ],
        },
        {
          id: 'c_topics',
          name: 'Topics',
          themes: [
            t('t_healing', 'Healing', true, 7),
            t('t_loss', 'Loss', true, 3),
            t('t_work', 'Work', false),
          ],
        },
        { id: 'other', name: 'Other', themes: [] },
      ],
    });
  }
  return adminThemes.get(session);
};
const tidy = (name) => {
  const spaced = name.trim().replace(/\s+/gu, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};
const byName = (a, b) =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

/** `GET /v1/admin/themes`: categories A–Z with Other last, themes A–Z. */
function sendAdminThemes(res, session) {
  const { version, categories } = adminThemesFor(session);
  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'private, no-store',
    etag: `"${version}"`,
  });
  res.end(
    JSON.stringify({
      version,
      categories: [...categories]
        .sort(
          (a, b) =>
            Number(a.id === 'other') - Number(b.id === 'other') || byName(a, b),
        )
        .map((c) => ({ ...c, themes: [...c.themes].sort(byName) })),
    }),
  );
}

/**
 * `PUT /v1/admin/themes` (SaveThemes): the whole picture at the version read, checked like
 * api-admin (Other kept and unrenamed, names tidied, no duplicates ignoring case), then kept.
 */
async function saveAdminThemes(req, res, session) {
  const state = adminThemesFor(session);
  const ifMatch = req.headers['if-match'];
  if (!ifMatch)
    return problem(res, 428, 'Precondition required', 'if_match_required');
  const body = await readJson(req);
  if (!Array.isArray(body?.categories))
    return invalid(res, '/categories', 'required', 'A list of categories.');
  const counts = new Map(
    state.categories.flatMap((c) => c.themes.map((t) => [t.id, t.storyCount])),
  );
  const names = { c: new Set(), t: new Set() };
  let next = 0;
  const fresh = (id) =>
    id.startsWith('new-') ? `n${++next}_${Date.now()}` : id;
  const categories = [];
  for (const [ci, c] of body.categories.entries()) {
    const name = tidy(String(c.name ?? ''));
    if (!name || name.length > 40)
      return invalid(
        res,
        `/categories/${ci}/name`,
        'length',
        'A name of 1 to 40 characters.',
      );
    const key = name.normalize('NFC').toLowerCase();
    if (names.c.has(key))
      return invalid(
        res,
        `/categories/${ci}/name`,
        'duplicate',
        `There is already a category called “${name}”.`,
      );
    names.c.add(key);
    const themes = [];
    for (const [ti, t] of (c.themes ?? []).entries()) {
      const tname = tidy(String(t.name ?? ''));
      const tkey = tname.normalize('NFC').toLowerCase();
      if (!tname || tname.length > 40)
        return invalid(
          res,
          `/categories/${ci}/themes/${ti}/name`,
          'length',
          'A name of 1 to 40 characters.',
        );
      if (names.t.has(tkey))
        return invalid(
          res,
          `/categories/${ci}/themes/${ti}/name`,
          'duplicate',
          `There is already a theme called “${tname}”.`,
        );
      names.t.add(tkey);
      themes.push({
        id: fresh(t.id),
        name: tname,
        highlighted: t.highlighted === true,
        storyCount: counts.get(t.id) ?? 0,
      });
    }
    categories.push({ id: fresh(c.id), name, themes });
  }
  const other = categories.find((c) => c.id === 'other');
  if (!other)
    return invalid(
      res,
      '/categories',
      'other_required',
      'The Other category can’t be deleted.',
    );
  if (other.name !== 'Other')
    return invalid(
      res,
      '/categories',
      'other_fixed',
      'The Other category can’t be renamed.',
    );
  // Another admin saved meanwhile (A2): refused, never merged.
  if (ifMatch !== `"${state.version}"`)
    return problem(res, 412, 'Precondition failed', 'stale_version');
  state.version += 1;
  state.categories = categories;
  res.setHeader('etag', `"${state.version}"`);
  return send(res, 200, { id: 'current', version: state.version });
}

const readBody = (req) =>
  new Promise((done) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => done(text));
  });

/**
 * `POST /v1/account/consents` (GrantConsent), checked like the real service. O4: `share_socials`
 * names one story of the session's own (`hasStory`), and nothing else names one.
 */
async function grant(req, res, onGranted, hasStory = () => false) {
  const text = await readBody(req);
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
    return problem(res, 400, 'Bad request', 'idempotency_key_required');
  }
  const earlier = replies.get(key);
  if (earlier) {
    if (earlier.text !== text) {
      return problem(
        res,
        422,
        'Idempotency key reused',
        'idempotency_key_reused',
      );
    }
    return send(res, 201, earlier.answer);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return problem(res, 400, 'Bad request', 'validation_failed');
  }
  const {
    form,
    formVersion,
    statement,
    mechanism,
    privacyPolicyVersion,
    termsVersion,
    storyId,
    ...rest
  } = body ?? {};
  if (
    !(form in FORMS) ||
    typeof formVersion !== 'string' ||
    typeof statement !== 'string' ||
    !MECHANISMS.includes(mechanism) ||
    Object.keys(rest).length !== 0 ||
    (statement === 'share_socials'
      ? typeof storyId !== 'string' || !ID.test(storyId)
      : storyId !== undefined)
  ) {
    return problem(res, 400, 'Bad request', 'validation_failed');
  }
  if (formVersion !== 'v2') {
    return problem(res, 409, 'Conflict', 'form_version_not_in_force');
  }
  // D122: the documents shown must be named and be the ones in force (dev's placeholders); the
  // sign-up version asks for the terms.
  if (
    privacyPolicyVersion !== 'dev_policy' ||
    (form === 'signup' && termsVersion !== 'dev_placeholder')
  ) {
    return problem(res, 409, 'Conflict', 'legal_document_not_in_force');
  }
  if (!FORMS[form].includes(statement)) {
    return problem(res, 409, 'Conflict', 'statement_not_on_form');
  }
  if (storyId !== undefined && !hasStory(storyId)) {
    return problem(res, 404, 'Not found', 'story_not_found');
  }
  onGranted?.(form, statement, storyId);
  events += 1;
  const answer = { id: `stubconsent${events}`, version: null };
  replies.set(key, { text, answer });
  return send(res, 201, answer);
}

const problem = (res, status, title, code) => {
  res.writeHead(status, {
    'content-type': 'application/problem+json',
    'cache-control': 'no-store',
  });
  res.end(
    JSON.stringify({
      type: 'about:blank',
      title,
      status,
      ...(code ? { code } : {}),
    }),
  );
};

/** A JSON answer with a weak ETag; 304 to a matching If-None-Match. */
function cached(req, res, body) {
  const text = JSON.stringify(body);
  const etag = `W/"${createHash('sha256').update(text).digest('hex').slice(0, 32)}"`;
  const headers = { etag, 'cache-control': 'private, no-store' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'content-type': 'application/json' });
  return res.end(text);
}

/** The public cards now, by id (the stub api-public-read's dev port). */
async function publicCards() {
  const res = await fetch(`${publicUrl}/__test/cards`);
  const { data } = await res.json();
  return new Map(data.map((card) => [card.id, card]));
}

async function listFavourites(req, res, url, mine) {
  const p = url.searchParams;
  const known = new Set(['storyId', 'limit', 'cursor']);
  const ids = p.getAll('storyId');
  const bad = (pointer) => {
    res.writeHead(400, {
      'content-type': 'application/problem+json',
      'cache-control': 'no-store',
    });
    res.end(
      JSON.stringify({
        type: 'about:blank',
        title: 'Validation failed',
        status: 400,
        code: 'validation_failed',
        errors: [{ pointer, message: 'Invalid.' }],
      }),
    );
  };
  for (const name of p.keys()) if (!known.has(name)) return bad(`/${name}`);
  const cards = await publicCards();
  // Newest heart first, public stories only (C15).
  const listed = [...mine.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => cards.get(id))
    .filter(Boolean);
  if (ids.length) {
    if (p.has('limit') || p.has('cursor')) return bad('/storyId');
    if (ids.length > 50 || !ids.every((id) => ID.test(id)))
      return bad('/storyId');
    const asked = new Set(ids);
    return cached(req, res, {
      data: listed.filter((c) => asked.has(c.id)),
      nextCursor: null,
    });
  }
  const limit = p.has('limit') ? Number(p.get('limit')) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return bad('/limit');
  const cursor = p.get('cursor');
  const offset = cursor === null ? 0 : Number(/^o(\d{1,4})$/.exec(cursor)?.[1]);
  if (!Number.isInteger(offset)) return bad('/cursor');
  const page = listed.slice(offset, offset + limit);
  return cached(req, res, {
    data: page,
    nextCursor: offset + limit < listed.length ? `o${offset + limit}` : null,
  });
}

// --- The submit flow (M2 plan PR 4) ---------------------------------------------------------
// Per test session (the fixture token's `session`): the person's consent, the limits (seedable
// settings, W3), their stories, and CreateDraftStory / EditStory / SubmitStory, with the rules
// the real service and database apply (consent, If-Match, Idempotency-Key, the text and theme
// limits, the content lock and D94's limits). A test seeds its session with
// `POST /__e2e/sessions/<session>` (not part of api-user).
const WEEK_MS = 7 * 24 * 3600 * 1000;
/** The stand-in testimony forms keep an untouched draft 6 months, a month counted as 31 days. */
const DRAFT_RETENTION_MS = 186 * 24 * 3600 * 1000;
/** The settings' defaults (W3, D112: submissionSettings); a test may seed others. */
const SETTINGS = {
  storyTextMin: 200,
  storyTextMax: 10000,
  themesMin: 1,
  themesMax: 5,
  openDraftsMax: 3,
  submissionsPer7Days: 1,
  uploadRequestsPerHour: 10,
  uploadsPer7Days: 5,
  videoMaxBytes: 4294967296,
  audioMaxBytes: 524288000,
  mediaMaxSeconds: 900,
};
/**
 * GET /v1/themes (themes plan v3): every category with themes, A–Z with Other last, themes A–Z.
 * Topics' themes are highlighted, Feelings' Hope too; Journeys has none highlighted, so it shows
 * only under "More themes". Ids are short words here (the real ones are ULIDs). A test may delete
 * a theme for its session (`POST /__e2e/sessions/<id>/delete-theme?id=`), as an admin would.
 */
const THEME_CATEGORIES = [
  {
    id: 'feelings',
    name: 'Feelings',
    themes: [
      { id: 'hope', name: 'Hope', highlighted: true },
      { id: 'loss', name: 'Loss', highlighted: false },
    ],
  },
  {
    id: 'journeys',
    name: 'Journeys',
    themes: [
      { id: 'addiction', name: 'Addiction', highlighted: false },
      { id: 'doubt', name: 'Doubt', highlighted: false },
    ],
  },
  {
    id: 'topics',
    name: 'Topics',
    themes: [
      { id: 'faith', name: 'Faith', highlighted: true },
      { id: 'healing', name: 'Healing', highlighted: true },
    ],
  },
];
/** The session's themes: all of them less any its test deleted. */
const themesOf = (s) =>
  THEME_CATEGORIES.map((c) => ({
    ...c,
    themes: c.themes.filter((t) => !s.deletedThemes.has(t.id)),
  })).filter((c) => c.themes.length > 0);
const themeRef = (s, id) => {
  const t = themesOf(s)
    .flatMap((c) => c.themes)
    .find((x) => x.id === id);
  return t ? { id: t.id, name: t.name } : null;
};
/** The person's own consents, for all their stories; sharing is per story (O4). */
const CONSENT_TYPES = [
  'special_category_religious',
  'publish',
  'age_18plus',
  'account_data',
];
const FORM_OF = {
  special_category_religious: 'testimony',
  publish: 'testimony',
  share_socials: 'social',
  age_18plus: 'signup',
  account_data: 'signup',
};

/** One person per session. `seed` (POST /__e2e/sessions/…) sets the starting state. */
const sessions = new Map();
let seq = 0;
function newSession(id, seed = {}) {
  const s = {
    // Signed up unless a test says otherwise, so other pages carry on as usual.
    signup: seed.signupAccepted ?? !id.startsWith('unaccepted'),
    granted: new Set(seed.granted ?? []),
    trusted: seed.trusted ?? false,
    settings: { ...SETTINGS, ...(seed.settings ?? {}) },
    deletedThemes: new Set(),
    stories: new Map(),
    keys: new Map(),
    // Uploads: the videos made for this session's drafts, when new ones were started, and
    // what the TUS server should do with the next PATCHes.
    videos: new Map(),
    // `uploadsAgo`: video or audio uploads started that many ms before the session began.
    uploadTimes: (seed.uploadsAgo ?? []).map((ms) => ({
      at: Date.now() - ms,
      image: false,
    })),
    uploadRequests: 0,
    tus: { fail: 0, hold: false },
    // O4: which stories' sharing was ever chosen (a withdrawal needs a grant before it).
    sharingChosen: new Set(),
    // Pictures by path: { story, size, bytes (a Buffer once PUT) }.
    images: new Map(),
    // Erasure: `DELETE /v1/account` erases, then answers 500 (the queue failed after the commit).
    eraseThenFail: seed.eraseThenFail ?? false,
  };
  for (const story of seed.stories ?? []) {
    const now = new Date().toISOString();
    s.stories.set(story.id, {
      version: 1,
      status: 'draft',
      description: '',
      bylineName: null,
      themeIds: [],
      submittedAt: null,
      createdAt: now,
      updatedAt: now,
      ...story,
    });
  }
  return s;
}

const sendJson = (
  res,
  status,
  body,
  headers = {},
  type = 'application/json',
) => {
  res.writeHead(status, {
    ...(body === undefined ? {} : { 'content-type': type }),
    'cache-control': 'private, no-store',
    ...headers,
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};
const shareProblem = (res, status, title, code, extra = {}) =>
  sendJson(
    res,
    status,
    {
      type: 'about:blank',
      title,
      status,
      ...(code ? { code } : {}),
      ...extra,
    },
    {},
    'application/problem+json',
  );
const weak = (body) =>
  `W/"${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)}"`;
const collection = (req, res, body) => {
  const etag = weak(body);
  if (req.headers['if-none-match'] === etag)
    return sendJson(res, 304, undefined, { etag });
  return sendJson(res, 200, body, { etag });
};
const readJson = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(null);
      }
    });
  });
const trimmed = (t) => [...(t ?? '').trim()].length;

function consentState(s) {
  const current = CONSENT_TYPES.map((type) => {
    const granted = s.granted.has(type);
    return {
      type,
      granted,
      form: granted ? FORM_OF[type] : null,
      formVersion: granted ? 'v1' : null,
      dpaVersion: granted ? 'dev_placeholder' : null,
      occurredAt: granted ? '2026-10-26T12:00:00.000Z' : null,
      counts: granted,
    };
  });
  const art9 = s.granted.has('special_category_religious');
  return {
    current,
    signup: { accepted: s.signup, latestVersion: 'v1' },
    testimony: {
      version: art9 ? 'v1' : null,
      latestVersion: 'v1',
      updateAvailable: false,
      acceptanceRequired: false,
    },
    history: [],
  };
}

/** `uploaded`: whether the picture's file arrived, checked only when one story is read. */
function storyMine(s, id, st, uploaded = () => null) {
  return {
    id,
    version: st.version,
    slug: st.slug ?? `story-${id}`,
    status: st.status,
    title: st.title,
    description: st.description,
    body: st.body ?? null,
    bylineName: st.bylineName,
    primaryFormat: st.primaryFormat ?? 'written',
    media: st.videoId
      ? [
          {
            format: st.primaryFormat,
            playbackUrl: null,
            thumbnailUrl: null,
            width: null,
            height: null,
            durationSeconds: null,
            processing: null,
          },
        ]
      : [],
    image: st.image
      ? {
          url: st.image.url,
          width: st.image.width,
          height: st.image.height,
          alt: st.image.alt ?? null,
          path: st.image.path,
          uploaded: uploaded(st.image.path),
        }
      : null,
    // A deleted theme is left out, as api-user does.
    themes: st.themeIds.map((id) => themeRef(s, id)).filter(Boolean),
    rejectionFeedback: st.rejectionFeedback ?? null,
    submittedAt: st.submittedAt,
    approvedAt: null,
    createdAt: st.createdAt,
    updatedAt: st.updatedAt,
    // api-user's rule (fn::story::draft_expires_at) with the stand-in forms' 6 months, from the
    // last edit (this stub doesn't renew uploads).
    draftExpiresAt:
      st.status === 'draft'
        ? new Date(Date.parse(st.updatedAt) + DRAFT_RETENTION_MS).toISOString()
        : null,
    sharing: sharingOf(st),
  };
}

/** O4: a story's own sharing beyond heisreal.today, as `StorySharing`. */
const sharingOf = (st) => ({
  granted: !!st.shared,
  counts: !!st.shared,
  formVersion: st.shared ? 'v2' : null,
  occurredAt: st.shared ? '2026-10-31T12:00:00.000Z' : null,
});

/**
 * "Download my data" (M2 plan PR 12): the session's own stories, consents and hearts in
 * api-user's `AccountExport` shape. Media as the real one gives them: ids and a link, no bytes.
 */
function myDataOf(s, token, mine) {
  const generatedAt = new Date().toISOString();
  const linksExpireAt = new Date(Date.now() + 3600_000).toISOString();
  const none = (keys) => Object.fromEntries(keys.map((k) => [k, null]));
  return {
    about: {
      format: 'he-is-real-my-data',
      formatVersion: 1,
      generatedAt,
      linksExpireAt,
      summary:
        'Everything He Is Real Today holds about you (the e2e stand-in).',
      sections: { account: 'Your account.', stories: 'Your stories.' },
      notIncluded: ['Anyone else’s data.'],
    },
    account: { id: ACCOUNT.id, createdAt: ACCOUNT.createdAt, role: 'User' },
    signIn: {
      clerkUserId: FIXTURE_USER,
      firstName: 'Fixture',
      lastName: null,
      username: null,
      emailAddresses: [
        {
          emailAddress: `${token || 'fixture'}@example.org`,
          primary: true,
          verified: true,
        },
      ],
      phoneNumbers: [],
      connectedAccounts: [],
      profileImageUrl: null,
      twoFactorEnabled: false,
      createdAt: ACCOUNT.createdAt,
      lastSignInAt: ACCOUNT.createdAt,
      lastActiveAt: null,
    },
    stories: [...s.stories].reverse().map(([id, st]) => {
      const { version: _v, media, ...rest } = storyMine(s, id, st);
      return {
        ...rest,
        onSiteNow: st.status === 'approved',
        media: media.map((m) => ({
          ...m,
          bunnyVideoId: st.videoId,
          playbackUrl: `https://player.mediadelivery.net/embed/1/${st.videoId}?token=stub&expires=1`,
        })),
        moderation: st.rejectionFeedback
          ? [
              {
                decision: 'request_changes',
                feedbackToSubmitter: st.rejectionFeedback,
                storyVersion: 1,
                decidedAt: st.updatedAt,
              },
            ]
          : [],
        publishedAt: null,
      };
    }),
    consents: [...s.granted]
      .map((type, i) => ({
        id: `stubconsent_${i}`,
        type,
        event: 'granted',
        statement: `The words beside the ${type} box.`,
        form: FORM_OF[type],
        formVersion: 'v2',
        privacyPolicyVersion: 'dev_placeholder',
        termsVersion: null,
        storyId: null,
        mechanism: 'web_form_submission',
        evidenceHash: '0'.repeat(64),
        evidenceVersion: 4,
        occurredAt: '2026-10-26T12:00:00.000Z',
        legacyGivenAt: null,
      }))
      .concat(
        [...s.stories]
          .filter(([, st]) => st.shared)
          .map(([storyId]) => ({
            id: `stubconsent_share_${storyId}`,
            type: 'share_socials',
            event: 'granted',
            statement: 'The words beside the share_socials box.',
            form: 'social',
            formVersion: 'v2',
            privacyPolicyVersion: 'dev_placeholder',
            termsVersion: null,
            storyId,
            mechanism: 'account_settings',
            evidenceHash: '0'.repeat(64),
            evidenceVersion: 5,
            occurredAt: '2026-10-31T12:00:00.000Z',
            legacyGivenAt: null,
          })),
      ),
    favourites: [...mine].map(([storyId]) => ({
      storyId,
      heartedAt: generatedAt,
      publicPath: null,
    })),
    limits: {
      trusted: s.trusted,
      overrides: null,
      overridesChangedAt: null,
      effective: {
        ...none(['openDraftsMax', 'submissionsPer7Days', 'uploadsPer7Days']),
        uploadRequestsPerHour: 10,
        videoMaxBytes: 4 * 1024 * MIB,
        audioMaxBytes: 500 * MIB,
        mediaMaxSeconds: 900,
      },
    },
    submissions: [],
    uploads: [],
    requestKeys: [],
  };
}

/** The same field checks as api-user (story-input.ts): 400 with pointers, never the values. */
/** GET /v1/account/limits: the session's settings, and its own limits (trusted: none). */
function limitsOf(s) {
  const open = [...s.stories.values()].filter(
    (x) => x.status === 'draft',
  ).length;
  const recent = [...s.stories.values()]
    .map((x) => (x.submittedAt ? Date.parse(x.submittedAt) : 0))
    .filter((t) => t + WEEK_MS > Date.now())
    .sort((a, b) => a - b);
  const per7Days = s.trusted ? null : s.settings.submissionsPer7Days;
  const next =
    per7Days !== null && recent.length >= per7Days
      ? new Date(recent[recent.length - per7Days] + WEEK_MS).toISOString()
      : null;
  return {
    storyText: { min: s.settings.storyTextMin, max: s.settings.storyTextMax },
    themes: { min: s.settings.themesMin, max: s.settings.themesMax },
    openDrafts: { max: s.trusted ? null : s.settings.openDraftsMax, open },
    submissions: {
      per7Days,
      usedIn7Days: recent.length,
      nextAvailableAt: next,
    },
    uploads: uploadLimitsOf(s),
  };
}

/**
 * The upload half of the limits (D113): trusted has no weekly limit and the ceilings. Every grant
 * counts per hour; only video and audio files per 7 days, so a picture checks the hour only.
 */
function uploadLimitsOf(s, format = 'video') {
  const now = Date.now();
  const recent = s.uploadTimes
    .filter((t) => t.at + WEEK_MS > now)
    .sort((a, b) => a.at - b.at);
  const hour = recent.filter((t) => t.at + 3600_000 > now).map((t) => t.at);
  const week = recent.filter((t) => !t.image).map((t) => t.at);
  const perHour = s.settings.uploadRequestsPerHour;
  const per7Days = s.trusted ? null : s.settings.uploadsPer7Days;
  const byHour =
    hour.length >= perHour ? hour[hour.length - perHour] + 3600_000 : null;
  const byWeek =
    format !== 'image' && per7Days !== null && week.length >= per7Days
      ? week[week.length - per7Days] + WEEK_MS
      : null;
  const next = Math.max(byHour ?? 0, byWeek ?? 0);
  return {
    videoMaxBytes: s.trusted ? 10737418240 : s.settings.videoMaxBytes,
    audioMaxBytes: s.trusted ? 2147483648 : s.settings.audioMaxBytes,
    maxDurationSeconds: s.trusted ? 10800 : s.settings.mediaMaxSeconds,
    perHour,
    per7Days,
    usedIn7Days: week.length,
    nextAvailableAt: next ? new Date(next).toISOString() : null,
  };
}

/** A4: the types api-user accepts. */
const UPLOAD_TYPES = {
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  audio: [
    'audio/mpeg',
    'audio/mp4',
    'audio/x-m4a',
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
  ],
};
/** The stub's stand-in for sha256(libraryId + key + expires + videoId). */
const tusSignature = (expires, videoId) =>
  createHash('sha256')
    .update(`stub-library-key${expires}${videoId}`)
    .digest('hex');
/** The stub's stand-in for a presigned PUT's signature: the path and the exact size. */
const s3Signature = (path, size, expires) =>
  createHash('sha256')
    .update(`stub-zone-password${path}${size}${expires}`)
    .digest('hex');
/** TUS uploads by id: { session, videoId, length, received }. */
const tusUploads = new Map();

// An edit over a maximum is refused only if it makes it worse (Joel, 2026-10-30: trimming a draft
// that's over a newly lowered limit is saved); `current` is the stored story, none on create.
function fieldErrors(b, allowed, s, current) {
  const errors = [];
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    return [{ pointer: '', message: 'a JSON object' }];
  }
  for (const k of Object.keys(b)) {
    if (!allowed.includes(k))
      errors.push({ pointer: `/${k}`, message: 'not a field you can set' });
  }
  if (
    'title' in b &&
    (typeof b.title !== 'string' ||
      !b.title.trim() ||
      b.title.trim().length > 140)
  )
    errors.push({ pointer: '/title', message: '1–140 characters' });
  if (
    'description' in b &&
    (typeof b.description !== 'string' || b.description.length > 5000)
  )
    errors.push({
      pointer: '/description',
      message: 'at most 5000 characters',
    });
  if (
    'body' in b &&
    b.body !== null &&
    (typeof b.body !== 'string' ||
      (b.body.length > s.settings.storyTextMax &&
        b.body.length > (current?.body?.length ?? 0)))
  )
    errors.push({
      pointer: '/body',
      message: `at most ${s.settings.storyTextMax} characters`,
    });
  if (
    'bylineName' in b &&
    b.bylineName !== null &&
    (typeof b.bylineName !== 'string' || b.bylineName.trim().length > 80)
  )
    errors.push({ pointer: '/bylineName', message: 'at most 80 characters' });
  // Any number up to the hard ceiling: the settings' count is checked at submit only.
  if (
    'themeIds' in b &&
    (!Array.isArray(b.themeIds) ||
      b.themeIds.length > 20 ||
      new Set(b.themeIds).size !== b.themeIds.length)
  )
    errors.push({ pointer: '/themeIds', message: 'at most 20, no repeats' });
  return errors;
}

/** A theme chosen that doesn't exist (any more): an admin deleted it meanwhile (A7). */
const gone = (s, b) =>
  Array.isArray(b?.themeIds) && b.themeIds.some((id) => !themeRef(s, id));
const themesGone = (res) =>
  shareProblem(res, 400, 'Bad request', 'themes_changed', {
    detail: 'Themes have changed, please choose again',
    errors: [{ pointer: '/themeIds', message: 'a theme that doesn’t exist' }],
  });

/** Idempotency-Key (D29): replay the stored answer; 422 for the same key with another body. */
function idempotent(s, req, res, body, run) {
  const key = req.headers['idempotency-key'];
  if (!key || key.length < 16 || key.length > 128)
    return shareProblem(res, 400, 'Bad request', 'idempotency_key_required');
  const hash = JSON.stringify([
    req.method,
    req.url,
    body ?? null,
    req.headers['if-match'] ?? null,
  ]);
  const stored = s.keys.get(key);
  if (stored) {
    if (stored.hash !== hash)
      return shareProblem(
        res,
        422,
        'Unprocessable entity',
        'idempotency_key_reused',
      );
    return sendJson(res, stored.status, stored.body, stored.headers);
  }
  const answer = run();
  if (answer.status < 300) s.keys.set(key, { hash, ...answer });
  return sendJson(res, answer.status, answer.body, answer.headers);
}

const ifMatchOf = (req) => {
  const raw = req.headers['if-match'];
  if (raw === undefined) return undefined;
  const m = /^"(\d+)"$/.exec(raw.trim());
  return m ? Number(m[1]) : -1;
};

async function handleShare(req, res, path, url, s) {
  if (path === '/v1/account/consents' && req.method === 'GET') {
    return collection(req, res, consentState(s));
  }
  if (path === '/v1/account/limits' && req.method === 'GET') {
    return collection(req, res, limitsOf(s));
  }
  if (path === '/v1/themes' && req.method === 'GET') {
    return collection(req, res, { data: themesOf(s) });
  }
  if (path === '/v1/account/stories' && req.method === 'GET') {
    const status = url.searchParams.get('status');
    const data = [...s.stories]
      .filter(([, st]) => !status || st.status === status)
      .reverse()
      .map(([id, st]) => storyMine(s, id, st));
    return collection(req, res, { data, nextCursor: null });
  }
  const mine = /^\/v1\/account\/stories\/([^/]+)$/.exec(path);
  if (mine && req.method === 'GET') {
    const st = s.stories.get(mine[1]);
    if (!st) return shareProblem(res, 404, 'Not found');
    const etag = `"${st.version}"`;
    // As api-user: a picture whose file hasn't arrived is never answered 304.
    const arrived = (p) => !!s.images.get(p)?.bytes;
    if (
      req.headers['if-none-match'] === etag &&
      (!st.image || arrived(st.image.path))
    )
      return sendJson(res, 304, undefined, { etag });
    return sendJson(res, 200, storyMine(s, mine[1], st, arrived), { etag });
  }
  if (path === '/v1/stories' && req.method === 'POST') {
    // The guard: Art 9 on the forms in force (D93).
    if (!s.granted.has('special_category_religious') || !s.signup)
      return shareProblem(res, 403, 'Forbidden', 'consent_required');
    const b = await readJson(req);
    const errors = fieldErrors(
      b,
      [
        'title',
        'description',
        'body',
        'bylineName',
        'primaryFormat',
        'themeIds',
      ],
      s,
    );
    if (b && !('title' in b))
      errors.push({ pointer: '/title', message: 'required' });
    if (b && b.primaryFormat === 'written' && !trimmed(b.body))
      errors.push({
        pointer: '/body',
        message: 'a written story needs its text',
      });
    if (errors.length)
      return shareProblem(res, 400, 'Bad request', 'validation_failed', {
        errors,
      });
    if (gone(s, b)) return themesGone(res);
    return idempotent(s, req, res, b, () => {
      const open = [...s.stories.values()].filter(
        (st) => st.status === 'draft',
      ).length;
      const max = limitsOf(s).openDrafts.max;
      if (max !== null && open >= max) {
        return {
          status: 409,
          body: {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            code: 'draft_limit_reached',
            detail:
              'You already have as many drafts open as you can. Continue one of them, or submit one first.',
          },
          headers: { 'content-type': 'application/problem+json' },
        };
      }
      const id = `e2e${++seq}`;
      const now = new Date().toISOString();
      s.stories.set(id, {
        version: 1,
        status: 'draft',
        title: b.title.trim(),
        description: (b.description ?? '').trim(),
        body: b.body ?? null,
        bylineName: b.bylineName?.trim() || null,
        primaryFormat: b.primaryFormat,
        themeIds: b.themeIds ?? [],
        submittedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      return {
        status: 201,
        body: { id, version: 1 },
        headers: { location: `/v1/account/stories/${id}`, etag: '"1"' },
      };
    });
  }
  const edit = /^\/v1\/stories\/([^/]+)$/.exec(path);
  const withdraw = /^\/v1\/stories\/([^/]+)\/withdraw$/.exec(path);
  // DeleteStory (D71) and WithdrawStory (M2 plan PR 8): the same statuses as api-user.
  if (
    (edit && req.method === 'DELETE') ||
    (withdraw && req.method === 'POST')
  ) {
    const id = (edit ?? withdraw)[1];
    const st = s.stories.get(id);
    if (!st) return shareProblem(res, 404, 'Not found');
    const v = ifMatchOf(req);
    if (v === undefined)
      return shareProblem(
        res,
        428,
        'Precondition required',
        'if_match_required',
      );
    if (v !== st.version)
      return shareProblem(res, 412, 'Precondition failed', 'stale_version');
    if (edit) {
      if (
        !['draft', 'changes_requested', 'withdrawn', 'rejected'].includes(
          st.status,
        )
      )
        return shareProblem(res, 409, 'Conflict', 'story_not_deletable', {
          detail:
            'Only a draft, or a story sent back for changes, withdrawn or not accepted, can be deleted. Withdraw it first.',
        });
      s.stories.delete(id);
      return sendJson(res, 204, undefined);
    }
    if (
      !['pending', 'in_review', 'approved', 'changes_requested'].includes(
        st.status,
      )
    )
      return shareProblem(res, 409, 'Conflict', 'story_not_withdrawable', {
        detail:
          'Only a story waiting for review, in review or published can be withdrawn',
      });
    st.status = 'withdrawn';
    st.version += 1;
    st.updatedAt = new Date().toISOString();
    return sendJson(
      res,
      200,
      { id, version: st.version },
      { etag: `"${st.version}"` },
    );
  }
  if (edit && req.method === 'PATCH') {
    if (!s.granted.has('special_category_religious'))
      return shareProblem(res, 403, 'Forbidden', 'consent_required');
    const st = s.stories.get(edit[1]);
    if (!st) return shareProblem(res, 404, 'Not found');
    const v = ifMatchOf(req);
    if (v === undefined)
      return shareProblem(
        res,
        428,
        'Precondition required',
        'if_match_required',
      );
    if (v !== st.version)
      return shareProblem(res, 412, 'Precondition failed', 'stale_version');
    if (!['draft', 'changes_requested'].includes(st.status))
      return shareProblem(res, 409, 'Conflict', 'story_locked');
    const b = await readJson(req);
    const errors = fieldErrors(
      b,
      ['title', 'description', 'body', 'bylineName', 'themeIds', 'image'],
      s,
      st,
    );
    if (b && 'image' in b && b.image !== null) {
      if (!st.image)
        errors.push({ pointer: '/image', message: 'no picture to describe' });
    }
    if (b && 'body' in b && !trimmed(b.body))
      errors.push({
        pointer: '/body',
        message: 'a written story needs its text',
      });
    if (errors.length)
      return shareProblem(res, 400, 'Bad request', 'validation_failed', {
        errors,
      });
    if (gone(s, b)) return themesGone(res);
    if ('title' in b) st.title = b.title.trim();
    if ('description' in b) st.description = b.description.trim();
    if ('body' in b) st.body = b.body;
    if ('bylineName' in b) st.bylineName = b.bylineName?.trim() || null;
    if ('themeIds' in b) st.themeIds = b.themeIds;
    // The picture's file stays (api-user never deletes one: the clean-up sweep does).
    if ('image' in b)
      st.image =
        b.image === null
          ? null
          : { ...st.image, alt: b.image.alt?.trim() || null };
    st.version += 1;
    st.updatedAt = new Date().toISOString();
    return sendJson(
      res,
      200,
      { id: edit[1], version: st.version },
      { etag: `"${st.version}"` },
    );
  }
  const submit = /^\/v1\/stories\/([^/]+)\/submit$/.exec(path);
  if (submit && req.method === 'POST') {
    const needed = ['special_category_religious', 'publish', 'age_18plus'];
    if (!needed.every((t) => s.granted.has(t)) || !s.signup)
      return shareProblem(res, 403, 'Forbidden', 'consent_required');
    const st = s.stories.get(submit[1]);
    if (!st) return shareProblem(res, 404, 'Not found');
    const v = ifMatchOf(req);
    if (v === undefined)
      return shareProblem(
        res,
        428,
        'Precondition required',
        'if_match_required',
      );
    // O4: the optional body's sharing beyond heisreal.today, granted with the submission (both
    // or neither), on the social sharing version and privacy policy in force.
    const body = await readJson(req);
    const share = body?.shareBeyondSite;
    if (
      body === null ||
      (body !== undefined &&
        (typeof body !== 'object' ||
          Object.keys(body).some((k) => k !== 'shareBeyondSite'))) ||
      (share !== undefined &&
        (share === null ||
          typeof share !== 'object' ||
          Object.keys(share).some(
            (k) => k !== 'formVersion' && k !== 'privacyPolicyVersion',
          ) ||
          typeof share.formVersion !== 'string' ||
          typeof share.privacyPolicyVersion !== 'string'))
    )
      return shareProblem(res, 400, 'Bad request', 'validation_failed');
    return idempotent(s, req, res, body, () => {
      const p = (status, title, code, extra = {}) => ({
        status,
        body: { type: 'about:blank', title, status, code, ...extra },
        headers: { 'content-type': 'application/problem+json' },
      });
      if (v !== st.version)
        return p(412, 'Precondition failed', 'stale_version');
      if (share && share.formVersion !== 'v2')
        return p(409, 'Conflict', 'form_version_not_in_force');
      if (share && share.privacyPolicyVersion !== 'dev_policy')
        return p(409, 'Conflict', 'legal_document_not_in_force');
      if (!['draft', 'changes_requested'].includes(st.status))
        return p(409, 'Conflict', 'story_not_submittable');
      // The themes, at submit only (themes plan v3): every one still there (A7), then
      // themesMin–themesMax.
      const { storyTextMin, themesMin: min, themesMax: max } = s.settings;
      if (st.themeIds.some((id) => !themeRef(s, id)))
        return p(400, 'Bad request', 'themes_changed', {
          detail: 'Themes have changed, please choose again',
          errors: [
            { pointer: '/themeIds', message: 'a theme that doesn’t exist' },
          ],
        });
      if (st.themeIds.length < min || st.themeIds.length > max)
        return p(400, 'Bad request', 'theme_count', {
          detail:
            min === max
              ? `Choose ${max} ${max === 1 ? 'theme' : 'themes'}`
              : min === 0
                ? `Choose up to ${max} ${max === 1 ? 'theme' : 'themes'}`
                : `Choose ${min}–${max} themes`,
          errors: [
            { pointer: '/themeIds', message: `from ${min} to ${max} themes` },
          ],
        });
      // As api-user: a picture whose file never arrived can't be submitted.
      if (st.image?.path && !s.images.get(st.image.path)?.bytes)
        return p(400, 'Bad request', 'image_not_uploaded', {
          detail:
            'Your picture hasn’t finished uploading. Add it again, or remove it, then submit your story.',
        });
      if ((st.primaryFormat ?? 'written') !== 'written') {
        const video = st.videoId ? s.videos.get(st.videoId) : undefined;
        if (!video?.done)
          return p(409, 'Conflict', 'media_not_uploaded', {
            detail: `Your ${st.primaryFormat === 'audio' ? 'audio' : 'video'} hasn’t finished uploading yet. Upload it, then submit your story.`,
          });
      }
      const written = (st.primaryFormat ?? 'written') === 'written';
      // Every limit in force applies at submit (Joel, 2026-10-30: no grandfathering).
      const { storyTextMax } = s.settings;
      if (written && (st.body ?? '').length > storyTextMax)
        return p(400, 'Bad request', 'story_text_too_long', {
          detail: `Your story is longer than the current limit of ${storyTextMax} characters. Shorten it, then submit.`,
          limit: storyTextMax,
          errors: [
            { pointer: '/body', message: `at most ${storyTextMax} characters` },
          ],
        });
      if (written && trimmed(st.body) < storyTextMin)
        return p(400, 'Bad request', 'story_text_too_short', {
          errors: [
            {
              pointer: '/body',
              message: `at least ${storyTextMin} characters`,
            },
          ],
        });
      const next = limitsOf(s).submissions.nextAvailableAt;
      if (!st.submittedAt && next)
        return p(409, 'Conflict', 'weekly_submission_limit_reached', {
          detail:
            'You’ve submitted as many stories for review as you can for now. Your draft is saved, so you can submit it later.',
          availableAt: next,
        });
      st.status = 'pending';
      st.submittedAt ??= new Date().toISOString();
      st.version += 1;
      if (share) {
        st.shared = true;
        s.sharingChosen.add(submit[1]);
      }
      return {
        status: 200,
        body: { id: submit[1], version: st.version },
        headers: { etag: `"${st.version}"` },
      };
    });
  }
  const uploadUrl = /^\/v1\/stories\/([^/]+)\/upload-url$/.exec(path);
  if (uploadUrl && req.method === 'POST') {
    s.uploadRequests += 1;
    if (!s.granted.has('special_category_religious'))
      return shareProblem(res, 403, 'Forbidden', 'consent_required');
    const st = s.stories.get(uploadUrl[1]);
    if (!st) return shareProblem(res, 404, 'Not found');
    const v = ifMatchOf(req);
    if (v === undefined)
      return shareProblem(
        res,
        428,
        'Precondition required',
        'if_match_required',
      );
    const b = (await readJson(req)) ?? {};
    // As api-user: the key is looked up first, so a retry after a lost answer replays the same
    // video and version even once the story has moved on (D29; Codex #133 round 1).
    return idempotent(s, req, res, b, () => {
      const p = (status, title, code, extra = {}) => ({
        status,
        body: { type: 'about:blank', title, status, code, ...extra },
        headers: { 'content-type': 'application/problem+json' },
      });
      if (v !== st.version)
        return p(412, 'Precondition failed', 'stale_version');
      if (!['draft', 'changes_requested'].includes(st.status))
        return p(409, 'Conflict', 'story_locked');
      const limits = uploadLimitsOf(s);
      const errors = [];
      if (b.format === 'image') {
        // As api-user (uploads.ts, checkImage): WebP, 5 MiB, 200–4096 px, 1:3..3:1, and a
        // written story's description.
        const { width: w, height: h } = b;
        if (b.contentType !== 'image/webp')
          errors.push({ pointer: '/contentType', message: 'a WebP image' });
        if (!(b.fileSizeBytes > 0) || b.fileSizeBytes > 5_242_880)
          errors.push({ pointer: '/fileSizeBytes', message: 'at most 5 MiB' });
        if (
          ![w, h].every((x) => Number.isInteger(x) && x >= 200 && x <= 4096) ||
          w > h * 3 ||
          h > w * 3
        )
          errors.push({
            pointer: '/width',
            message: 'a size and shape we take',
          });
        const expected = b.expectedImage;
        if (expected !== null && typeof expected !== 'string')
          errors.push({
            pointer: '/expectedImage',
            message:
              'the path of the story’s picture as you were shown it, or null',
          });
        if (errors.length)
          return p(400, 'Bad request', 'validation_failed', { errors });
        // Whatever the version: another tab's picture is replaced only by the person's choice.
        if ((st.image?.path ?? null) !== expected)
          return p(409, 'Conflict', 'image_changed', {
            detail:
              'Your story’s picture was changed in another tab or window.',
          });
        // Per hour only: pictures never count towards the weekly limit (Joel, 2026-10-30).
        const hourly = uploadLimitsOf(s, 'image').nextAvailableAt;
        if (hourly)
          return p(409, 'Conflict', 'upload_limit_reached', {
            detail: 'You’ve started as many uploads as you can for now.',
            availableAt: hourly,
          });
        const path = `stories/${uploadUrl[1]}/${randomUUID().replace(/-/g, '')}.webp`;
        const url = `http://${req.headers.host}/__s3/${path}`;
        s.images.set(path, {
          story: uploadUrl[1],
          size: b.fileSizeBytes,
          bytes: null,
        });
        s.uploadTimes.push({ at: Date.now(), image: true });
        st.image = {
          path,
          url,
          width: w,
          height: h,
          alt: b.alt?.trim() || null,
        };
        st.version += 1;
        st.updatedAt = new Date().toISOString();
        const expires = Math.floor(Date.now() / 1000) + 600;
        return {
          status: 200,
          body: {
            id: uploadUrl[1],
            version: st.version,
            provider: 'bunny_s3',
            path,
            uploadUrl: `${url}?X-Amz-Expires=${expires}&X-Amz-Signature=${s3Signature(path, b.fileSizeBytes, expires)}`,
            method: 'PUT',
            headers: { 'Content-Type': 'image/webp', 'If-None-Match': '*' },
            expiresAt: new Date(expires * 1000).toISOString(),
          },
          headers: { etag: `"${st.version}"` },
        };
      }
      if (b.format !== st.primaryFormat)
        errors.push({
          pointer: '/format',
          message: `this is a ${st.primaryFormat} story`,
        });
      else if (!UPLOAD_TYPES[b.format].includes(b.contentType))
        errors.push({ pointer: '/contentType', message: 'not a type we take' });
      const max =
        b.format === 'audio' ? limits.audioMaxBytes : limits.videoMaxBytes;
      if (!(b.fileSizeBytes > 0) || b.fileSizeBytes > max)
        errors.push({
          pointer: '/fileSizeBytes',
          message: `at most ${max} bytes`,
        });
      if (
        b.durationSeconds !== undefined &&
        b.durationSeconds > limits.maxDurationSeconds
      )
        errors.push({
          pointer: '/durationSeconds',
          message: `at most ${limits.maxDurationSeconds} seconds`,
        });
      if (errors.length)
        return p(400, 'Bad request', 'validation_failed', { errors });
      const sign = (videoId) => {
        const expires = Math.floor(Date.now() / 1000) + 3600;
        return {
          status: 200,
          body: {
            id: uploadUrl[1],
            version: st.version,
            provider: 'bunny_tus',
            uploadUrl: `http://${req.headers.host}/tusupload`,
            method: 'POST',
            headers: {
              AuthorizationSignature: tusSignature(expires, videoId),
              AuthorizationExpire: String(expires),
              VideoId: videoId,
              LibraryId: '42',
            },
            expiresAt: new Date(expires * 1000).toISOString(),
          },
          headers: { etag: `"${st.version}"` },
        };
      };
      if (b.resume === true) {
        const video = st.videoId && s.videos.get(st.videoId);
        if (!video || video.done)
          return p(409, 'Conflict', 'nothing_to_resume');
        return sign(st.videoId);
      }
      if (limits.nextAvailableAt)
        return p(409, 'Conflict', 'upload_limit_reached', {
          detail: 'You’ve started as many uploads as you can for now.',
          availableAt: limits.nextAvailableAt,
        });
      // One video per draft: the old one is deleted at once (api-user does it at Bunny).
      if (st.videoId) s.videos.get(st.videoId).deleted = true;
      const videoId = randomUUID();
      s.videos.set(videoId, {
        story: uploadUrl[1],
        length: null,
        received: 0,
        done: false,
        deleted: false,
      });
      s.uploadTimes.push({ at: Date.now(), image: false });
      st.videoId = videoId;
      st.version += 1;
      st.updatedAt = new Date().toISOString();
      return sign(videoId);
    });
  }
  return false;
}

/** The presigned PUT and signed GET standing in for Bunny Storage's (the images zone). */
async function handleS3(req, res, url) {
  const path = decodeURIComponent(url.pathname.slice('/__s3/'.length));
  const session = [...sessions.values()].find((x) => x.images.has(path));
  const image = session?.images.get(path);
  if (req.method === 'GET') {
    if (!image?.bytes) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'image/webp' });
    return res.end(image.bytes);
  }
  if (req.method !== 'PUT') return false;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const expires = Number(url.searchParams.get('X-Amz-Expires'));
  if (
    !image ||
    url.searchParams.get('X-Amz-Signature') !==
      s3Signature(path, Number(req.headers['content-length']), expires) ||
    expires * 1000 < Date.now() ||
    req.headers['content-type'] !== 'image/webp' ||
    req.headers['if-none-match'] !== '*' ||
    body.length !== image.size
  ) {
    res.writeHead(403);
    return res.end();
  }
  if (image.bytes) {
    res.writeHead(412);
    return res.end();
  }
  image.bytes = body;
  res.writeHead(200);
  return res.end();
}

/** The TUS server standing in for Bunny Stream's (tus 1.0.0, the parts tus-js-client uses). */
async function handleTus(req, res, path) {
  const tusHeaders = {
    'tus-resumable': '1.0.0',
    'cache-control': 'no-store',
  };
  if (path === '/tusupload' && req.method === 'POST') {
    const videoId = req.headers['videoid'];
    const expires = req.headers['authorizationexpire'];
    const session = [...sessions.values()].find((x) => x.videos.has(videoId));
    const video = session?.videos.get(videoId);
    if (
      !video ||
      video.deleted ||
      req.headers['authorizationsignature'] !==
        tusSignature(expires, videoId) ||
      Number(expires) * 1000 < Date.now()
    ) {
      res.writeHead(401, tusHeaders);
      return res.end();
    }
    const length = Number(req.headers['upload-length']);
    const id = randomUUID();
    tusUploads.set(id, { session, videoId, length, received: 0 });
    video.length = length;
    res.writeHead(201, {
      ...tusHeaders,
      location: `http://${req.headers.host}/tusupload/${id}`,
    });
    return res.end();
  }
  const one = /^\/tusupload\/([0-9a-f-]{36})$/.exec(path);
  const upload = one && tusUploads.get(one[1]);
  if (one && !upload) {
    res.writeHead(404, tusHeaders);
    return res.end();
  }
  if (one && req.method === 'HEAD') {
    res.writeHead(200, {
      ...tusHeaders,
      'upload-offset': String(upload.received),
      'upload-length': String(upload.length),
    });
    return res.end();
  }
  if (one && req.method === 'PATCH') {
    const s = upload.session;
    const offset = Number(req.headers['upload-offset']);
    const chunks = [];
    // The browser gave up (pause, cancel): the response closes before it's written.
    let closed = false;
    res.on('close', () => (closed = !res.writableEnded));
    for await (const c of req) chunks.push(c);
    if (s.tus.fail > 0) {
      s.tus.fail -= 1;
      res.writeHead(403, tusHeaders);
      return res.end();
    }
    // Held: nothing arrives until the test lets it through (or the browser gives up).
    while (s.tus.hold && !closed) await new Promise((r) => setTimeout(r, 50));
    if (closed) return;
    if (offset !== upload.received) {
      res.writeHead(409, tusHeaders);
      return res.end();
    }
    upload.received += Buffer.concat(chunks).length;
    const video = s.videos.get(upload.videoId);
    video.received = upload.received;
    if (upload.received >= upload.length) video.done = !video.deleted;
    res.writeHead(204, {
      ...tusHeaders,
      'upload-offset': String(upload.received),
    });
    return res.end();
  }
  return false;
}

/** The session's submit-flow state, made on first use. */
const shareSession = (id) => {
  if (!sessions.has(id)) sessions.set(id, newSession(id));
  return sessions.get(id);
};

createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && origins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader(
      'access-control-expose-headers',
      'ETag,Location,Upload-Offset,Upload-Length,Tus-Resumable',
    );
  }
  const url = new URL(req.url ?? '/', 'http://stub');
  const path = url.pathname;
  if (req.method === 'OPTIONS') {
    if (origin && origins.includes(origin)) {
      res.setHeader(
        'access-control-allow-methods',
        'GET,HEAD,POST,PUT,PATCH,DELETE',
      );
      res.setHeader(
        'access-control-allow-headers',
        'Authorization,Content-Type,If-Match,If-None-Match,Idempotency-Key,' +
          // Bunny Stream's TUS headers (the stand-in at /tusupload)
          'Tus-Resumable,Upload-Length,Upload-Metadata,Upload-Offset,AuthorizationSignature,AuthorizationExpire,VideoId,LibraryId',
      );
      res.setHeader('access-control-max-age', '600');
    }
    res.writeHead(204);
    return res.end();
  }
  if (path === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({ status: 'ok', service: 'api-user', db: 'up' }),
    );
  }
  // Test set-up only (not part of api-user): a session's starting state for the submit flow.
  const seed = /^\/__e2e\/sessions\/([a-z0-9-]{1,64})$/.exec(path);
  if (seed && req.method === 'POST') {
    const raw = await readJson(req);
    const body = raw === undefined ? {} : raw;
    sessions.set(seed[1], newSession(seed[1], body));
    // A fresh environment: no version of either legal document published yet.
    if (body.noLegalDocuments)
      adminState.set(
        seed[1],
        new Map([
          ['privacy', []],
          ['terms', []],
        ]),
      );
    res.writeHead(204);
    return res.end();
  }
  // Test set-up only: the session's settings change after the page loaded (an admin lowers a
  // limit), so the page's numbers are stale and the server's refusal answers instead.
  const settingsSet = /^\/__e2e\/sessions\/([a-z0-9-]{1,64})\/settings$/.exec(
    path,
  );
  if (settingsSet && req.method === 'POST') {
    Object.assign(
      shareSession(settingsSet[1]).settings,
      (await readJson(req)) ?? {},
    );
    res.writeHead(204);
    return res.end();
  }
  // Test set-up only: an admin deletes a theme while the person is choosing (A7). As the
  // database's theme_delete does, it comes off every story carrying it, which moves each one's
  // version on.
  const themeGone = /^\/__e2e\/sessions\/([a-z0-9-]{1,64})\/delete-theme$/.exec(
    path,
  );
  if (themeGone && req.method === 'POST') {
    const s = shareSession(themeGone[1]);
    const id = url.searchParams.get('id');
    s.deletedThemes.add(id);
    for (const st of s.stories.values()) {
      if (!st.themeIds?.includes(id)) continue;
      st.themeIds = st.themeIds.filter((t) => t !== id);
      st.version += 1;
    }
    res.writeHead(204);
    return res.end();
  }
  // Test set-up only: what the TUS server does with the next PATCHes ({ fail: n, hold: bool }).
  const tusSet = /^\/__e2e\/sessions\/([a-z0-9-]{1,64})\/tus$/.exec(path);
  if (tusSet && req.method === 'POST') {
    Object.assign(shareSession(tusSet[1]).tus, (await readJson(req)) ?? {});
    res.writeHead(204);
    return res.end();
  }
  // Test read-back only: the session's upload requests and what reached each video.
  const uploadsOf = /^\/__e2e\/sessions\/([a-z0-9-]{1,64})\/uploads$/.exec(
    path,
  );
  if (uploadsOf && req.method === 'GET') {
    const s = shareSession(uploadsOf[1]);
    return sendJson(res, 200, {
      requests: s.uploadRequests,
      videos: [...s.videos].map(([id, v]) => ({ id, ...v })),
      images: [...s.images].map(([path, i]) => ({
        path,
        story: i.story,
        size: i.size,
        bytes: i.bytes ? i.bytes.toString('base64') : null,
      })),
    });
  }
  if (path.startsWith('/__s3/')) {
    if ((await handleS3(req, res, url)) !== false) return;
  }
  if (path === '/tusupload' || path.startsWith('/tusupload/')) {
    if ((await handleTus(req, res, path)) !== false) return;
  }
  const token = sessionOf(req.headers.authorization);
  const signedIn = () => {
    if (token === null || erased.has(token)) {
      problem(res, 401, 'Unauthorized');
      return null;
    }
    if (!hearts.has(token)) hearts.set(token, new Map());
    return hearts.get(token);
  };

  // Erasure (M2 plan PR 11): the account is gone, and the session's token gets 401 from now on.
  if (path === '/v1/account' && req.method === 'DELETE') {
    if (!signedIn()) return;
    erased.add(token);
    if (shareSession(token).eraseThenFail) {
      return problem(res, 500, 'Internal Server Error');
    }
    res.writeHead(202, { 'cache-control': 'no-store' });
    return res.end();
  }
  if (path === '/v1/account' && req.method === 'GET') {
    if (!signedIn()) return;
    // The sign-up consent is accepted, except for the `unaccepted…` sessions; `admin…`
    // sessions are Admins.
    return cached(req, res, {
      ...ACCOUNT,
      role: token.startsWith('admin') ? 'Admin' : 'User',
      signupConsent: { accepted: shareSession(token).signup },
    });
  }
  const admin = /^\/v1\/admin\/legal-documents\/([^/]+)\/(versions)$/.exec(
    path,
  );
  if (admin && (req.method === 'GET' || req.method === 'POST')) {
    if (!signedIn()) return;
    if (!token.startsWith('admin'))
      return problem(res, 403, 'Forbidden', 'role_required');
    const [, document, what] = admin;
    if (document !== 'privacy' && document !== 'terms')
      return problem(res, 404, 'Not found', 'not_found');
    if (what === 'versions' && req.method === 'POST')
      return void publishDocument(req, res, token, document);
    if (what === 'versions')
      return cached(req, res, listOf(document, versionsFor(token, document)));
    return problem(res, 404, 'Not found', 'not_found');
  }
  if (
    path === '/v1/admin/submission-settings' &&
    (req.method === 'GET' || req.method === 'PUT')
  ) {
    if (!signedIn()) return;
    if (!token.startsWith('admin'))
      return problem(res, 403, 'Forbidden', 'role_required');
    return req.method === 'GET'
      ? sendSettings(req, res, token)
      : void saveSettings(req, res, token);
  }
  if (
    path === '/v1/admin/themes' &&
    (req.method === 'GET' || req.method === 'PUT')
  ) {
    if (!signedIn()) return;
    if (!token.startsWith('admin'))
      return problem(res, 403, 'Forbidden', 'role_required');
    return req.method === 'GET'
      ? sendAdminThemes(res, token)
      : void saveAdminThemes(req, res, token);
  }
  if (path === '/v1/account/consents' && req.method === 'POST') {
    if (!signedIn()) return;
    const s = shareSession(token);
    return void grant(
      req,
      res,
      (form, statement, storyId) => {
        if (storyId !== undefined) {
          s.stories.get(storyId).shared = true;
          s.sharingChosen.add(storyId);
          return;
        }
        s.granted.add(statement);
        if (
          form === 'signup' &&
          s.granted.has('age_18plus') &&
          s.granted.has('account_data')
        )
          s.signup = true;
      },
      (storyId) => s.stories.has(storyId),
    );
  }
  const withdrawConsent = /^\/v1\/account\/consents\/([^/]+)\/withdraw$/.exec(
    path,
  );
  if (withdrawConsent && req.method === 'POST') {
    if (!signedIn()) return;
    const s = shareSession(token);
    const type = withdrawConsent[1];
    const raw = await readJson(req);
    const body = raw === undefined ? {} : raw;
    const sharing = type === 'share_socials';
    if (
      (!CONSENT_TYPES.includes(type) && !sharing) ||
      body === null ||
      typeof body !== 'object' ||
      Object.keys(body).some((k) => k !== 'storyId') ||
      (sharing
        ? typeof body.storyId !== 'string' || !ID.test(body.storyId)
        : body.storyId !== undefined)
    )
      return problem(res, 400, 'Bad request', 'validation_failed');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 16 || key.length > 128)
      return problem(res, 400, 'Bad request', 'idempotency_key_required');
    const earlier = replies.get(key);
    if (earlier) return send(res, 202, earlier.answer);
    if (sharing) {
      // O4: one story's sharing; another story is untouched.
      const st = s.stories.get(body.storyId);
      if (!st) return problem(res, 404, 'Not found', 'story_not_found');
      if (!s.sharingChosen.has(body.storyId) && !st.shared)
        return problem(res, 409, 'Conflict', 'consent_not_granted');
      st.shared = false;
      events += 1;
      const answer = { id: `stubconsent${events}`, version: null };
      replies.set(key, { text: '', answer });
      return send(res, 202, answer);
    }
    // Withdrawing again re-affirms it; never granted is 409 (api-user.yaml).
    if (!s.granted.has(type) && !s.withdrawn?.has(type))
      return problem(res, 409, 'Conflict', 'consent_not_granted');
    s.granted.delete(type);
    (s.withdrawn ??= new Set()).add(type);
    events += 1;
    const answer = { id: `stubconsent${events}`, version: null };
    replies.set(key, { text: '', answer });
    if (ERASING.includes(type)) erased.add(token);
    return send(res, 202, answer);
  }
  if (path === '/v1/account/favourites' && req.method === 'GET') {
    const mine = signedIn();
    if (!mine) return;
    return listFavourites(req, res, url, mine);
  }
  // Download my data (M2 plan PR 12). A session starting `export-fails` gets the 503 that
  // api-user answers when Clerk can't be read.
  if (path === '/v1/account/export' && req.method === 'GET') {
    const mine = signedIn();
    if (!mine) return;
    if (token.startsWith('export-fails'))
      return problem(res, 503, 'Service unavailable', 'export_unavailable');
    return sendJson(res, 200, myDataOf(shareSession(token), token, mine), {
      'cache-control': 'private, no-store',
      'content-disposition': `attachment; filename="he-is-real-my-data-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  }
  const one = /^\/v1\/account\/favourites\/([^/]+)$/.exec(path);
  if (one && (req.method === 'PUT' || req.method === 'DELETE')) {
    const mine = signedIn();
    if (!mine) return;
    const id = decodeURIComponent(one[1]);
    if (req.method === 'DELETE') {
      mine.delete(id);
      res.writeHead(204);
      return res.end();
    }
    if (token.startsWith('no-consent'))
      return problem(res, 403, 'Forbidden', 'consent_required');
    if (!ID.test(id) || !(await publicCards()).has(id))
      return problem(res, 404, 'Not found', 'story_not_found');
    if (!mine.has(id)) mine.set(id, ++clock);
    res.writeHead(204);
    return res.end();
  }
  if (token !== null) {
    const handled = await handleShare(req, res, path, url, shareSession(token));
    if (handled !== false) return;
  }
  return problem(res, 404, 'Not found');
}).listen(port, '127.0.0.1');
