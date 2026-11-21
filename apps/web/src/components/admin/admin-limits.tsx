'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { AdminAccess, problemText } from '@/components/admin/admin-access';
import {
  Button,
  Card,
  Confirm,
  Field,
  FieldError,
  FieldHint,
  FieldLabel,
  Input,
  Notice,
  Select,
} from '@heisreal/web-ui';
import { type ApiUser, StaleVersion } from '@/lib/api-user';

/** The contract's `SubmissionSettingsValues`: every limit, in bytes and seconds. */
type Field =
  | 'storyTextMin'
  | 'storyTextMax'
  | 'themesMin'
  | 'themesMax'
  | 'openDraftsMax'
  | 'submissionsPer7Days'
  | 'uploadsPer7Days'
  | 'uploadRequestsPerHour'
  | 'videoMaxBytes'
  | 'audioMaxBytes'
  | 'mediaMaxSeconds'
  | 'imageMaxBytes'
  | 'rejectedRetentionDays'
  | 'editingRetentionDays';
type Values = Record<Field, number>;

/** The contract's `AdminSubmissionSettings`. */
interface Settings {
  version: number;
  settings: Values;
  bounds: Record<Field, { min: number; max: number }>;
}

/** 1 MB as the page shows it: 1,048,576 bytes, so today's 4 GiB reads 4,096 MB. */
const MB = 1_048_576;
/** 1 KB likewise: 1,024 bytes, so a picture's 3 MiB reads 3,072 KB. */
const KB = 1024;

/** Each limit in plain words, with the unit shown and how many stored units make one. */
const GROUPS: {
  title: string;
  /** A short note about this group's limits (SL-1 C: next to the limits they're about). */
  note?: string;
  fields: { field: Field; label: string; unit: string; per?: number }[];
}[] = [
  {
    title: 'Written stories',
    fields: [
      {
        field: 'storyTextMin',
        label: 'Shortest story that can be sent',
        unit: 'characters',
      },
      { field: 'storyTextMax', label: 'Longest story', unit: 'characters' },
    ],
  },
  {
    title: 'Themes',
    fields: [
      {
        field: 'themesMin',
        label: 'Fewest themes a story needs',
        unit: 'themes',
      },
      { field: 'themesMax', label: 'Most themes on a story', unit: 'themes' },
    ],
  },
  {
    title: 'How often',
    note: 'Trusted submitters skip the draft, weekly and upload-count limits, and get the largest file sizes and lengths.',
    fields: [
      {
        field: 'openDraftsMax',
        label: 'Unfinished drafts one person can have',
        unit: 'drafts',
      },
      {
        field: 'submissionsPer7Days',
        label: 'Stories one person can send for review',
        unit: 'per 7 days',
      },
      {
        field: 'uploadsPer7Days',
        label: 'Video or audio files one person can upload',
        unit: 'per 7 days',
      },
      {
        field: 'uploadRequestsPerHour',
        label: 'Upload attempts one person can start',
        unit: 'per hour',
      },
    ],
  },
  {
    title: 'Video and audio',
    note: 'Trusted submitters get the largest file sizes and lengths.',
    fields: [
      {
        field: 'videoMaxBytes',
        label: 'Largest video file',
        unit: 'MB',
        per: MB,
      },
      {
        field: 'audioMaxBytes',
        label: 'Largest audio file',
        unit: 'MB',
        per: MB,
      },
      {
        field: 'mediaMaxSeconds',
        label: 'Longest video or audio',
        unit: 'minutes',
        per: 60,
      },
    ],
  },
  {
    // Joel, 2026-11-20: "admin modifiable limitations for image object size".
    title: 'Pictures',
    note: 'For every story’s picture or video thumbnail, trusted submitters included. The person’s device makes it a WebP at most 2,048 pixels across first: photos come to about 200–1,000 KB.',
    fields: [
      {
        field: 'imageMaxBytes',
        label: 'Largest picture file',
        unit: 'KB',
        per: KB,
      },
    ],
  },
  {
    // G3 B (Joel, 2026-11-11): the nightly clean-up's deletion times.
    title: 'Deleting old stories',
    note: 'How long we keep a story that was sent but won’t be published: the nightly clean-up then deletes it, files included.',
    fields: [
      {
        field: 'rejectedRetentionDays',
        label: 'Keep a story we didn’t accept for',
        unit: 'days after the decision',
      },
      {
        field: 'editingRetentionDays',
        label: 'Keep a sent-back or edited story nobody touches for',
        unit: 'days',
      },
    ],
  },
];
const ALL = GROUPS.flatMap((g) => g.fields);
/** Which group each limit is in. */
const GROUP_OF = Object.fromEntries(
  GROUPS.flatMap((g, i) => g.fields.map((f) => [f.field, i])),
) as Record<Field, number>;
const LABEL = Object.fromEntries(ALL.map((f) => [f.field, f])) as Record<
  Field,
  (typeof ALL)[number]
