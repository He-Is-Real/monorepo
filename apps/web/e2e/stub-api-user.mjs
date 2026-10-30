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
// - The submit flow (M2 plan PR 4): consent state, limits, tags, the person's stories, and
//   create, edit and submit, per test session (see the section below).
// - Hearts (M2): `PUT`/`DELETE /v1/account/favourites/{storyId}` and `GET /v1/account/favourites`
//   (a page of cards, or `?storyId=…` for "which of these are hearted"). Cards come from the
//   stub api-public-read (STUB_PUBLIC_URL, `/__test/cards`), as the real one reads publicStory,
//   so a story hidden there leaves the list too.
// - api-admin's legal document routes (D121, D123), on the same port for the stub (web's
//   API_ADMIN_URL points here; the real ones are two services): `GET /v1/admin/legal-documents/
//   {privacy|terms}/versions`, `POST …/previews` (the "cleaned" copy: the stub keeps the bytes)
//   and `POST …/versions`, Admin and above only (sessions starting `admin` are Admins; everyone
//   else 403). Each document starts with dev's placeholder version; a publish is checked like the
//   real one (a PDF signature, the preview's hashes, the version in force it was based on) and
//   kept per session. A session seeded with `noLegalDocuments` starts with none (a fresh
//   environment's first publication).
//
// It accepts only the fixtures' token (account-control.tsx): `e2e.<payload>.fixture`, whose payload
// is the fixture person (`sub`) and an optional session a test picks (localStorage
// `e2e-session`); anything else is 401.
// Hearts are kept per token, so tests running in parallel never see each other's. A session
// starting `no-consent` has lost the sign-up consent since the page loaded (its account answer
// still says accepted): hearting answers 403 `consent_required` (D73).
import { createHash } from 'node:crypto';
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

// --- api-admin: the legal documents (D121, D123) --------------------------------------------
const LEGAL = resolve(import.meta.dirname, '../../../libs/legal');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** Dev's placeholder version of a document, as api-admin lists it. */
function devVersions(document) {
  const dir = document === 'privacy' ? 'dpa' : 'terms';
  const pdf = readFileSync(`${LEGAL}/${dir}/dev_placeholder.pdf`);
  const text = readFileSync(`${LEGAL}/${dir}/dev_placeholder.md`, 'utf8');
  return [
    {
      id: 'dev_placeholder',
      publishedAt: '2026-10-25T12:00:00.000Z',
      publishedBy: null,
      source: 'repo',
      changeNote: 'Dev-only placeholder (D75)',
      requiresReacceptance: document === 'privacy',
      textHash: sha256(text),
      pdf: { sha256: sha256(pdf), size: pdf.length },
      original: null,
      text,
    },
  ];
}
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
    ? { id: versions[0].id, text: versions[0].text }
    : null,
  data: versions.map(({ text: _t, ...v }) => v),
});
const invalid = (res, pointer, code) => {
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
      errors: [{ pointer, code, message: code }],
    }),
  );
};
/** The multipart fields of a request, or null. */
async function formOf(req) {
  const bytes = await readBytes(req);
  try {
    return await new Response(bytes, {
      headers: { 'content-type': req.headers['content-type'] ?? '' },
    }).formData();
  } catch {
    return null;
  }
}
/** The uploaded PDF's bytes, if it looks like one. */
async function pdfOf(fields) {
  const pdf = fields?.get('pdf');
  if (!(pdf instanceof Blob)) return null;
  const file = Buffer.from(await pdf.arrayBuffer());
  return file.subarray(0, 5).toString('latin1') === '%PDF-' ? file : null;
}

/** `POST …/previews`: the stub's "cleaned" copy is the upload itself. */
async function previewDocument(req, res, document) {
  const file = await pdfOf(await formOf(req));
  if (!file) return invalid(res, '/pdf', 'pdf_not_a_pdf');
  res.setHeader('cache-control', 'private, no-store');
  return send(res, 200, {
    document,
    pdfSha256: sha256(file),
    pdfSize: file.length,
    originalSha256: sha256(file),
    originalSize: file.length,
    removed: [],
    pages: 1,
    pdfBase64: file.toString('base64'),
  });
}

/** `POST …/versions` (PublishLegalDocument), checked like api-admin. */
async function publishDocument(req, res, session, document) {
  const fields = await formOf(req);
  const file = await pdfOf(fields);
  if (!file) return invalid(res, '/pdf', 'pdf_not_a_pdf');
  // Browsers send multipart text with CRLF line ends: as api-admin, hash it with LF.
  const text = String(fields.get('text') ?? '').replace(/\r\n?/g, '\n');
  const note = String(fields.get('changeNote') ?? '').trim();
  if (!text.trim()) return invalid(res, '/text', 'invalid_text');
  if (!note) return invalid(res, '/changeNote', 'invalid_change_note');
  if (fields.get('pdfSha256') !== sha256(file))
    return invalid(res, '/pdfSha256', 'preview_mismatch');
  if (fields.get('textSha256') !== sha256(text))
    return invalid(res, '/textSha256', 'preview_mismatch');
  const versions = versionsFor(session, document);
  if (String(fields.get('basedOn') ?? '') !== (versions[0]?.id ?? ''))
    return problem(res, 409, 'Conflict', 'document_changed');
  const id = `v${versions.length + 1}`;
  versions.unshift({
    id,
    publishedAt: new Date().toISOString(),
    publishedBy: 'e2efixture',
    source: 'admin',
    changeNote: note,
    requiresReacceptance: fields.get('requiresReacceptance') === 'true',
    textHash: sha256(text),
    pdf: { sha256: sha256(file), size: file.length },
    original: { sha256: sha256(file), size: file.length },
    text,
  });
  res.setHeader('location', `/v1/admin/legal-documents/${document}/versions`);
  return send(res, 201, { id, version: 1 });
}

