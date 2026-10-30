'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAccountState } from '@/components/auth/account-bootstrap';
import { LegalBlocks } from '@/components/consent/legal-blocks';
import { Button } from '@/components/ui/button';
import { ApiUserProblem, apiUser, NotSignedIn } from '@/lib/api-user';
import {
  documentPdfHref,
  type LegalDocumentName,
  parseLegalText,
} from '@/lib/legal-text';
import { usePersonalSession } from '@/lib/personal-session';

const DOCUMENTS: {
  document: LegalDocumentName;
  name: string;
  about: string;
}[] = [
  {
    document: 'privacy',
    name: 'Privacy policy',
    about:
      'What we keep, why, and people’s rights. Every consent names the version in force.',
  },
  {
    document: 'terms',
    name: 'Terms of use',
    about:
      'The terms people agree to with the sign-up box “I agree to the terms of use”.',
  },
];

/** What "requires re-acceptance" does, per document (D93's rules, D122). */
const REACCEPTANCE: Record<LegalDocumentName, string> = {
  privacy:
    'Requires re-acceptance: everyone accepts the sign-up form again at their next sign-in, and accepts the story form again before starting or submitting a new story. Their stories stay on the site either way.',
  terms:
    'Requires re-acceptance: everyone ticks “I agree to the terms of use” again at their next sign-in.',
};

const MAX_PDF = 10 * 1024 * 1024;
const ADMIN_ROLES = new Set(['Admin', 'SuperAdmin']);

/** The contract's `AdminLegalDocumentVersionList`. */
interface VersionList {
  document: LegalDocumentName;
  current: { id: string; text: string } | null;
  data: {
    id: string;
    publishedAt: string;
    publishedBy: string | null;
    source: 'admin' | 'repo';
    changeNote: string | null;
    requiresReacceptance: boolean;
    pdf: { sha256: string; size: number } | null;
  }[];
}

/** The contract's `LegalDocumentPreview`. */
interface ServerPreview {
  pdfSha256: string;
  pdfSize: number;
  originalSha256: string;
  removed: string[];
  pages: number;
  pdfBase64: string;
}

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; list: VersionList };

interface Preview {
  file: File;
  /** An object URL of the cleaned copy: what would be published (D123). */
  url: string;
  server: ServerPreview;
  text: string;
  textSha256: string;
}

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const sha256 = async (data: BufferSource) =>
  hex(await crypto.subtle.digest('SHA-256', data));

const date = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(iso)) + ' UTC';

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const problemText = (err: unknown) => {
  if (err instanceof ApiUserProblem) {
    const field = err.problem.errors?.[0]?.message;
    return field ?? err.problem.detail ?? `api-admin answered ${err.status}.`;
  }
  if (err instanceof NotSignedIn) return 'You’re signed out. Sign in again.';
  return 'api-admin couldn’t be reached. Try again in a moment.';
};

const INPUT =
  'min-h-11 w-full rounded-lg border border-input bg-input-background px-3 py-2 text-base text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none';
/** A button whose words may wrap (200% text on a 320 px phone): full width there. */
const WRAPPING_BUTTON =
  'h-auto min-h-11 w-full px-5 py-2 whitespace-normal sm:w-auto';

/**
 * The legal documents for staff (D121, D123), Admin and above (api-admin checks it too). Choose
 * the privacy policy or the terms of use; its versions are listed newest first, read-only, each
 * with its PDF. To publish a new one (the first one too): choose the PDF and write (or paste) the
 * words the site shows, preview both (api-admin cleans the PDF and returns the cleaned copy,
 * which is what's published, shown by the browser itself, and what cleaning removed; the words
 * as the site renders them), then publish with a change note. What's published is exactly what
 * was previewed: the hashes go with it, and api-admin refuses anything else.
 */
