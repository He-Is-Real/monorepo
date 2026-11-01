'use client';

import Link from 'next/link';
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AdminAccess,
  problemText,
  WRAPPING_BUTTON,
} from '@/components/admin/admin-access';
import { LegalMarkdown } from '@/components/legal/legal-markdown';
import { Redline } from '@/components/legal/redline';
import { Button } from '@/components/ui/button';
import { type ApiUser, ApiUserProblem } from '@/lib/api-user';
import {
  DOCUMENT_NAMES,
  DOCUMENT_TITLES,
  documentVersionHref,
  isPublicDocument,
  LEGAL_DOCUMENTS,
  type LegalDocumentName,
  shortDate,
} from '@/lib/legal-text';
import { redline } from '@/lib/redline';

/** The text's limit, as api-admin's (characters). */
const MAX_TEXT = 100_000;

/** The contract's `AdminLegalDocumentVersionList`. */
interface VersionList {
  document: LegalDocumentName;
  latest: { version: number; releaseDate: string; content: string };
  data: { version: number; releaseDate: string }[];
}

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; list: VersionList };

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

/** Who sees the new version's redline, said under the button (8b P6). */
const WHO_SEES: Partial<Record<LegalDocumentName, (n: number) => string>> = {
  'testimony-consent': (n) =>
    `People whose consent is on version ${n} will see this redline and re-agree before their next story.`,
  'terms-of-use': (n) =>
    `People who agreed to version ${n} will see this redline and agree again before they next use their account.`,
};

/**
 * /admin/consent (plan 4e; 8b P6 mockup), Admin and above (api-admin checks it too): the four
 * texts people read and agree to. Pick one; see its current version and every earlier one; edit
 * the latest text as Markdown in a plain text box, with what changes (the same redline people see
 * when they re-agree) and a preview as people will see it; then save it, after a confirmation, as
 * the next version, in force at once. A saved version can never be changed: a mistake is fixed by
 * saving another. If another admin saved that number meanwhile, api-admin refuses (409
 * `document_changed`) and the page asks to reload.
 */
export function AdminConsent({ apiAdminUrl }: { apiAdminUrl?: string }) {
  return (
    <AdminAccess apiAdminUrl={apiAdminUrl}>
      {(client) => <ConsentTexts client={client} />}
    </AdminAccess>
  );
}

