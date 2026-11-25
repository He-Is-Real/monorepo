'use client';

import {
  DndContext,
  type DragEndEvent,
  MouseSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AdminAccess, problemText } from '@/components/admin/admin-access';
import {
  Button,
  Card,
  Checkbox,
  chipVariants,
  cn,
  Dialog,
  Field,
  FieldLabel,
  Input,
  Notice,
  Heading,
  Select,
  Text,
  textLinkVariants,
  textVariants,
} from '@heisreal/web-ui';
import { type ApiUser, StaleVersion } from '@/lib/api-user';
import {
  type AdminThemes as Loaded,
  type Change,
  changesBetween,
  confirmsDelete,
  type EditTheme,
  fromApi,
  OTHER,
  type Picture,
  sorted,
  tidyName,
  toSave,
} from './themes-model';

/** 412's words (A2): never merged; the admin reloads and makes their changes again. */
const STALE = 'Someone else changed themes. Reload to see their changes';

/**
 * While a save (and the reload after it) is in flight, nothing on the page can change: the
 * reload starts the page again from what the server holds, so a change made meanwhile would be
 * lost without a word.
 */
const Locked = createContext(false);

/** How far (px) the mouse moves before a press on a pill becomes a drag. */
const DRAG_DISTANCE = 6;

/** A theme's pill: the browse chip's shape (CH-1 A), its name and its × inside. */
const PILL = cn(
  chipVariants({ padding: 'none' }),
  textVariants({ size: 'inherit', tone: 'normal' }),
);
/** A category's Rename and Delete category: small links on their own (TX-6 A). */
const SMALL_BUTTON = cn(
  'justify-center rounded-md px-2',
  textLinkVariants({ kind: 'standalone' }),
  textVariants({ size: 'small' }),
);
const SMALL_DANGER_BUTTON = cn(
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2 underline-offset-4 hover:underline',
  textVariants({ size: 'small', tone: 'danger', weight: 'bold' }),
);

/**
 * /admin/themes (themes plan v3): every category and its themes for Admin and above (api-admin
 * checks it too). Every change is held on the page until Save changes, which sends the whole
 * picture at the version loaded.
 */
export function AdminThemes({ apiAdminUrl }: { apiAdminUrl?: string }) {
  return (
    <AdminAccess apiAdminUrl={apiAdminUrl}>
      {(client) => <ThemesLoader client={client} />}
    </AdminAccess>
  );
}