export function AdminLegal({ apiAdminUrl }: { apiAdminUrl?: string }) {
  const session = usePersonalSession();
  const userId = session.status === 'signed-in' ? session.userId : null;
  const account = useAccountState(userId);
  const [document, setDocument] = useState<LegalDocumentName>('privacy');
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  /** The version just published, said until another document is chosen. */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const load = useRef(0);
  const id = useId();

  const api = useCallback(() => {
    if (session.status !== 'signed-in' || !apiAdminUrl) return null;
    return apiUser(apiAdminUrl, session.getToken);
  }, [session, apiAdminUrl]);

  const role = account.status === 'ready' ? account.account.role : undefined;
  const allowed = role !== undefined && ADMIN_ROLES.has(role);

  const refresh = useCallback(
    (which: LegalDocumentName) => {
      const client = api();
      if (!client) return;
      const mine = ++load.current;
      setLoaded({ status: 'loading' });
      client
        .get<VersionList>(`/v1/admin/legal-documents/${which}/versions`)
        .then(
          ({ data }) => {
            if (load.current !== mine) return;
            setLoaded(
              data
                ? { status: 'ready', list: data }
                : { status: 'failed', message: 'No answer.' },
            );
          },
          (err: unknown) => {
            if (load.current === mine)
              setLoaded({ status: 'failed', message: problemText(err) });
          },
        );
    },
    [api],
  );

  useEffect(() => {
    if (allowed) refresh(document);
  }, [allowed, document, refresh]);
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  if (
    session.status === 'unknown' ||
    (userId && account.status !== 'ready' && account.status !== 'failed')
  ) {
    return <p className="text-secondary-text">Loading…</p>;
  }
  if (session.status !== 'signed-in') {
    return (
      <p
        className="rounded-2xl border border-border bg-card p-6"
        data-admin-refused=""
      >
        Sign in with an admin account to use this page.
      </p>
    );
  }
  if (!apiAdminUrl) {
    return (
      <p className="rounded-2xl border border-border bg-card p-6">
        The admin service isn’t available on this site.
      </p>
    );
  }
  if (!allowed) {
    return (
      <p
        className="rounded-2xl border border-border bg-card p-6"
        data-admin-refused=""
      >
        This page is for admins.
      </p>
    );
  }

  const client = api();
  return (
    <div className="space-y-10">
      <fieldset>
        <legend className="mb-3 text-lg font-semibold text-foreground">
          Which document
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {DOCUMENTS.map((d) => (
            <label
              key={d.document}
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 has-[:checked]:border-primary has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50"
            >
              <input
                type="radio"
                name={`${id}-document`}
                value={d.document}
                checked={document === d.document}
                onChange={() => {
                  setDocument(d.document);
                  setNotice(null);
                }}
                className="peer sr-only"
              />
              <span
                aria-hidden="true"
                className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-input peer-checked:border-primary peer-checked:[&>span]:visible"
              >
                <span className="invisible size-2.5 rounded-full bg-primary" />
              </span>
              <span className="min-w-0">
                <span className="block font-medium text-foreground">
                  {d.name}
                </span>
                <span className="block text-sm text-secondary-text">
                  {d.about}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {notice && (
        <p
          ref={noticeRef}
          tabIndex={-1}
          role="status"
          className="rounded-xl border border-primary px-4 py-3"
          data-publish-status="done"
        >
          Published version {notice.replace(/^v/, '')}. It’s in force now.
        </p>
      )}
      {loaded.status === 'loading' && (
        <p className="text-secondary-text">Loading the versions…</p>
      )}
      {loaded.status === 'failed' && (
        <p
          role="alert"
          className="rounded-2xl border border-destructive bg-card p-6"
        >
          {loaded.message}
        </p>
      )}
      {loaded.status === 'ready' &&
        loaded.list.document === document &&
        client && (
          <>
            <PublishVersion
              key={`${document} ${loaded.list.current?.id ?? ''}`}
              document={document}
              list={loaded.list}
              preview={async (file) => {
                const body = new FormData();
                body.append('pdf', file, file.name);
                const res = await client.command<ServerPreview>(
                  `/v1/admin/legal-documents/${document}/previews`,
                  { method: 'POST', form: body },
                );
                if (!res.data) throw new Error('No answer');
                return res.data;
              }}
              publish={async (body) => {
                const res = await client.command<{ id: string }>(
                  `/v1/admin/legal-documents/${document}/versions`,
                  { method: 'POST', form: body },
                );
                setNotice(res.data?.id ?? '');
                refresh(document);
              }}
            />
            <Versions document={document} list={loaded.list} />
          </>
        )}
    </div>
  );
}

function Versions({
  document,
  list,
}: {
  document: LegalDocumentName;
  list: VersionList;
}) {
  return (
    <section aria-labelledby="versions-heading">
      <h2
        id="versions-heading"
        className="mb-4 text-2xl font-normal sm:text-[1.75rem]"
      >
        Versions
      </h2>
      {list.data.length === 0 ? (
        <p className="text-secondary-text">No version is published yet.</p>
      ) : (
        <ol className="space-y-3" data-versions={document}>
          {list.data.map((v) => (
            <li
              key={v.id}
              data-version={v.id}
              className="rounded-xl border border-border bg-card px-4 py-3 [overflow-wrap:anywhere]"
            >
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold text-foreground">
                  Version {v.id.replace(/^v/, '')}
                </span>
                {list.current?.id === v.id && (
                  <span
                    className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
                    data-current=""
                  >
                    In force
                  </span>
                )}
              </p>
              <p className="text-sm text-secondary-text">
                Published {date(v.publishedAt)}
                {v.source === 'admin'
                  ? ` by user ${v.publishedBy ?? 'unknown'}`
                  : ', from the repository'}
                {v.requiresReacceptance ? '. Requires re-acceptance.' : ''}
              </p>
              {v.changeNote && (
                <p className="mt-1 text-foreground">{v.changeNote}</p>
              )}
              {v.pdf ? (
                <a
                  href={documentPdfHref(document, v.id)}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex min-h-11 items-center font-medium text-link underline-offset-4 hover:underline"
                >
                  PDF ({size(v.pdf.size)}), opens in a new tab
                </a>
              ) : (
                <p className="text-sm text-secondary-text">No PDF.</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function PublishVersion({
  document,
  list,
  preview: askPreview,
  publish,
}: {
  document: LegalDocumentName;
  list: VersionList;
  preview: (file: File) => Promise<ServerPreview>;
  publish: (body: FormData) => Promise<void>;
}) {
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState(list.current?.text ?? '');
  const [note, setNote] = useState('');
  const [requires, setRequires] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [status, setStatus] = useState<
    { kind: 'idle' } | { kind: 'error'; message: string } | { kind: 'busy' }
  >({ kind: 'idle' });
  const alert = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (status.kind === 'error') alert.current?.focus();
  }, [status]);
  // Free the preview's object URL when it's replaced or the form goes.
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );

  async function makePreview(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setStatus({ kind: 'error', message: 'Choose the PDF.' });
      return;
    }
    if (file.size > MAX_PDF) {
      setStatus({ kind: 'error', message: 'The PDF is larger than 10 MB.' });
      return;
    }
    const words = text.replace(/\r\n?/g, '\n');
    if (words.trim() === '') {
      setStatus({ kind: 'error', message: 'Write the words the site shows.' });
      return;
    }
    setStatus({ kind: 'busy' });
    try {
      const server = await askPreview(file);
      const bytes = Uint8Array.from(atob(server.pdfBase64), (c) =>
        c.charCodeAt(0),
      );
      setPreview({
        file,
        url: URL.createObjectURL(
          new Blob([bytes], { type: 'application/pdf' }),
        ),
        server,
        text: words,
        textSha256: await sha256(new TextEncoder().encode(words)),
      });
      setStatus({ kind: 'idle' });
    } catch (err) {
      setStatus({ kind: 'error', message: problemText(err) });
    }
  }

  async function doPublish() {
    if (!preview) return;
    if (note.trim() === '') {
      setStatus({
        kind: 'error',
        message: 'Say what changed (the change note).',
      });
      return;
    }
    setStatus({ kind: 'busy' });
    const body = new FormData();
    body.append('text', preview.text);
    body.append('textSha256', preview.textSha256);
    body.append('pdfSha256', preview.server.pdfSha256);
    body.append('changeNote', note.trim());
    body.append('requiresReacceptance', requires ? 'true' : 'false');
    body.append('basedOn', list.current?.id ?? '');
    body.append('pdf', preview.file, preview.file.name);
    try {
      await publish(body);
    } catch (err) {
      setStatus({ kind: 'error', message: problemText(err) });
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-6">
      <h2
        id={`${id}-heading`}
        className="text-2xl font-normal sm:text-[1.75rem]"
      >
        {list.current ? 'Publish a new version' : 'Publish the first version'}
      </h2>
      <form onSubmit={makePreview} className="space-y-5" noValidate>
        <div>
          <label
            htmlFor={`${id}-pdf`}
            className="mb-1 block font-medium text-foreground"
          >
            The PDF (at most 10 MB)
          </label>
          <input
            id={`${id}-pdf`}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
            }}
            className="block min-h-11 w-full text-base file:mr-3 file:min-h-11 file:rounded-md file:border file:border-border file:bg-card file:px-4"
          />
        </div>
        <div>
          <label
            htmlFor={`${id}-text`}
            className="mb-1 block font-medium text-foreground"
          >
            The words the site shows (Markdown)
          </label>
          <p className="mb-2 text-sm text-secondary-text">
            Make sure they say what the PDF says.
          </p>
          <textarea
            id={`${id}-text`}
            value={text}
            rows={12}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
            className={`${INPUT} font-mono text-sm`}
          />
        </div>
        <Button
          type="submit"
          className={WRAPPING_BUTTON}
          disabled={status.kind === 'busy' && !preview}
        >
          Preview
        </Button>
      </form>

      {preview && (
        <div
          className="space-y-6 rounded-2xl border border-border bg-card p-4 sm:p-6"
          data-preview=""
        >
          <h3 className="text-xl font-semibold text-foreground">Preview</h3>
          <div>
            <p className="mb-2 font-medium text-foreground">
              The PDF, as it will be kept (cleaned)
            </p>
            {preview.server.removed.length > 0 ? (
              <p
                className="mb-2 text-sm text-secondary-text"
                data-preview-removed=""
              >
                Removed from the upload: {preview.server.removed.join('; ')}.
              </p>
            ) : (
              <p className="mb-2 text-sm text-secondary-text">
                Nothing needed removing.
              </p>
            )}
            <object
              data={preview.url}
              type="application/pdf"
              aria-label="The PDF to publish"
              className="h-[70vh] min-h-80 w-full rounded-lg border border-border"
            >
              <p className="p-4">
                This browser can’t show the PDF here.{' '}
                <a
                  href={preview.url}
                  target="_blank"
                  rel="noopener"
                  className="text-link underline"
                >
                  Open it in a new tab
                </a>
                .
              </p>
            </object>
            <a
              href={preview.url}
              target="_blank"
              rel="noopener"
              className="mt-2 inline-flex min-h-11 items-center font-medium text-link underline-offset-4 hover:underline"
            >
              Open the PDF in a new tab
            </a>
            <p className="text-sm break-all text-secondary-text">
              SHA-256{' '}
              <code data-preview-pdf-sha256="">{preview.server.pdfSha256}</code>
            </p>
          </div>
          <div>
            <p className="mb-2 font-medium text-foreground">
              The words, as the site shows them
            </p>
            <div
              className="rounded-xl border border-border px-4 py-3"
              data-preview-text=""
            >
              <LegalBlocks blocks={parseLegalText(preview.text)} />
            </div>
          </div>
          <div>
            <label
              htmlFor={`${id}-note`}
              className="mb-1 block font-medium text-foreground"
            >
              What changed (shown with the version)
            </label>
            <input
              id={`${id}-note`}
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              className={INPUT}
            />
          </div>
          <label className="flex min-h-11 cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={requires}
              onChange={(e) => setRequires(e.target.checked)}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border-2 border-input bg-input-background text-primary-foreground peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50 [&>svg]:invisible peer-checked:[&>svg]:visible"
            >
              <svg
                viewBox="0 0 24 24"
                className="size-4 fill-none stroke-current"
                strokeWidth="3"
              >
                <path d="M5 12l5 5 9-10" />
              </svg>
            </span>
            <span>{REACCEPTANCE[document]}</span>
          </label>
          <Button
            type="button"
            className={WRAPPING_BUTTON}
            disabled={status.kind === 'busy'}
            onClick={doPublish}
          >
            {status.kind === 'busy' ? 'Publishing…' : 'Publish this version'}
          </Button>
        </div>
      )}

      {status.kind === 'error' && (
        <p
          ref={alert}
          tabIndex={-1}
          role="alert"
          className="rounded-xl border border-destructive px-4 py-3"
          data-publish-status="error"
        >
          {status.message}
        </p>
      )}
    </section>
  );
}
