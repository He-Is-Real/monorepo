'use client';

import { useSearchParams } from 'next/navigation';
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AdminAccess, problemText } from '@/components/admin/admin-access';
import { LegalMarkdown } from '@/components/legal/legal-markdown';
import { Redline } from '@/components/legal/redline';
import {
  Button,
  Confirm,
  Disclosure,
  cn,
  FieldLabel,
  Heading,
  Notice,
  proseClasses,
  Tabs,
  Text,
  Textarea,
  textVariants,
} from '@heisreal/web-ui';
import { TextLink } from '@/components/page/text-link';
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

/** A text's current version, as its tab says it. */
type Current = { version: number; releaseDate: string };

/** The text in the page's address (`?text=`); anything else is the terms of use. */
const TEXT_PARAM = 'text';
const textFrom = (value: string | null): LegalDocumentName =>
  LEGAL_DOCUMENTS.find((d) => d === value) ?? 'terms-of-use';

/** "14 Nov", or "14 Nov 2025" outside this year (UK time), for the tabs' second line. */
const tabDate = (iso: string): string => {
  const year = (date: Date) =>
    new Intl.DateTimeFormat('en-GB', {
      year: 'numeric',
      timeZone: 'Europe/London',
    }).format(date);
  const date = new Date(iso);
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(year(date) === year(new Date()) ? {} : { year: 'numeric' }),
    timeZone: 'Europe/London',
  }).format(date);
};

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

/** From this width (tablets and up) the text box is as tall as its text (Joel, 2026-11-17). */
const FULL_HEIGHT = '(min-width: 768px)';

/**
 * Tablets and desktops: makes the text box as tall as its whole text, so it never scrolls inside
 * (the page does), at least its 20 rows. Phones keep the 20 rows and scroll inside. Measures
 * scrollHeight (not CSS field-sizing, which Safari lacks) on every change of the text, of the
 * box's width (resize, rotation) and of the screen band, keeping the page where it was.
 */