function ThemesLoader({ client }: { client: ApiUser }) {
  const [loaded, setLoaded] = useState<
    | { status: 'loading' }
    | { status: 'failed'; message: ReactNode }
    | { status: 'ready'; data: Loaded; at: number }
  >({ status: 'loading' });
  const [saved, setSaved] = useState(false);
  const load = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++load.current;
    client.get<Loaded>('/v1/admin/themes').then(
      ({ data }) => {
        if (load.current !== mine) return;
        setLoaded(
          data
            ? { status: 'ready', data, at: mine }
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

  if (loaded.status === 'loading')
    return <Text tone="quiet">Loading the themes…</Text>;
  if (loaded.status === 'failed')
    return (
      <Notice kind="danger" as="p" role="alert">
        {loaded.message}
      </Notice>
    );
  return (
    <Editor
      // Every load starts the page again from what the server holds.
      key={loaded.at}
      loaded={loaded.data}
      saved={saved}
      reload={() => {
        setSaved(false);
        refresh();
      }}
      save={async (picture) => {
        await client.command('/v1/admin/themes', {
          method: 'PUT',
          body: toSave(picture),
          version: loaded.data.version,
        });
        setSaved(true);
        refresh();
      }}
    />
  );
}

type Dialog =
  | { kind: 'panel'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'confirm' }
  | null;

type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; message: ReactNode }
  | { kind: 'stale' };

let next = 0;
const newId = () => `new-${++next}`;

function Editor({
  loaded,
  saved,
  reload,
  save,
}: {
  loaded: Loaded;
  saved: boolean;
  reload: () => void;
  save: (picture: Picture) => Promise<void>;
}) {
  const start = useMemo(() => fromApi(loaded), [loaded]);
  const [picture, setPicture] = useState<Picture>(start);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const alert = useRef<HTMLDivElement>(null);
  const changes = useMemo(
    () => changesBetween(start, picture),
    [start, picture],
  );
  const count = changes.length;

  // A3: only the browser's own "Leave site?" (closing the tab, reloading); links inside the
  // site just leave.
  useEffect(() => {
    if (count === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [count]);
  useEffect(() => {
    if (status.kind === 'error' || status.kind === 'stale')
      alert.current?.focus();
  }, [status]);

  const view = sorted(picture);
  const theme = (id: string) => {
    for (const c of picture) {
      const t = c.themes.find((x) => x.id === id);
      if (t) return { theme: t, category: c };
    }
    return null;
  };

  const change = (next: Picture) => {
    setPicture(next);
    if (status.kind === 'error') setStatus({ kind: 'idle' });
  };
  /** Changes a theme: its name, whether it's highlighted, or its category. */
  const updateTheme = (
    id: string,
    patch: Partial<Pick<EditTheme, 'name' | 'highlighted' | 'deleted'>> & {
      category?: string;
    },
  ) => {
    const found = theme(id);
    if (!found) return;
    const { category = found.category.id, ...rest } = patch;
    const updated = { ...found.theme, ...rest };
    change(
      picture.map((c) => ({
        ...c,
        themes: [
          ...c.themes.filter((t) => t.id !== id),
          ...(c.id === category ? [updated] : []),
        ],
      })),
    );
  };
  const deleteTheme = (id: string) => {
    if (id.startsWith('new-'))
      change(
        picture.map((c) => ({
          ...c,
          themes: c.themes.filter((t) => t.id !== id),
        })),
      );
    else updateTheme(id, { deleted: true });
  };
  const addTheme = (category: string, name: string, highlighted: boolean) =>
    change(
      picture.map((c) =>
        c.id === category
          ? {
              ...c,
              themes: [
                ...c.themes,
                {
                  id: newId(),
                  name,
                  highlighted,
                  storyCount: 0,
                  deleted: false,
                },
              ],
            }
          : c,
      ),
    );
  /** Plan v3: a deleted category's themes move to Other, not highlighted. */
  const deleteCategory = (id: string) => {
    const gone = picture.find((c) => c.id === id);
    if (!gone || id === OTHER) return;
    change(
      picture
        .filter((c) => c.id !== id)
        .map((c) =>
          c.id === OTHER
            ? {
                ...c,
                themes: [
                  ...c.themes,
                  ...gone.themes.map((t) => ({ ...t, highlighted: false })),
                ],
              }
            : c,
        ),
    );
  };

  const sensors = useSensors(
    // A6: dragging is for a desktop mouse only; phones and keyboards use the panel.
    useSensor(MouseSensor, {
      activationConstraint: { distance: DRAG_DISTANCE },
    }),
  );
  const busy = status.kind === 'busy';
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || busy) return;
    const [category, section] = String(over.id).split('|');
    updateTheme(String(active.id), {
      category,
      highlighted: section === 'highlighted',
    });
  };

  async function doSave() {
    setDialog(null);
    setStatus({ kind: 'busy' });
    try {
      await save(picture);
    } catch (err) {
      setStatus(
        err instanceof StaleVersion
          ? { kind: 'stale' }
          : { kind: 'error', message: problemText(err) },
      );
    }
  }

  const open = dialog && 'id' in dialog ? theme(dialog.id) : null;

  return (
    <div>
      {saved && count === 0 && (
        <Notice
          kind="success"
          as="p"
          role="status"
          className="mb-6"
          data-save-status="done"
        >
          Saved. Everyone sees the new themes now.
        </Notice>
      )}
      <Locked.Provider value={busy}>
        {/* While saving, every control here is disabled (Locked above for dragging). */}
        <fieldset
          disabled={busy}
          aria-busy={busy}
          className="m-0 min-w-0 border-0 p-0"
        >
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <div className="space-y-8">
              {view.map((c) => (
                <CategorySection
                  key={c.id}
                  category={c}
                  editing={editing}
                  onEdit={setEditing}
                  onRename={(id, name) => updateTheme(id, { name })}
                  onOpen={(id) => setDialog({ kind: 'panel', id })}
                  onDelete={(id) => setDialog({ kind: 'delete', id })}
                  onUndo={(id) => updateTheme(id, { deleted: false })}
                  onAdd={(name, highlighted) =>
                    addTheme(c.id, name, highlighted)
                  }
                  onRenameCategory={(name) =>
                    change(
                      picture.map((x) => (x.id === c.id ? { ...x, name } : x)),
                    )
                  }
                  onDeleteCategory={() => deleteCategory(c.id)}
                />
              ))}
            </div>
          </DndContext>
          <div className="mt-8">
            <AddName
              label="Create category"
              field="New category’s name"
              onAdd={(name) =>
                change([...picture, { id: newId(), name, themes: [] }])
              }
            />
          </div>
        </fieldset>
      </Locked.Provider>

      {(status.kind === 'error' || status.kind === 'stale') && (
        <Notice
          kind="danger"
          ref={alert}
          tabIndex={-1}
          role="alert"
          className="mt-6 outline-none"
          data-save-status={status.kind}
        >
          <p>{status.kind === 'stale' ? STALE : status.message}</p>
          {status.kind === 'stale' && (
            <Button type="button" wrap className="mt-3" onClick={reload}>
              Reload
            </Button>
          )}
        </Notice>
      )}

      <SaveBar
        changes={changes}
        busy={busy}
        stale={status.kind === 'stale'}
        onDiscard={() => {
          setPicture(start);
          setEditing(null);
          setStatus({ kind: 'idle' });
        }}
        onSave={() => setDialog({ kind: 'confirm' })}
      />

      {dialog?.kind === 'panel' && open && (
        <ThemePanel
          theme={open.theme}
          category={open.category.id}
          categories={view}
          onDone={(patch) => {
            updateTheme(open.theme.id, patch);
            setDialog(null);
          }}
          onDelete={() => setDialog({ kind: 'delete', id: open.theme.id })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && open && (
        <DeleteTheme
          theme={open.theme}
          onDelete={() => {
            deleteTheme(open.theme.id);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'confirm' && (
        <ConfirmSave
          changes={changes}
          onSave={() => void doSave()}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function CategorySection({
  category,
  editing,
  onEdit,
  onRename,
  onOpen,
  onDelete,
  onUndo,
  onAdd,
  onRenameCategory,
  onDeleteCategory,
}: {
  category: Picture[number];
  editing: string | null;
  onEdit: (id: string | null) => void;
  onRename: (id: string, name: string) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onUndo: (id: string) => void;
  onAdd: (name: string, highlighted: boolean) => void;
  onRenameCategory: (name: string) => void;
  onDeleteCategory: () => void;
}) {
  const id = useId();
  const [renaming, setRenaming] = useState(false);
  const other = category.id === OTHER;
  const highlighted = category.themes.filter((t) => t.highlighted);
  const rest = category.themes.filter((t) => !t.highlighted);
  const pills = (themes: EditTheme[]) =>
    themes.map((t) => (
      <li key={t.id} className="max-w-full">
        <Pill
          theme={t}
          editing={editing === t.id}
          onEdit={() => onEdit(t.id)}
          onRename={(name) => {
            if (name && name !== t.name) onRename(t.id, name);
            onEdit(null);
          }}
          onOpen={() => onOpen(t.id)}
          onDelete={() => onDelete(t.id)}
          onUndo={() => onUndo(t.id)}
        />
      </li>
    ));
  return (
    <Card asChild className="p-4 sm:p-6">
      <section
        aria-labelledby={id}

        data-category={category.name}
      >
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          {renaming ? (
            <NameInput
              label={`Rename ${category.name}`}
              initial={category.name}
              onDone={(name) => {
                if (name && name !== category.name) onRenameCategory(name);
                setRenaming(false);
              }}
            />
          ) : (
            <Heading
              level={2}
              size="sub"
              id={id}
              className="[overflow-wrap:anywhere]"
            >
              {category.name}
            </Heading>
          )}
          {other ? (
            <Text size="small" tone="quiet">
              Fixed · themes land here when their category is deleted
            </Text>
          ) : (
            !renaming && (
              <span className="flex flex-wrap">
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  onClick={() => setRenaming(true)}
                  aria-label={`Rename ${category.name}`}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className={SMALL_DANGER_BUTTON}
                  onClick={onDeleteCategory}
                  aria-label={`Delete category ${category.name}`}
                >
                  Delete category
                </button>
              </span>
            )
          )}
        </div>
        <Zone
          id={`${category.id}|highlighted`}
          label={`★ Highlighted · ${highlighted.length || 'none'}`}
          empty="Nothing highlighted: these show first wherever people choose themes."
          addLabel={`Add a highlighted theme to ${category.name}`}
          onAdd={(name) => onAdd(name, true)}
        >
          {pills(highlighted)}
        </Zone>
        <Zone
          id={`${category.id}|rest`}
          label="Other themes"
          addLabel={`Add a theme to ${category.name}`}
          onAdd={(name) => onAdd(name, false)}
        >
          {pills(rest)}
        </Zone>
      </section>
    </Card>
  );
}

/** A section a pill can be dragged into: a category's Highlighted themes, or its others. */
function Zone({
  id,
  label,
  empty,
  addLabel,
  onAdd,
  children,
}: {
  id: string;
  label: string;
  empty?: string;
  addLabel: string;
  onAdd: (name: string) => void;
  /** The pills, each in its `li`. */
  children: ReactNode[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const labelId = useId();
  return (
    <div
      ref={setNodeRef}
      data-zone={id}
      className={`mt-2 rounded-xl border-2 p-2 ${isOver ? 'border-dashed border-brand bg-accent' : 'border-transparent'}`}
    >
      <Text as="h3" size="small" tone="quiet" id={labelId} className="mb-2">
        {label}
      </Text>
      {children.length === 0 && empty && (
        <Text size="small" tone="quiet" className="mb-2">
          {empty}
        </Text>
      )}
      <ul aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {children}
        <li>
          <AddName
            label="+"
            ariaLabel={addLabel}
            field="New theme’s name"
            onAdd={onAdd}
          />
        </li>
      </ul>
    </div>
  );
}

/** Whether this click came from a mouse on a desktop (else the panel opens). */
const clickedWithMouse = (e: React.MouseEvent) =>
  e.detail > 0 && window.matchMedia('(pointer: fine)').matches;

function Pill({
  theme,
  editing,
  onEdit,
  onRename,
  onOpen,
  onDelete,
  onUndo,
}: {
  theme: EditTheme;
  editing: boolean;
  onEdit: () => void;
  onRename: (name: string) => void;
  onOpen: () => void;
  onDelete: () => void;
  onUndo: () => void;
}) {
  const locked = useContext(Locked);
  const { setNodeRef, listeners, transform, isDragging } = useDraggable({
    id: theme.id,
    disabled: theme.deleted || editing || locked,
  });
  // Where the mouse went down: a press that ends somewhere else was a drag, not a click on the
  // name (else every drop would open the name for editing).
  const down = useRef<{ x: number; y: number } | null>(null);
  if (editing)
    return (
      <NameInput
        label={`Rename ${theme.name}`}
        initial={theme.name}
        onDone={onRename}
      />
    );
  return (
    <span
      ref={setNodeRef}
      // Mouse only (A6): no keyboard drag attributes; Enter opens the panel instead.
      {...listeners}
      data-theme={theme.name}
      data-deleted={theme.deleted ? '' : undefined}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
      className={`${PILL} ${isDragging ? 'relative z-10 shadow-lg' : ''} ${theme.deleted ? 'opacity-60' : ''}`}
    >
      <button
        type="button"
        className={`min-h-11 min-w-11 truncate rounded-l-full pl-4 pr-1 text-left ${theme.deleted ? `${textVariants({ size: 'inherit', tone: 'quiet' })} line-through` : ''}`}
        disabled={theme.deleted}
        aria-haspopup="dialog"
        onMouseDown={(e) => {
          down.current = { x: e.clientX, y: e.clientY };
        }}
        onClick={(e) => {
          const from = down.current;
          down.current = null;
          if (!clickedWithMouse(e)) return onOpen();
          if (
            from &&
            Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_DISTANCE
          )
            return;
          onEdit();
        }}
      >
        {theme.name}
        {theme.deleted && (
          <span className="sr-only"> (deleted when you save)</span>
        )}
      </button>
      {theme.deleted ? (
        <button
          type="button"
          className={cn(
            'inline-flex size-11 shrink-0 items-center justify-center rounded-r-full',
            textLinkVariants(),
            'no-underline',
          )}
          aria-label={`Undo deleting ${theme.name}`}
          onClick={onUndo}
        >
          ↺
        </button>
      ) : (
        <button
          type="button"
          className={`inline-flex size-11 shrink-0 items-center justify-center rounded-r-full ${textVariants({ size: 'inherit', tone: 'quiet' })}`}
          aria-label={`Delete ${theme.name}`}
          onClick={onDelete}
        >
          ×
        </button>
      )}
    </span>
  );
}

/** A name being typed: Enter or leaving keeps it (tidied), Escape cancels. */
function NameInput({
  label,
  initial,
  onDone,
}: {
  label: string;
  initial: string;
  onDone: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <Input
      size="standard"
      autoFocus
      aria-label={label}
      maxLength={40}
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/^\s+/u, ''))}
      onBlur={() => finish(tidyName(value))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(tidyName(value));
        }
        if (e.key === 'Escape') finish(initial);
      }}
      className="w-56 max-w-full rounded-full"
    />
  );
}

/** "+": a box for a new name, added on Enter. */
function AddName({
  label,
  ariaLabel,
  field,
  onAdd,
}: {
  label: string;
  ariaLabel?: string;
  field: string;
  onAdd: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <NameInput
        label={field}
        initial=""
        onDone={(name) => {
          if (name) onAdd(name);
          setOpen(false);
        }}
      />
    );
  return (
    <button
      type="button"
      className={chipVariants({ add: true })}
      aria-label={ariaLabel}
      onClick={() => setOpen(true)}
    >
      {label === '+' ? '+' : `+ ${label}`}
    </button>
  );
}

/**
 * The library's Dialog (MG-3 A: the Filters panel's look), open while it's on the page: focus
 * starts on `initialFocus` and stays inside, Escape or the × close it, focus goes back after. A
 * click outside does nothing, so unsaved edits in it aren't lost.
 */
function Modal({
  title,
  onClose,
  initialFocus,
  children,
}: {
  title: string;
  onClose: () => void;
  initialFocus: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      initialFocus={initialFocus}
      className="sm:w-[min(100%-4rem,28rem)]"
    >
      <div className="space-y-4">{children}</div>
    </Dialog>
  );
}

/** Tap a pill (or Enter on it): the panel (themes plan v3; dragging is never the only way). */
function ThemePanel({
  theme,
  category,
  categories,
  onDone,
  onDelete,
  onClose,
}: {
  theme: EditTheme;
  category: string;
  categories: Picture;
  onDone: (patch: {
    name: string;
    category: string;
    highlighted: boolean;
  }) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(theme.name);
  const [where, setWhere] = useState(category);
  const [highlighted, setHighlighted] = useState(theme.highlighted);
  const first = useRef<HTMLInputElement>(null);
  return (
    <Modal title={theme.name} onClose={onClose} initialFocus={first}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const tidy = tidyName(name);
          onDone({ name: tidy || theme.name, category: where, highlighted });
        }}
      >
        <Field id={`${id}-name`}>
          <div>
            <FieldLabel>Name</FieldLabel>
            <Input
              ref={first}
              size="standard"
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </Field>
        <Field id={`${id}-category`}>
          <div>
            <FieldLabel>Category</FieldLabel>
            <Select
              wrapperClassName="w-full"
              value={where}
              options={categories.map((c) => ({ value: c.id, label: c.name }))}
              onValueChange={setWhere}
            />
          </div>
        </Field>
        {/* A choice kept until Done, so a check box, not a switch (SW-1 B, CB-1 A). */}
        <Checkbox
          boxAfter
          checked={highlighted}
          onChange={(e) => setHighlighted(e.target.checked)}
          labelClassName={textVariants({ size: 'inherit', weight: 'bold' })}
        >
          ★ Highlighted
        </Checkbox>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" wrap>
            Done
          </Button>
          <Button type="button" variant="outline" wrap onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="danger" wrap onClick={onDelete}>
            Delete theme
          </Button>
        </div>
        <Text size="small" tone="quiet">
          Done keeps the change on this page until you save.
        </Text>
      </form>
    </Modal>
  );
}

/** Q2: deleting a theme needs "delete <name>" typed (checked here only, A10). */
function DeleteTheme({
  theme,
  onDelete,
  onClose,
}: {
  theme: EditTheme;
  onDelete: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState('');
  const ok = confirmsDelete(typed, theme.name);
  const stories = theme.storyCount;
  const first = useRef<HTMLInputElement>(null);
  return (
    <Modal
      title={`Delete “${theme.name}”?`}
      onClose={onClose}
      initialFocus={first}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onDelete();
        }}
      >
        <p>
          {stories > 0
            ? `It’s used by ${stories} ${stories === 1 ? 'story' : 'stories'} and will be removed from them when you save.`
            : 'No story uses it.'}{' '}
          To confirm, type <strong>delete {theme.name}</strong>.
        </p>
        <div>
          <label htmlFor={id} className="sr-only">
            Type delete {theme.name}
          </label>
          <Input
            ref={first}
            size="standard"
            id={id}
            autoComplete="off"
            value={typed}
            placeholder={`delete ${theme.name}`}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" variant="danger" wrap disabled={!ok}>
            Delete theme
          </Button>
          <Button type="button" variant="outline" wrap onClick={onClose}>
            Cancel
          </Button>
        </div>
        <Text size="small" tone="quiet">
          Nothing is sent yet: it’s one of the changes Save sends.
        </Text>
      </form>
    </Modal>
  );
}

const unsaved = (n: number) => `${n} unsaved change${n === 1 ? '' : 's'}`;

/** One Save button, always in view at the bottom, with how many changes are waiting. */
function SaveBar({
  changes,
  busy,
  stale,
  onDiscard,
  onSave,
}: {
  changes: Change[];
  busy: boolean;
  stale: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const n = changes.length;
  return (
    <div
      role="region"
      aria-label="Save changes"
      className="sticky bottom-0 z-20 mt-8 border-t border-border bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:rounded-t-2xl sm:border-x"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Text size="small" className="min-w-0 flex-1" data-unsaved={n}>
          <strong>{n === 0 ? 'No unsaved changes' : unsaved(n)}</strong>
          {n > 0 && (
            <Text
              as="span"
              size="inherit"
              tone="quiet"
              className="line-clamp-1 max-sm:hidden"
            >
              {changes.map((c) => c.text).join(' · ')}
            </Text>
          )}
        </Text>
        {n > 0 && (
          <Button
            type="button"
            variant="outline"

            disabled={busy}
            onClick={onDiscard}
          >
            Discard
          </Button>
        )}
        <Button
          type="button"

          disabled={n === 0 || busy || stale}
          onClick={onSave}
        >
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}

/** Save's summary: the changes with a side effect first, then the rest. */
function ConfirmSave({
  changes,
  onSave,
  onClose,
}: {
  changes: Change[];
  onSave: () => void;
  onClose: () => void;
}) {
  const effects = changes.filter((c) => c.sideEffect);
  const rest = changes.filter((c) => !c.sideEffect);
  const n = changes.length;
  const first = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      title={`Save ${n} change${n === 1 ? '' : 's'}?`}
      onClose={onClose}
      initialFocus={first}
    >
      {effects.length > 0 && (
        <div>
          <p className="mb-2">
            {effects.length === 1
              ? 'One of them affects more than this page:'
              : `${effects.length} of them affect more than this page:`}
          </p>
          <ul className="list-disc space-y-1 pl-5" data-side-effects="">
            {effects.map((c) => (
              <li key={c.text}>{c.text}</li>
            ))}
          </ul>
        </div>
      )}
      {rest.length > 0 && (
        <div>
          {effects.length > 0 && <p className="mb-2">Also:</p>}
          <ul className="list-disc space-y-1 pl-5">
            {rest.map((c) => (
              <li key={c.text}>{c.text}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <Button ref={first} type="button" wrap onClick={onSave}>
          Save changes
        </Button>
        <Button type="button" variant="outline" wrap onClick={onClose}>
          Go back
        </Button>
      </div>
    </Modal>
  );
}
