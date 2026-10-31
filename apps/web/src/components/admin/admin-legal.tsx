'use client';

import Link from 'next/link';
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  AdminAccess,
  problemText,
  WRAPPING_BUTTON,
} from '@/components/admin/admin-access';
import { LegalMarkdown } from '@/components/legal/legal-markdown';
import { Button } from '@/components/ui/button';
import { type ApiUser, ApiUserProblem } from '@/lib/api-user';
import {
  DOCUMENT_TITLES,
  documentVersionHref,
  type LegalDocumentName,
} from '@/lib/legal-text';

const DOCUMENTS: { document: LegalDocumentName; about: string }[] = [
  {
    document: 'privacy',
    about:
      'What we keep, why, and people’s rights. Every consent names the version in force.',
  },
  {
    document: 'terms',
    about:
      'The terms people agree to with the sign-up box “I agree to the terms of use”.',
  },
];

/** The text's limit, as api-admin's (characters). */
const MAX_TEXT = 200_000;

/** The contract's `AdminLegalDocumentVersionList`. */
interface VersionList {
  document: LegalDocumentName;
  current: { number: number; text: string } | null;
  data: {
    number: number;
    publishedAt: string;
    publishedBy: string | null;
    source: 'admin' | 'repo';
    devPlaceholder: boolean;
  }[];
}

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; list: VersionList };

const date = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(iso)) + ' UTC';

/** The marks the text box understands: what lib/markdown.ts renders. */
const CHEAT_SHEET: [string, string][] = [
  ['## Heading', 'A section heading (### for a smaller one)'],
  ['**bold**', 'Bold words'],
  ['`code`', 'A name or value, in code style'],
  ['- item', 'A bulleted list (1. for a numbered one)'],
  ['[words](https://…)', 'A link (https:, mailto: or a page on this site)'],
  ['> note', 'A highlighted note'],
  [
    '| A | B |\n| --- | --- |\n| 1 | 2 |',
    'A table: a header row, a line of dashes, then rows',
  ],
];

/**
 * The legal documents for staff (D121, D125), Admin and above (api-admin checks it too). Choose
 * the privacy policy or the terms of use, edit the version in force in a plain text box with a
 * live preview in the site's own style (the same renderer as /privacy and /terms), and publish
 * it, after a confirmation, as the next version, in force at once. If another admin published
 * meanwhile, api-admin refuses (409) and the page asks to reload. Earlier versions are listed,
 * each linking to its public page.
 */
export function AdminLegal({ apiAdminUrl }: { apiAdminUrl?: string }) {
  return (
    <AdminAccess apiAdminUrl={apiAdminUrl}>
      {(client) => <LegalDocuments client={client} />}
    </AdminAccess>
  );
}

