'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AdminAccess,
  problemText,
  WRAPPING_BUTTON,
} from '@/components/admin/admin-access';
import { Button } from '@/components/ui/button';
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
  | 'mediaMaxSeconds';
type Values = Record<Field, number>;

/** The contract's `AdminSubmissionSettings`. */
interface Settings {
  version: number;
  settings: Values;
  bounds: Record<Field, { min: number; max: number }>;
}

/** 1 MB as the page shows it: 1,048,576 bytes, so today's 4 GiB reads 4,096 MB. */
const MB = 1_048_576;

/** Each limit in plain words, with the unit shown and how many stored units make one. */
const GROUPS: {
  title: string;
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
];
const ALL = GROUPS.flatMap((g) => g.fields);
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
      <p
        role="alert"
        className="rounded-2xl border border-destructive bg-card p-6"
      >
        {loaded.message}
      </p>
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
  | { kind: 'error'; message: string }
  /** Another admin saved meanwhile (412): reload, then change them again. */
  | { kind: 'stale' };

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
  const alert = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (status.kind === 'error' || status.kind === 'stale')
      alert.current?.focus();
    if (status.kind === 'confirm') confirm.current?.focus();
  }, [status]);
  useEffect(() => {
    if (saved) done.current?.focus();
  }, [saved]);

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
      setStatus({
        kind: 'error',
        message: 'Some limits need fixing: see the fields marked below.',
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

  const describe = (field: Field, value: number) =>
    `${number(Number(shown(field, value)))} ${LABEL[field].unit}`;

  return (
    <section className="space-y-6">
      {saved && (
        <p
          ref={done}
          tabIndex={-1}
          role="status"
          className="rounded-xl border border-primary px-4 py-3"
          data-save-status="done"
        >
          Saved. The new limits apply now.
        </p>
      )}
      <form onSubmit={askConfirm} className="space-y-8" noValidate>
        {GROUPS.map((group) => (
          <fieldset key={group.title} className="space-y-4">
            <legend className="mb-3 text-lg font-semibold text-foreground">
              {group.title}
            </legend>
            {group.fields.map(({ field, label, unit }) => {
              const { min, max } = range(settings, field);
              const error = errors[field];
              return (
                <div key={field} className="min-w-0" data-limit={field}>
                  <label
                    htmlFor={`${id}-${field}`}
                    className="mb-1 block font-medium text-foreground"
                  >
                    {label}
                  </label>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <input
                      id={`${id}-${field}`}
                      name={field}
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={text[field]}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={`${id}-${field}-hint${error ? ` ${id}-${field}-error` : ''}`}
                      onChange={(e) => {
                        setText({ ...text, [field]: e.target.value });
                        if (status.kind !== 'busy' && status.kind !== 'stale')
                          setStatus({ kind: 'idle' });
                      }}
                      className="min-h-11 w-36 rounded-lg border border-input bg-input-background px-3 py-2 text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-[invalid=true]:border-destructive"
                    />
                    <span className="text-foreground">{unit}</span>
                  </div>
                  <p
                    id={`${id}-${field}-hint`}
                    className="mt-1 text-sm text-secondary-text"
                  >
                    From {number(min)} to {number(max)}.
                  </p>
                  {error && (
                    <p
                      id={`${id}-${field}-error`}
                      className="mt-1 text-sm text-destructive"
                    >
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
          </fieldset>
        ))}
        {status.kind !== 'confirm' && (
          <Button
            type="submit"
            className={WRAPPING_BUTTON}
            disabled={status.kind === 'busy' || status.kind === 'stale'}
          >
            {status.kind === 'busy' ? 'Saving…' : 'Save'}
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
            Save these changes? They apply to everyone from their next step,
            including stories already started.
          </p>
          <ul className="list-disc space-y-1 pl-5 [overflow-wrap:anywhere]">
            {status.changes.map((f) => (
              <li key={f}>
                {LABEL[f].label}: {describe(f, settings.settings[f])} →{' '}
                {describe(f, status.values[f])}
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              type="button"
              className={WRAPPING_BUTTON}
              onClick={() => doSave(status.values)}
            >
              Yes, save
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
          data-save-status="error"
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
          data-save-status="stale"
        >
          <p>
            Someone else changed the limits while you were editing, so yours
            weren’t saved. Reload to see theirs, then make your changes again.
          </p>
          <Button type="button" className={WRAPPING_BUTTON} onClick={reload}>
            Reload
          </Button>
        </div>
      )}
    </section>
  );
}