function ConsentTexts({ client }: { client: ApiUser }) {
  const [document, setDocument] = useState<LegalDocumentName>('terms-of-use');
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  /** The version just saved, said until another text is chosen. */
  const [notice, setNotice] = useState<number | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const tabs = useRef(new Map<LegalDocumentName, HTMLButtonElement>());
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
              data?.latest
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
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);

  const choose = (d: LegalDocumentName) => {
    setDocument(d);
    setNotice(null);
  };
  // Arrow keys move between the tabs (ARIA tabs pattern).
  const onKey = (event: React.KeyboardEvent) => {
    const i = LEGAL_DOCUMENTS.indexOf(document);
    const step =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next =
      LEGAL_DOCUMENTS[
        (i + step + LEGAL_DOCUMENTS.length) % LEGAL_DOCUMENTS.length
      ];
    choose(next);
    tabs.current.get(next)?.focus();
  };

  return (
    <div className="space-y-8">
      <div
        role="tablist"
        aria-label="Which text"
        onKeyDown={onKey}
        className="flex flex-wrap gap-2 border-b border-border pb-3"
      >
        {LEGAL_DOCUMENTS.map((d) => (
          <button
            key={d}
            ref={(el) => {
              if (el) tabs.current.set(d, el);
              else tabs.current.delete(d);
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${d}`}
            aria-selected={document === d}
            aria-controls={`${id}-panel`}
            tabIndex={document === d ? 0 : -1}
            onClick={() => choose(d)}
            className="inline-flex min-h-11 max-w-full items-center rounded-full border border-border px-4 py-2 text-left text-sm font-medium text-secondary-text hover:border-border-hover hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-selected:border-primary aria-selected:bg-primary aria-selected:text-primary-foreground"
          >
            {DOCUMENT_TITLES[d]}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${document}`}
        className="space-y-6"
      >
        {notice !== null && (
          <p
            ref={noticeRef}
            tabIndex={-1}
            role="status"
            className="rounded-xl border border-primary px-4 py-3"
            data-publish-status="done"
          >
            Saved version {notice}. It’s in force now.
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
          <EditVersion
            key={`${document} ${loaded.list.latest.version}`}
            document={document}
            list={loaded.list}
            reload={() => {
              setNotice(null);
              refresh(document);
            }}
            save={async (version, content) => {
              await client.command(
                `/v1/admin/legal-documents/${document}/versions`,
                { method: 'POST', body: { version, content } },
              );
              setNotice(version);
              refresh(document);
            }}
          />
        )}
      </div>
    </div>
  );
}

type Status =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }
  /** Another admin saved that version meanwhile (409): reload, then edit again. */
  | { kind: 'stale' };

function EditVersion({
  document,
  list,
  reload,
  save,
}: {
  document: LegalDocumentName;
  list: VersionList;
  reload: () => void;
  save: (version: number, content: string) => Promise<void>;
}) {
  const id = useId();
  const name = DOCUMENT_NAMES[document];
  const current = list.latest;
  const next = current.version + 1;
  const [text, setText] = useState(current.content);
  const shown = useDeferredValue(text);
  const changes = useMemo(
    () => redline(current.content, shown.replace(/\r\n?/g, '\n')),
    [current.content, shown],
  );
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const alert = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLDivElement>(null);
  const content = text.replace(/\r\n?/g, '\n');
  const whoSees = WHO_SEES[document]?.(current.version);

  useEffect(() => {
    if (status.kind === 'error' || status.kind === 'stale')
      alert.current?.focus();
    if (status.kind === 'confirm') confirm.current?.focus();
  }, [status]);

  function askConfirm(event: React.FormEvent) {
    event.preventDefault();
    if (content.trim() === '') {
      setStatus({ kind: 'error', message: `Write the ${name}.` });
    } else if (content.length > MAX_TEXT) {
      setStatus({
        kind: 'error',
        message: `The text is longer than ${MAX_TEXT.toLocaleString('en-GB')} characters.`,
      });
    } else if (content === current.content) {
      setStatus({
        kind: 'error',
        message: `Nothing has changed since version ${current.version}.`,
      });
    } else {
      setStatus({ kind: 'confirm' });
    }
  }

  async function doSave() {
    setStatus({ kind: 'busy' });
    try {
      await save(next, content);
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
        {DOCUMENT_TITLES[document]}
      </h2>
      <div data-current-version={current.version}>
        <p className="text-secondary-text">
          Current: <b className="text-foreground">version {current.version}</b>,
          in force since{' '}
          <time dateTime={current.releaseDate}>
            {shortDate(current.releaseDate)}
          </time>
        </p>
        <details className="mt-1">
          <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-link hover:text-link-hover">
            See all versions
          </summary>
          <ol className="mt-2 space-y-1" data-versions={document}>
            {list.data.map((v) => (
              <li
                key={v.version}
                data-version={v.version}
                className="text-secondary-text"
              >
                {isPublicDocument(document) ? (
                  <Link
                    href={documentVersionHref(document, v.version)}
                    className="inline-flex min-h-11 items-center font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    Version {v.version}
                  </Link>
                ) : (
                  <span className="font-medium text-foreground">
                    Version {v.version}
                  </span>
                )}
                , in force since {shortDate(v.releaseDate)}
                {v.version === current.version ? ' (current)' : ''}
              </li>
            ))}
          </ol>
        </details>
      </div>

      <form onSubmit={askConfirm} className="space-y-6" noValidate>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            <label
              htmlFor={`${id}-text`}
              className="mb-1 block font-medium text-foreground"
            >
              New text (version {next}) · Markdown
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
              rows={20}
              spellCheck
              onChange={(e) => {
                setText(e.target.value);
                if (status.kind !== 'busy') setStatus({ kind: 'idle' });
              }}
              className="min-h-11 w-full rounded-lg border border-input bg-input-background px-3 py-2 font-mono text-sm text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            />
          </div>
          <div className="min-w-0 space-y-6">
            <div>
              <p
                id={`${id}-changes`}
                className="mb-1 font-medium text-foreground"
              >
                What changes (redline against version {current.version})
              </p>
              <Redline
                items={changes}
                label={`What changes against version ${current.version}`}
              />
            </div>
            <div>
              <p
                id={`${id}-preview`}
                className="mb-1 font-medium text-foreground"
              >
                Preview: as people will see it
              </p>
              <div
                role="region"
                aria-labelledby={`${id}-preview`}
                className="rounded-xl border border-border bg-background px-4 py-4 sm:px-6"
                data-preview=""
              >
                <LegalMarkdown text={shown} topLevel={3} />
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          {whoSees ? (
            <p className="text-sm text-secondary-text" data-who-sees="">
              {whoSees}
            </p>
          ) : (
            <span />
          )}
          {status.kind !== 'confirm' && (
            <Button
              type="submit"
              className={WRAPPING_BUTTON}
              disabled={status.kind === 'busy' || status.kind === 'stale'}
            >
              {status.kind === 'busy' ? 'Saving…' : `Save as version ${next}…`}
            </Button>
          )}
        </div>
      </form>

      {status.kind === 'confirm' && (
        <div
          ref={confirm}
          tabIndex={-1}
          role="alertdialog"
          aria-labelledby={`${id}-confirm`}
          aria-describedby={`${id}-confirm-more`}
          className="space-y-4 rounded-2xl border border-primary bg-card p-4 outline-none sm:p-6"
          data-confirm=""
        >
          <p className="text-foreground">
            <b id={`${id}-confirm`}>
              Save version {next} of {name}?
            </b>{' '}
            <span id={`${id}-confirm-more`}>
              It can’t be changed or deleted after saving. It takes effect as
              soon as it’s saved.
            </span>
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button type="button" className={WRAPPING_BUTTON} onClick={doSave}>
              Save
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
          className="rounded-xl border border-destructive px-4 py-3 outline-none"
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
          className="space-y-3 rounded-xl border border-destructive px-4 py-3 outline-none"
          data-publish-status="stale"
        >
          <p>
            Someone else saved version {next} of the {name} while you were
            editing, so yours wasn’t saved. Reload to see theirs, then make your
            changes again. Copy your text first if you want to keep it.
          </p>
          <Button type="button" className={WRAPPING_BUTTON} onClick={reload}>
            Reload
          </Button>
        </div>
      )}
    </section>
  );
}