>;

const number = (n: number) => n.toLocaleString('en-GB');
/** A stored value in the page's unit (at most 2 decimals, for a value set outside the page). */
const shown = (field: Field, value: number) =>
  String(Math.round((value / (LABEL[field].per ?? 1)) * 100) / 100);
/** A field's bounds in the page's unit, whole numbers inside the stored bounds. */
const range = (s: Settings, field: Field) => {
  const per = LABEL[field].per ?? 1;
  const { min, max } = s.bounds[field];
  return { min: Math.ceil(min / per), max: Math.floor(max / per) };
};

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; settings: Settings };

/**
 * The submission limits for staff (W3, D94, D112, D113), Admin and above (api-admin checks it
 * too). Every limit is a plain question with its unit, pre-filled with the value in force;
 * Save lists what changes and asks to confirm, then saves the whole set at the version read. If
 * another admin saved meanwhile, api-admin refuses (412) and the page asks to reload.
 */
export function AdminLimits({ apiAdminUrl }: { apiAdminUrl?: string }) {
  return (
    <AdminAccess apiAdminUrl={apiAdminUrl}>
      {(client) => <Limits client={client} />}
    </AdminAccess>
  );
}

function Limits({ client }: { client: ApiUser }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [saved, setSaved] = useState(false);
  const load = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++load.current;
    setLoaded({ status: 'loading' });
    client.get<Settings>('/v1/admin/submission-settings').then(
      ({ data }) => {
        if (load.current !== mine) return;
        setLoaded(
          data
            ? { status: 'ready', settings: data }
            : { status: 'failed', message: 'No answer.' },
        );
      },
      (err: unknown) => {
        if (load.current === mine)
          setLoaded({ status: 'failed', message: problemText(err) });
      },
    );
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loaded.status === 'loading') {
    return <p className="text-secondary-text">Loading the limits…</p>;
  }
  if (loaded.status === 'failed') {
    return (
      <Notice kind="danger" as="p" role="alert">
        {loaded.message}
      </Notice>
    );
  }
  return (
    <LimitsForm
      key={loaded.settings.version}
      settings={loaded.settings}
      saved={saved}
      reload={() => {
        setSaved(false);
        refresh();
      }}
      save={async (values) => {
        await client.command('/v1/admin/submission-settings', {
          method: 'PUT',
          body: values,
          version: loaded.settings.version,
        });
        setSaved(true);
        refresh();
      }}
    />
  );
}

type Status =
  | { kind: 'idle' }
  | { kind: 'confirm'; values: Values; changes: Field[] }
  | { kind: 'busy' }
  /** `field`: the first limit to fix, focused instead of the message. */
  | { kind: 'error'; message: string; field?: Field }
  /** Another admin saved meanwhile (412): reload, then change them again. */
  | { kind: 'stale' };

/**
 * SL-1 C (Joel, 2026-11-17): one group at a time, picked from a side list (768 px and up) or a
 * "Group" drop-down (phones). Every limit stays in the one form, so values typed in a group
 * survive switching. A changed box is outlined in teal, and a save bar says what changed (in
 * every group) with Undo and Save as soon as anything differs from the saved values.
 */