function LegalDocuments({ client }: { client: ApiUser }) {
  const [document, setDocument] = useState<LegalDocumentName>('privacy');
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  /** The version just published, said until another document is chosen. */
  const [notice, setNotice] = useState<number | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const load = useRef(0);
  const id = useId();

  const refresh = useCallback(
    (which: LegalDocumentName) => {
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
    [client],
  );

  useEffect(() => {
    refresh(document);
  }, [document, refresh]);
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

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
                  {DOCUMENT_TITLES[d.document]}
                </span>
                <span className="block text-sm text-secondary-text">
                  {d.about}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {notice !== null && (
        <p
          ref={noticeRef}
          tabIndex={-1}
          role="status"
          className="rounded-xl border border-primary px-4 py-3"
          data-publish-status="done"
        >
          Published version {notice}. It’s in force now.
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
      {loaded.status === 'ready' && loaded.list.document === document && (
        <>
          <EditVersion
            key={`${document} ${loaded.list.current?.number ?? 0}`}
            document={document}
            list={loaded.list}
            reload={() => {
              setNotice(null);
              refresh(document);
            }}
            publish={async (text) => {
              const res = await client.command<{ number: number }>(
                `/v1/admin/legal-documents/${document}/versions`,
                {
                  method: 'POST',
                  body: {
                    text,
                    basedOn: loaded.list.current?.number ?? null,
                  },
                },
              );
              setNotice(res.data?.number ?? null);
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
              key={v.number}
              data-version={v.number}
              className="rounded-xl border border-border bg-card px-4 py-3 [overflow-wrap:anywhere]"
            >
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link
                  href={documentVersionHref(document, v.number)}
                  className="inline-flex min-h-11 items-center font-semibold text-foreground underline-offset-4 hover:underline"
                >
                  Version {v.number}
                </Link>
                {list.current?.number === v.number && (
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
                {v.devPlaceholder ? ' (development placeholder)' : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

type Status =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }
  /** Another admin published meanwhile (409): reload, then edit again. */
  | { kind: 'stale' };

function EditVersion({
  document,
  list,
  reload,
  publish,
}: {
  document: LegalDocumentName;
  list: VersionList;
  reload: () => void;
  publish: (text: string) => Promise<void>;
}) {
  const id = useId();
  const title = DOCUMENT_TITLES[document].toLowerCase();
  const start = list.current?.text ?? '';
  const [text, setText] = useState(start);
  const shown = useDeferredValue(text);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const alert = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLDivElement>(null);
  const next = (list.data[0]?.number ?? 0) + 1;
  const words = text.replace(/\r\n?/g, '\n');

  useEffect(() => {
    if (status.kind === 'error' || status.kind === 'stale')
      alert.current?.focus();
    if (status.kind === 'confirm') confirm.current?.focus();
  }, [status]);

  function askConfirm(event: React.FormEvent) {
    event.preventDefault();
    if (words.trim() === '') {
      setStatus({ kind: 'error', message: `Write the ${title}.` });
    } else if (words.length > MAX_TEXT) {
      setStatus({
        kind: 'error',
        message: `The text is longer than ${MAX_TEXT.toLocaleString('en-GB')} characters.`,
      });
    } else if (words === start) {
      setStatus({
        kind: 'error',
        message: 'Nothing has changed since the version in force.',
      });
    } else {
      setStatus({ kind: 'confirm' });
    }
  }

  async function doPublish() {
    setStatus({ kind: 'busy' });
    try {
      await publish(words);
    } catch (err) {
      setStatus(
        err instanceof ApiUserProblem && err.status === 409
          ? { kind: 'stale' }
          : { kind: 'error', message: problemText(err) },
      );
    }
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-6">
      <h2
        id={`${id}-heading`}
        className="text-2xl font-normal sm:text-[1.75rem]"
      >
        {list.current
          ? `Edit the ${title} (version ${list.current.number} is in force)`
          : `Write the first ${title}`}
      </h2>
      <form onSubmit={askConfirm} className="space-y-5" noValidate>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            <label
              htmlFor={`${id}-text`}
              className="mb-1 block font-medium text-foreground"
            >
              The text
            </label>
            <details className="mb-2 text-sm text-secondary-text">
              <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-foreground">
                How to format it
              </summary>
              <dl
                className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[auto_1fr]"
                data-cheat-sheet=""
              >
                {CHEAT_SHEET.map(([mark, meaning]) => (
                  <div key={mark} className="contents">
                    <dt>
                      <code className="font-mono whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
                        {mark}
                      </code>
                    </dt>
                    <dd className="max-sm:mb-2">{meaning}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2">Leave a blank line between paragraphs.</p>
            </details>
            <textarea
              id={`${id}-text`}
              value={text}
              rows={24}
              spellCheck
              onChange={(e) => {
                setText(e.target.value);
                if (status.kind !== 'busy') setStatus({ kind: 'idle' });
              }}
              className="min-h-11 w-full rounded-lg border border-input bg-input-background px-3 py-2 font-mono text-sm text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            />
          </div>
          <div className="min-w-0">
            <p
              className="mb-1 font-medium text-foreground"
              id={`${id}-preview`}
            >
              Preview, as the site shows it
            </p>
            <div
              role="region"
              aria-labelledby={`${id}-preview`}
              className="rounded-xl border border-border bg-background px-4 py-4 sm:px-6"
              data-preview=""
            >
              <LegalMarkdown text={shown} />
            </div>
          </div>
        </div>
        {status.kind !== 'confirm' && (
          <Button
            type="submit"
            className={WRAPPING_BUTTON}
            disabled={status.kind === 'busy' || status.kind === 'stale'}
          >
            {status.kind === 'busy'
              ? 'Publishing…'
              : `Publish as version ${next}`}
          </Button>
        )}
      </form>

      {status.kind === 'confirm' && (
        <div
          ref={confirm}
          tabIndex={-1}
          role="alertdialog"
          aria-labelledby={`${id}-confirm`}
          className="space-y-4 rounded-2xl border border-primary bg-card p-4 sm:p-6"
          data-confirm=""
        >
          <p id={`${id}-confirm`} className="text-foreground">
            Publish this text as version {next} of the {title}? It is in force
            the moment you publish, and can’t be changed or removed afterwards.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              type="button"
              className={WRAPPING_BUTTON}
              onClick={doPublish}
            >
              Yes, publish version {next}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={WRAPPING_BUTTON}
              onClick={() => setStatus({ kind: 'idle' })}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {status.kind === 'error' && (
        <div
          ref={alert}
          tabIndex={-1}
          role="alert"
          className="rounded-xl border border-destructive px-4 py-3"
          data-publish-status="error"
        >
          {status.message}
        </div>
      )}
      {status.kind === 'stale' && (
        <div
          ref={alert}
          tabIndex={-1}
          role="alert"
          className="space-y-3 rounded-xl border border-destructive px-4 py-3"
          data-publish-status="stale"
        >
          <p>
            Someone else published a new version of the {title} while you were
            editing, so yours wasn’t published. Reload to see theirs, then make
            your changes again. Copy your text first if you want to keep it.
          </p>
          <Button type="button" className={WRAPPING_BUTTON} onClick={reload}>
            Reload
          </Button>
        </div>
      )}
    </section>
  );
}