function useFullHeight(
  box: React.RefObject<HTMLTextAreaElement | null>,
  text: string,
) {
  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    if (!window.matchMedia(FULL_HEIGHT).matches) {
      el.style.height = '';
      return;
    }
    const { scrollX, scrollY } = window;
    // Measuring shrinks the box to its 20 rows for a moment; holding its column at its current
    // height keeps the page from shortening meanwhile, which would clamp the page's scroll.
    const column = el.parentElement;
    if (column) column.style.minHeight = `${column.offsetHeight}px`;
    el.style.height = 'auto'; // its 20 rows: the minimum
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${el.scrollHeight + border}px`;
    if (column) column.style.minHeight = '';
    // If the page moved anyway, put it back at once ('instant': the site's smooth scrolling
    // would otherwise animate it back).
    if (window.scrollX !== scrollX || window.scrollY !== scrollY) {
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
    }
  }, [box]);

  useLayoutEffect(fit, [fit, text]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const media = window.matchMedia(FULL_HEIGHT);
    media.addEventListener('change', fit);
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      // Only a new width rewraps the text; fit's own height change is ignored.
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    void document.fonts?.ready.then(fit);
    return () => {
      media.removeEventListener('change', fit);
      observer.disconnect();
    };
  }, [box, fit]);
}

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
  // CS-1 C4 (Joel, 2026-11-17): the chosen text is in the address, so a link opens it and Back
  // returns to the text before.
  const document = textFrom(useSearchParams().get(TEXT_PARAM));
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  /** Each text's current version and date, for its tab; absent while loading. */
  const [currents, setCurrents] = useState<
    Partial<Record<LegalDocumentName, Current>>
  >({});
  /** The version just saved, said until another text is chosen. */
  const [notice, setNotice] = useState<number | null>(null);
  const [shownDocument, setShownDocument] = useState(document);
  if (shownDocument !== document) {
    setShownDocument(document);
    setNotice(null);
  }
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const load = useRef(0);
  const id = useId();

  // Versions only go up: a slow answer from before a save never puts the tab back to an older one.
  const setCurrent = useCallback(
    (which: LegalDocumentName, { version, releaseDate }: Current) =>
      setCurrents((all) =>
        (all[which]?.version ?? -1) > version
          ? all
          : { ...all, [which]: { version, releaseDate } },
      ),
    [],
  );

  // Every tab's current version, once (the chosen text's comes with its list too).
  useEffect(() => {
    for (const which of LEGAL_DOCUMENTS)
      client
        .get<VersionList>(`/v1/admin/legal-documents/${which}/versions`)
        .then(
          ({ data }) => {
            if (data?.latest) setCurrent(which, data.latest);
          },
          () => undefined, // the tab's second line stays empty
        );
  }, [client, setCurrent]);

  const refresh = useCallback(
    (which: LegalDocumentName) => {
      const mine = ++load.current;
      setLoaded({ status: 'loading' });
      client
        .get<VersionList>(`/v1/admin/legal-documents/${which}/versions`)
        .then(
          ({ data }) => {
            if (data?.latest) setCurrent(which, data.latest);
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
    [client, setCurrent],
  );

  useEffect(() => {
    refresh(document);
  }, [document, refresh]);
  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);

  const choose = (d: LegalDocumentName) => {
    if (d === document) return;
    const url = new URL(window.location.href);
    url.searchParams.set(TEXT_PARAM, d);
    // Next keeps useSearchParams in step with the browser's own history (a new entry each time).
    window.history.pushState(null, '', url);
  };
  return (
    <div className="space-y-8">
      <Tabs
        label="Which text"
        idBase={id}
        panelId={`${id}-panel`}
        value={document}
        onValueChange={choose}
        data-text-tabs=""
        items={LEGAL_DOCUMENTS.map((d) => ({
          value: d,
          label: DOCUMENT_TITLES[d],
          detail: (
            <span data-tab-version={currents[d]?.version}>
              {currents[d]
                ? `v${currents[d].version} · ${tabDate(currents[d].releaseDate)}`
                : '\u00a0'}
            </span>
          ),
        }))}
      />

      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${document}`}
        className="space-y-6"
      >
        {notice !== null && (
          <Notice
            kind="success"
            as="p"
            ref={noticeRef}
            tabIndex={-1}
            role="status"
            className="outline-none"
            data-publish-status="done"
          >
            Saved version {notice}. It’s in force now.
          </Notice>
        )}
        {loaded.status === 'loading' && (
          <Text tone="quiet">Loading the versions…</Text>
        )}
        {loaded.status === 'failed' && (
          <Notice kind="danger" as="p" role="alert">
            {loaded.message}
          </Notice>
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
              const { data } = await client.command<Current>(
                `/v1/admin/legal-documents/${document}/versions`,
                { method: 'POST', body: { version, content } },
              );
              if (data?.releaseDate) setCurrent(document, data);
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
  const box = useRef<HTMLTextAreaElement>(null);
  /** The Save button: focus goes back to it after "Cancel" (CD-1 A). */
  const saveButton = useRef<HTMLButtonElement>(null);
  useFullHeight(box, text);
  const content = text.replace(/\r\n?/g, '\n');
  const whoSees = WHO_SEES[document]?.(current.version);

  useEffect(() => {
    if (status.kind === 'error' || status.kind === 'stale')
      alert.current?.focus();
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
      <Heading level={2} id={`${id}-heading`}>
        {DOCUMENT_TITLES[document]}
      </Heading>
      <div data-current-version={current.version}>
        <Text tone="quiet">
          Current:{' '}
          <Text as="b" size="inherit" tone="normal" weight="bold">
            version {current.version}
          </Text>
          , in force since{' '}
          <time dateTime={current.releaseDate}>
            {shortDate(current.releaseDate)}
          </time>
        </Text>
        <Disclosure summary="See all versions" className="mt-1">
          <ol className="space-y-1" data-versions={document}>
            {list.data.map((v) => (
              <Text
                as="li"
                tone="quiet"
                key={v.version}
                data-version={v.version}
              >
                {isPublicDocument(document) ? (
                  <TextLink
                    kind="standalone"
                    href={documentVersionHref(document, v.version)}
                  >
                    Version {v.version}
                  </TextLink>
                ) : (
                  <Text as="span" size="inherit" tone="normal" weight="bold">
                    Version {v.version}
                  </Text>
                )}
                , in force since {shortDate(v.releaseDate)}
                {v.version === current.version ? ' (current)' : ''}
              </Text>
            ))}
          </ol>
        </Disclosure>
      </div>

      <form onSubmit={askConfirm} className="space-y-6" noValidate>
        <div className="grid gap-6 lg:grid-cols-2" data-editor-panes="">
          <div className="min-w-0">
            <FieldLabel htmlFor={`${id}-text`}>
              New text (version {next}) · Markdown
            </FieldLabel>
            <Disclosure
              summary="How to format it"
              className={cn(
                'mb-2',
                textVariants({ size: 'small', tone: 'quiet' }),
              )}
            >
              <dl
                className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[auto_1fr]"
                data-cheat-sheet=""
              >
                {CHEAT_SHEET.map(([mark, meaning]) => (
                  <div key={mark} className="contents">
                    <dt>
                      <code
                        className={cn(proseClasses.code, 'whitespace-pre-wrap')}
                      >
                        {mark}
                      </code>
                    </dt>
                    <dd className="max-sm:mb-2">{meaning}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2">Leave a blank line between paragraphs.</p>
            </Disclosure>
            <Textarea
              ref={box}
              id={`${id}-text`}
              value={text}
              rows={20}
              spellCheck
              onChange={(e) => {
                setText(e.target.value);
                if (status.kind !== 'busy') setStatus({ kind: 'idle' });
              }}
              // eslint-disable-next-line @heisreal/web-ui/no-text-look -- a Markdown editor: monospace so the marks line up; no piece has a code box yet
              className="font-mono text-sm"
            />
          </div>
          <div className="min-w-0 space-y-6">
            <div>
              <Text
                id={`${id}-changes`}
                tone="normal"
                weight="bold"
                className="mb-1"
              >
                What changes (redline against version {current.version})
              </Text>
              <Redline
                items={changes}
                label={`What changes against version ${current.version}`}
              />
            </div>
            <div>
              <Text
                id={`${id}-preview`}
                tone="normal"
                weight="bold"
                className="mb-1"
              >
                Preview: as people will see it
              </Text>
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
            <Text size="small" tone="quiet" data-who-sees="">
              {whoSees}
            </Text>
          ) : (
            <span />
          )}
          {status.kind !== 'confirm' && (
            <Button
              ref={saveButton}
              type="submit"
              wrap
              disabled={status.kind === 'busy' || status.kind === 'stale'}
            >
              {status.kind === 'busy' ? 'Saving…' : `Save as version ${next}…`}
            </Button>
          )}
        </div>
      </form>

      {status.kind === 'confirm' && (
        <Confirm
          data-confirm=""
          question={`Save version ${next} of ${name}?`}
          confirmLabel="Save"
          onConfirm={doSave}
          onCancel={() => setStatus({ kind: 'idle' })}
          returnFocus={saveButton}
        >
          <p>
            It can’t be changed or deleted after saving. It takes effect as soon
            as it’s saved.
          </p>
        </Confirm>
      )}

      {status.kind === 'error' && (
        <Notice
          kind="danger"
          ref={alert}
          tabIndex={-1}
          role="alert"
          className="outline-none"
          data-publish-status="error"
        >
          {status.message}
        </Notice>
      )}
      {status.kind === 'stale' && (
        <Notice
          kind="danger"
          ref={alert}
          tabIndex={-1}
          role="alert"
          className="outline-none"
          data-publish-status="stale"
        >
          <p>
            Someone else saved version {next} of the {name} while you were
            editing, so yours wasn’t saved. Reload to see theirs, then make your
            changes again. Copy your text first if you want to keep it.
          </p>
          <Button type="button" wrap className="mt-3" onClick={reload}>
            Reload
          </Button>
        </Notice>
      )}
    </section>
  );
}