const readBody = (req) =>
  new Promise((done) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => done(text));
  });

/** `POST /v1/account/consents` (GrantConsent), checked like the real service. */
async function grant(req, res, onGranted) {
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
    ...rest
  } = body ?? {};
  if (
    !(form in FORMS) ||
    typeof formVersion !== 'string' ||
    typeof statement !== 'string' ||
    !MECHANISMS.includes(mechanism) ||
    Object.keys(rest).length !== 0
  ) {
    return problem(res, 400, 'Bad request', 'validation_failed');
  }
  if (formVersion !== 'v2') {
    return problem(res, 409, 'Conflict', 'form_version_not_in_force');
  }
  // D122: the documents shown must be the ones in force (dev's placeholders).
  if (
    (privacyPolicyVersion !== undefined &&
      privacyPolicyVersion !== 'dev_placeholder') ||
    (termsVersion !== undefined && termsVersion !== 'dev_placeholder')
  ) {
    return problem(res, 409, 'Conflict', 'legal_document_not_in_force');
  }
  if (!FORMS[form].includes(statement)) {
    return problem(res, 409, 'Conflict', 'statement_not_on_form');
  }
  onGranted?.(form, statement);
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
/** The settings' defaults (W3, D112: submissionSettings); a test may seed others. */
const SETTINGS = {
  storyTextMin: 200,
  storyTextMax: 10000,
  tagsMin: 1,
  tagsMax: 5,
  openDraftsMax: 3,
  submissionsPer7Days: 1,
};
const TAGS = [
  { slug: 'healing', name: 'Healing', category: 'theme', version: 1 },
  { slug: 'faith', name: 'Faith', category: 'theme', version: 1 },
  { slug: 'addiction', name: 'Addiction', category: 'journey', version: 1 },
  { slug: 'doubt', name: 'Doubt', category: 'journey', version: 1 },
  { slug: 'loss', name: 'Loss', category: 'emotion', version: 1 },
  { slug: 'hope', name: 'Hope', category: 'emotion', version: 1 },
];
const CONSENT_TYPES = [
  'special_category_religious',
  'publish',
  'share_socials',
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
    stories: new Map(),
    keys: new Map(),
  };
  for (const story of seed.stories ?? []) {
    const now = new Date().toISOString();
    s.stories.set(story.id, {
      version: 1,
      status: 'draft',
      description: '',
      bylineName: null,
      tagSlugs: [],
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

function storyMine(id, st) {
  return {
    id,
    version: st.version,
    slug: `story-${id}`,
    status: st.status,
    title: st.title,
    description: st.description,
    body: st.body ?? null,
    bylineName: st.bylineName,
    primaryFormat: st.primaryFormat ?? 'written',
    media: [],
    image: null,
    tags: st.tagSlugs.map((slug) => TAGS.find((t) => t.slug === slug)),
    rejectionFeedback: null,
    submittedAt: st.submittedAt,
    approvedAt: null,
    createdAt: st.createdAt,
    updatedAt: st.updatedAt,
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
    tags: { min: s.settings.tagsMin, max: s.settings.tagsMax },
    openDrafts: { max: s.trusted ? null : s.settings.openDraftsMax, open },
    submissions: { per7Days, nextAvailableAt: next },
  };
}

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
  if (
    'tagSlugs' in b &&
    (!Array.isArray(b.tagSlugs) ||
      (b.tagSlugs.length > s.settings.tagsMax &&
        b.tagSlugs.length > (current?.tagSlugs.length ?? 0)) ||
      new Set(b.tagSlugs).size !== b.tagSlugs.length ||
      b.tagSlugs.some((t) => !TAGS.some((x) => x.slug === t)))
  )
    errors.push({ pointer: '/tagSlugs', message: 'too many or unknown tags' });
  return errors;
}

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
  if (path === '/v1/tags' && req.method === 'GET') {
    return collection(req, res, { data: TAGS });
  }
  if (path === '/v1/account/stories' && req.method === 'GET') {
    const status = url.searchParams.get('status');
    const data = [...s.stories]
      .filter(([, st]) => !status || st.status === status)
      .reverse()
      .map(([id, st]) => storyMine(id, st));
    return collection(req, res, { data, nextCursor: null });
  }
  const mine = /^\/v1\/account\/stories\/([^/]+)$/.exec(path);
  if (mine && req.method === 'GET') {
    const st = s.stories.get(mine[1]);
    if (!st) return shareProblem(res, 404, 'Not found');
    const etag = `"${st.version}"`;
    if (req.headers['if-none-match'] === etag)
      return sendJson(res, 304, undefined, { etag });
    return sendJson(res, 200, storyMine(mine[1], st), { etag });
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
        'tagSlugs',
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
        tagSlugs: b.tagSlugs ?? [],
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
      ['title', 'description', 'body', 'bylineName', 'tagSlugs'],
      s,
      st,
    );
    if (b && 'body' in b && !trimmed(b.body))
      errors.push({
        pointer: '/body',
        message: 'a written story needs its text',
      });
    if (errors.length)
      return shareProblem(res, 400, 'Bad request', 'validation_failed', {
        errors,
      });
    if ('title' in b) st.title = b.title.trim();
    if ('description' in b) st.description = b.description.trim();
    if ('body' in b) st.body = b.body;
    if ('bylineName' in b) st.bylineName = b.bylineName?.trim() || null;
    if ('tagSlugs' in b) st.tagSlugs = b.tagSlugs;
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
    return idempotent(s, req, res, undefined, () => {
      const p = (status, title, code, extra = {}) => ({
        status,
        body: { type: 'about:blank', title, status, code, ...extra },
        headers: { 'content-type': 'application/problem+json' },
      });
      if (v !== st.version)
        return p(412, 'Precondition failed', 'stale_version');
      if (!['draft', 'changes_requested'].includes(st.status))
        return p(409, 'Conflict', 'story_not_submittable');
      // The minimum at submit; the maximum only when themes change (as api-user does).
      const { tagsMin, storyTextMin } = s.settings;
      if (st.tagSlugs.length < tagsMin)
        return p(400, 'Bad request', 'tags_required', {
          detail: `Choose at least ${tagsMin} themes before submitting`,
          errors: [
            {
              pointer: '/tagSlugs',
              message: `choose at least ${tagsMin}`,
            },
          ],
        });
      // Every limit in force applies at submit (Joel, 2026-10-30: no grandfathering).
      const { storyTextMax, tagsMax } = s.settings;
      if ((st.body ?? '').length > storyTextMax)
        return p(400, 'Bad request', 'story_text_too_long', {
          detail: `Your story is longer than the current limit of ${storyTextMax} characters. Shorten it, then submit.`,
          limit: storyTextMax,
          errors: [
            { pointer: '/body', message: `at most ${storyTextMax} characters` },
          ],
        });
      if (trimmed(st.body) < storyTextMin)
        return p(400, 'Bad request', 'story_text_too_short', {
          errors: [
            {
              pointer: '/body',
              message: `at least ${storyTextMin} characters`,
            },
          ],
        });
      if (st.tagSlugs.length > tagsMax)
        return p(400, 'Bad request', 'too_many_tags', {
          detail: `Your story has more themes than the current limit of ${tagsMax}. Remove some, then submit.`,
          limit: tagsMax,
          errors: [
            { pointer: '/tagSlugs', message: `at most ${tagsMax} themes` },
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
      return {
        status: 200,
        body: { id: submit[1], version: st.version },
        headers: { etag: `"${st.version}"` },
      };
    });
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
    res.setHeader('access-control-expose-headers', 'ETag,Location');
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
        'Authorization,Content-Type,If-Match,If-None-Match,Idempotency-Key',
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
    const body = (await readJson(req)) ?? {};
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
  const token = sessionOf(req.headers.authorization);
  const signedIn = () => {
    if (token === null) {
      problem(res, 401, 'Unauthorized');
      return null;
    }
    if (!hearts.has(token)) hearts.set(token, new Map());
    return hearts.get(token);
  };

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
  const admin =
    /^\/v1\/admin\/legal-documents\/([^/]+)\/(versions|previews)$/.exec(path);
  if (admin && (req.method === 'GET' || req.method === 'POST')) {
    if (!signedIn()) return;
    if (!token.startsWith('admin'))
      return problem(res, 403, 'Forbidden', 'role_required');
    const [, document, what] = admin;
    if (document !== 'privacy' && document !== 'terms')
      return problem(res, 404, 'Not found', 'not_found');
    if (what === 'previews' && req.method === 'POST')
      return void previewDocument(req, res, document);
    if (what === 'versions' && req.method === 'POST')
      return void publishDocument(req, res, token, document);
    if (what === 'versions')
      return cached(req, res, listOf(document, versionsFor(token, document)));
    return problem(res, 404, 'Not found', 'not_found');
  }
  if (path === '/v1/account/consents' && req.method === 'POST') {
    if (!signedIn()) return;
    const s = shareSession(token);
    return void grant(req, res, (form, statement) => {
      s.granted.add(statement);
      if (
        form === 'signup' &&
        s.granted.has('age_18plus') &&
        s.granted.has('account_data')
      )
        s.signup = true;
    });
  }
  if (path === '/v1/account/favourites' && req.method === 'GET') {
    const mine = signedIn();
    if (!mine) return;
    return listFavourites(req, res, url, mine);
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