function LimitsForm({
  settings,
  saved,
  reload,
  save,
}: {
  settings: Settings;
  saved: boolean;
  reload: () => void;
  save: (values: Values) => Promise<void>;
}) {
  const id = useId();
  const start = Object.fromEntries(
    ALL.map(({ field }) => [field, shown(field, settings.settings[field])]),
  ) as Record<Field, string>;
  const [text, setText] = useState(start);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [group, setGroup] = useState(0);
  const alert = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLParagraphElement>(null);
  /** The save bar's Save button: focus goes back to it after "Cancel" (CD-1 A). */
  const saveButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (status.kind === 'error' && status.field)
      document.getElementById(`${id}-${status.field}`)?.focus();
    else if (status.kind === 'error' || status.kind === 'stale')
      alert.current?.focus();
  }, [status, id]);
  useEffect(() => {
    if (saved) done.current?.focus();
  }, [saved]);

  /** The limits whose box differs from the saved value, in page order. */
  const edited = ALL.filter(({ field }) => text[field].trim() !== start[field]);
  const groupHasError = (i: number) =>
    GROUPS[i].fields.some(({ field }) => errors[field]);

  /** The form's values in bytes and seconds, or the fields that are wrong. */
  function check():
    { values: Values } | { errors: Partial<Record<Field, string>> } {
    const values = {} as Values;
    const errs: Partial<Record<Field, string>> = {};
    for (const { field, unit, per = 1 } of ALL) {
      const t = text[field].trim();
      const { min, max } = range(settings, field);
      const n = Number(t);
      if (t === start[field]) {
        values[field] = settings.settings[field]; // unchanged: exactly as stored
      } else if (t === '' || !Number.isInteger(n) || n < min || n > max) {
        errs[field] =
          `Enter a whole number from ${number(min)} to ${number(max)} (${unit}).`;
      } else {
        values[field] = n * per;
      }
    }
    if (
      !errs.storyTextMin &&
      !errs.storyTextMax &&
      values.storyTextMin > values.storyTextMax
    )
      errs.storyTextMin =
        'The shortest story can’t be longer than the longest.';
    if (
      !errs.themesMin &&
      !errs.themesMax &&
      values.themesMin > values.themesMax
    )
      errs.themesMin = 'The fewest themes can’t be more than the most.';
    return Object.keys(errs).length ? { errors: errs } : { values };
  }

  function askConfirm(event: React.FormEvent) {
    event.preventDefault();
    const result = check();
    if ('errors' in result) {
      setErrors(result.errors);
      // Never silent in a hidden group: show the first group with an error and focus the field.
      const first = ALL.find(({ field }) => result.errors[field])?.field;
      if (first !== undefined) setGroup(GROUP_OF[first]);
      setStatus({
        kind: 'error',
        message: 'Some limits need fixing: see the fields marked below.',
        field: first,
      });
      return;
    }
    setErrors({});
    const changes = ALL.map((f) => f.field).filter(
      (f) => result.values[f] !== settings.settings[f],
    );
    if (changes.length === 0) {
      setStatus({ kind: 'error', message: 'Nothing has changed.' });
      return;
    }
    setStatus({ kind: 'confirm', values: result.values, changes });
  }

  async function doSave(values: Values) {
    setStatus({ kind: 'busy' });
    try {
      await save(values);
    } catch (err) {
      setStatus(
        err instanceof StaleVersion
          ? { kind: 'stale' }
          : { kind: 'error', message: problemText(err) },
      );
    }
  }

  function undo() {
    setText(start);
    setErrors({});
    // A stale save still needs a reload first.
    if (status.kind !== 'stale') setStatus({ kind: 'idle' });
  }

  const describe = (field: Field, value: number) =>
    `${number(Number(shown(field, value)))} ${LABEL[field].unit}`;
  /** A box's value as the save bar shows it: grouped digits when it's a number, else as typed. */
  const typed = (t: string) => {
    const n = Number(t.trim());
    return t.trim() !== '' && Number.isFinite(n) ? number(n) : `“${t}”`;
  };
  const current = GROUPS[group];

  return (
    <section className="space-y-6">
      {saved && (
        <Notice
          kind="success"
          as="p"
          ref={done}
          tabIndex={-1}
          role="status"
          className="outline-none"
          data-save-status="done"
        >
          Saved. The new limits apply now.
        </Notice>
      )}
      <form onSubmit={askConfirm} className="space-y-6" noValidate>
        <div className="md:grid md:grid-cols-[12rem_minmax(0,1fr)] md:items-start md:gap-8">
          {/* 768 px and up: the groups down the side. */}
          <div
            role="group"
            aria-label="Limit groups"
            className="hidden md:block"
          >
            <ul className="space-y-1">
              {GROUPS.map((g, i) => (
                <li key={g.title}>
                  <button
                    type="button"
                    aria-current={i === group ? 'true' : undefined}
                    onClick={() => setGroup(i)}
                    data-group-tab={g.title}
                    className={`flex min-h-11 w-full flex-col justify-center rounded-r-lg border-l-[3px] px-3 py-2 text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${
                      i === group
                        ? 'border-primary bg-accent font-medium text-foreground'
                        : 'border-transparent text-secondary-text hover:bg-accent hover:text-foreground'
                    }`}
                  >
                    {g.title}
                    {groupHasError(i) && (
                      <span className="text-sm font-normal text-danger-text">
                        Needs fixing
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {/* Phones: a drop-down. */}
          <div className="mb-4 md:hidden">
            <label
              htmlFor={`${id}-group`}
              className="mb-1 block font-medium text-foreground"
            >
              Group
            </label>
            <Select
              id={`${id}-group`}
              value={String(group)}
              options={GROUPS.map((g, i) => ({
                value: String(i),
                label: `${g.title}${groupHasError(i) ? ' (needs fixing)' : ''}`,
              }))}
              onValueChange={(v) => setGroup(Number(v))}
              wrapperClassName="w-full"
              className="text-base"
            />
          </div>

          <Card className="@container min-w-0 p-4 sm:p-6">
            <fieldset key={current.title} className="min-w-0">
              <legend className="text-lg font-semibold text-foreground">
                {current.title}
              </legend>
              {current.note && (
                <p className="mt-1 text-sm text-secondary-text">
                  {current.note}
                </p>
              )}
              <div className="mt-2 divide-y divide-border">
                {current.fields.map(({ field, label, unit }) => {
                  const { min, max } = range(settings, field);
                  const error = errors[field];
                  const changed = text[field].trim() !== start[field];
                  return (
                    <Field key={field} id={`${id}-${field}`} hint error={error}>
                      <div className="min-w-0 py-4" data-limit={field}>
                        <div className="flex flex-col gap-2 @lg:grid @lg:grid-cols-[minmax(0,1fr)_8rem_minmax(0,11rem)] @lg:items-center @lg:gap-x-3">
                          <div className="min-w-0">
                            <FieldLabel className="mb-0">{label}</FieldLabel>
                            <FieldHint>
                              Allowed {number(min)}–{number(max)}
                            </FieldHint>
                          </div>
                          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 @lg:contents">
                            <Input
                              size="standard"
                              name={field}
                              type="text"
                              inputMode="numeric"
                              autoComplete="off"
                              value={text[field]}
                              data-changed={changed ? '' : undefined}
                              onChange={(e) => {
                                setText({ ...text, [field]: e.target.value });
                                if (
                                  status.kind !== 'busy' &&
                                  status.kind !== 'stale'
                                )
                                  setStatus({ kind: 'idle' });
                              }}
                              className={`w-32 max-w-full min-w-0 text-right tabular-nums @lg:w-full ${
                                changed
                                  ? 'outline-2 outline-offset-0 outline-primary outline-solid'
                                  : ''
                              }`}
                            />
                            <span className="min-w-0 text-foreground">
                              {unit}
                            </span>
                          </div>
                        </div>
                        <FieldError className="mt-1 @lg:text-right" />
                      </div>
                    </Field>
                  );
                })}
              </div>
            </fieldset>
          </Card>
        </div>

        {status.kind === 'error' && (
          <Notice
            kind="danger"
            ref={alert}
            tabIndex={-1}
            role="alert"
            className="outline-none"
            data-save-status="error"
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
            data-save-status="stale"
          >
            <p>
              Someone else changed the limits while you were editing, so yours
              weren’t saved. Reload to see theirs, then make your changes again.
            </p>
            <Button type="button" wrap className="mt-3" onClick={reload}>
              Reload
            </Button>
          </Notice>
        )}

        {status.kind === 'confirm' && (
          <Confirm
            data-confirm=""
            question="Save these changes?"
            confirmLabel="Yes, save"
            onConfirm={() => doSave(status.values)}
            onCancel={() => setStatus({ kind: 'idle' })}
            returnFocus={saveButton}
          >
            <p>
              They apply to everyone from their next step, including stories
              already started.
            </p>
            <ul className="[overflow-wrap:anywhere]">
              {status.changes.map((f) => (
                <li key={f}>
                  {LABEL[f].label}: {describe(f, settings.settings[f])} →{' '}
                  {describe(f, status.values[f])}
                </li>
              ))}
            </ul>
          </Confirm>
        )}

        {edited.length > 0 && status.kind !== 'confirm' && (
          <SaveBar
            changes={edited.map(({ field, label, unit }) => ({
              field,
              text: `${label}: ${typed(start[field])} → ${typed(text[field])} ${unit}`,
            }))}
            busy={status.kind === 'busy'}
            stale={status.kind === 'stale'}
            onUndo={undo}
            saveRef={saveButton}
          />
        )}
      </form>
    </section>
  );
}

/** The tallest share of the screen the save bar may take with its list of changes shown. */
const BAR_SHARE = 0.38;

/**
 * The sticky save bar (SL-1 C): what changed, with Undo and Save. When the list of changes
 * wouldn't fit comfortably (small or short screens, large text) it folds behind a "Show
 * changes" button; shown, it scrolls within what's left of the bar's share of the screen,
 * and it folds again when focus goes back to the page. The page keeps the focused box above
 * the bar (Codex reviews of #237).
 */
function SaveBar({
  changes,
  busy,
  stale,
  onUndo,
  saveRef,
}: {
  changes: { field: Field; text: string }[];
  busy: boolean;
  stale: boolean;
  onUndo: () => void;
  saveRef: React.Ref<HTMLButtonElement>;
}) {
  const id = useId();
  const bar = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  /** Whether the bar with its list shown (6 rem at most) fits in its share of the screen. */
  const [fits, setFits] = useState(true);
  /** The height left for the list within the bar's share of the screen, in px. */
  const [room, setRoom] = useState(0);
  const [open, setOpen] = useState(false);
  const shown = fits || open;

  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(root).fontSize);
      const cs = getComputedStyle(el);
      const padding =
        parseFloat(cs.paddingTop) +
        parseFloat(cs.paddingBottom) +
        parseFloat(cs.borderTopWidth);
      // The controls, and the 8 px gap above the list. innerHeight follows the dynamic
      // viewport (a phone's browser bars, the on-screen keyboard).
      const controls = (top.current?.offsetHeight ?? 0) + padding + 8;
      const left = window.innerHeight * BAR_SHARE - controls;
      setRoom(Math.floor(left));
      setFits(6 * rem <= left);
      // Scrolling (focus, scrollIntoView) keeps clear of the bar.
      root.style.scrollPaddingBottom = `${el.offsetHeight}px`;
      uncover();
    };
    /** The box being typed in stays visible above the bar as it appears, grows or moves. */
    const uncover = () => {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        !el.contains(active) &&
        active.getBoundingClientRect().bottom > el.getBoundingClientRect().top
      )
        active.scrollIntoView({ block: 'nearest' });
    };
    /** Focus back on the page folds the list away, so the bar doesn't cover the box. */
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof Node && !el.contains(event.target))
        setOpen(false);
      uncover();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener('resize', measure);
    document.addEventListener('focusin', focusin);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      document.removeEventListener('focusin', focusin);
      root.style.scrollPaddingBottom = '';
    };
  }, []);

  // Sizes in px where they don't hold text (padding, gaps, the 44 px targets), so large
  // text grows only the words and the bar stays small.
  const control = 'h-auto min-h-[44px] px-[12px] py-[4px]';
  return (
    <div
      ref={bar}
      role="region"
      aria-label="Unsaved changes"
      data-save-bar=""
      className="sticky bottom-0 z-20 border-t border-border bg-background/95 px-[12px] pt-[8px] pb-[max(8px,env(safe-area-inset-bottom))] backdrop-blur sm:rounded-t-2xl sm:border-x sm:px-[16px]"
    >
      <div
        ref={top}
        className="flex flex-wrap items-center gap-x-[12px] gap-y-[4px]"
      >
        <p className="min-w-0 flex-1 basis-48 text-sm font-semibold text-foreground [overflow-wrap:anywhere]">
          {changes.length === 1
            ? '1 change not saved yet'
            : `${changes.length} changes not saved yet`}
          {!fits && (
            <>
              {' '}
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`${id}-changes`}
                onClick={() => setOpen((o) => !o)}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md px-[4px] font-normal text-primary underline underline-offset-4 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {open ? 'Hide' : 'Show'}
                <span className="sr-only">&nbsp;changes</span>
              </button>
            </>
          )}
        </p>
        <div className="ml-auto flex flex-none gap-[8px]">
          <Button
            type="button"
            variant="outline"
            className={control}
            disabled={busy}
            onClick={onUndo}
          >
            Undo
          </Button>
          <Button
            ref={saveRef}
            type="submit"
            className={control}
            disabled={busy || stale}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
      <ul
        id={`${id}-changes`}
        hidden={!shown}
        // Scrolls when long, so keyboard users can reach it too. At least a line, even on
        // the shortest screens with the largest text.
        tabIndex={0}
        aria-label="Changes not saved yet"
        style={{
          maxHeight: fits ? '6rem' : `max(${room}px, 1lh)`,
        }}
        className="mt-[8px] overflow-y-auto text-sm text-secondary-text [overflow-wrap:anywhere] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {changes.map(({ field, text }) => (
          <li key={field}>{text}</li>
        ))}
      </ul>
    </div>
  );
}
