'use client';

import Form from 'next/form';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  startTransition,
  useContext,
  useMemo,
  useOptimistic,
} from 'react';
import type { StoryFormat } from '@heisreal/story-filters';
import { Button, RadioGroup, SearchBox } from '@heisreal/web-ui';
import { FormatSelect } from '@/components/story-filters/format-select';
import {
  type BrowseFilters as Filters,
  browseHref,
  FAVOURITES_PARAM,
  favouritesOn,
} from '@/lib/browse-query';

/** A filter's name over its control in the filters column and panel (BS-1 C), as RadioGroup's. */
export const FILTER_HEADING =
  'mb-2 block text-xs font-semibold tracking-wide text-secondary-text uppercase';

/**
 * The one browse form's id. The search box is inside it; the sort, the format and the
 * no-JavaScript "Show stories" button belong to it from the filters column or panel (the HTML
 * `form` attribute). So the browser holds every live value in one place, and pressing Search or
 * changing a filter sends the typed search, the sort and the format together, as one form did
 * before the filters moved (Codex, #254).
 */
export const BROWSE_FORM = 'browse-form';

/**
 * The search box above the stories (BS-1 C; BS-2 A: a magnifier inside it, Enter searches too).
 * A plain GET form to /stories, so it works without JavaScript; with it, sending it is one of
 * BrowseChoices' navigations (the typed search with the filters as chosen). The themes and
 * "Favourites only" ride along as hidden fields for the form without JavaScript. Changing a
 * filter starts again from the first page.
 */
export function BrowseSearch({ filters }: { filters: Filters }) {
  const favourites = favouritesOn(useSearchParams());
  const { view, navigate } = useChoices();
  return (
    <Form
      // The box starts from the URL's search; when that changes without a new page (Back,
      // a theme link), the form starts again so it never disagrees with the list.
      key={JSON.stringify(filters)}
      id={BROWSE_FORM}
      action="/stories"
      role="search"
      aria-label="Stories"
      className="min-w-0 flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        navigate({});
      }}
    >
      {view.themes.map((id) => (
        <input key={id} type="hidden" name="theme" value={id} />
      ))}
      {favourites && <input type="hidden" name={FAVOURITES_PARAM} value="1" />}
      <label htmlFor="browse-q" className="sr-only">
        Search stories
      </label>
      <SearchBox
        id="browse-q"
        name="q"
        defaultValue={filters.q}
        maxLength={200}
        placeholder="Search stories…"
        className="pl-4"
      />
    </Form>
  );
}

/** The sort, format and themes as shown: the address's, or the choices on their way to it. */
type View = {
  sort: Filters['sort'];
  format: StoryFormat | null;
  themes: string[];
};

type Choices = {
  view: View;
  /** Goes to the address for these choices (with the typed search), showing them meanwhile. */
  navigate: (patch: Partial<View>) => void;
};
const ChoicesContext = createContext<Choices | null>(null);

function useChoices(): Choices {
  const choices = useContext(ChoicesContext);
  if (!choices) throw new Error('The browse filters need BrowseChoices');
  return choices;
}

/**
 * The browse filters' choices, above the filters so they survive the filters moving between the
 * column and the Filters panel (which remounts them).
 *
 * A choice (sort, format, a theme, the search sent) is a navigation to its address, in a React
 * transition, with the choice shown at once as optimistic state (`useOptimistic`). Two quick
 * choices both count: each builds on what's shown, not on the address it hasn't reached yet
 * (Codex, #254 and #259). The optimistic choices last only as long as their navigation: once it
 * ends, or another takes over (a link, Back, Forward), the page shows the address's filters
 * again (Codex, #259 round 3). Every navigation carries the typed search (the search box and
 * the filters are one form, Codex #254) and keeps "Favourites only".
 */
export function BrowseChoices({
  filters,
  children,
}: {
  filters: Filters;
  children: ReactNode;
}) {
  const router = useRouter();
  const favourites = favouritesOn(useSearchParams());
  const [view, setView] = useOptimistic<View, Partial<View>>(
    { sort: filters.sort, format: filters.format, themes: filters.themes },
    (shown, patch) => ({ ...shown, ...patch }),
  );
  const choices = useMemo<Choices>(
    () => ({
      view,
      navigate: (patch) => {
        const next = { ...view, ...patch };
        const box = document.getElementById(BROWSE_FORM);
        const typed =
          box instanceof HTMLFormElement ? new FormData(box).get('q') : null;
        const q = typeof typed === 'string' ? typed.trim() : filters.q;
        startTransition(() => {
          setView(patch);
          router.push(browseHref({ q, ...next }, { favourites }), {
            scroll: false,
          });
        });
      },
    }),
    [view, setView, router, favourites, filters.q],
  );
  return (
    <ChoicesContext.Provider value={choices}>
      {children}
    </ChoicesContext.Provider>
  );
}

/** The themes as shown, and choosing them (ThemeFilter): BrowseChoices'. */
export function useThemeChoices() {
  const { view, navigate } = useChoices();
  return {
    themes: view.themes,
    sort: view.sort,
    format: view.format,
    chooseThemes: (themes: string[]) => navigate({ themes }),
  };
}

/**
 * Sort and format, in the filters column (computer) or the Filters panel (tablet, phone), part of
 * the search box's form (BROWSE_FORM): with JavaScript each applies as soon as it changes, with
 * whatever is typed in the search box; without, the "Show stories" button sends them all. Their
 * values are BrowseChoices'.
 */
export function BrowseSortFormat({ filters }: { filters: Filters }) {
  const { view, navigate } = useChoices();
  return (
    <div className="space-y-5">
      {/* Radio buttons, as the moderators' list's sort (Joel, 2026-11-20). */}
      <RadioGroup
        legend="Sort"
        name="sort"
        form={BROWSE_FORM}
        value={view.sort}
        onValueChange={(sort) => navigate({ sort: sort as Filters['sort'] })}
        options={[
          ...(filters.q ? [{ value: 'relevance', label: 'Best match' }] : []),
          { value: 'latest', label: 'Latest first' },
          { value: 'oldest', label: 'Oldest first' },
        ]}
      />
      <div>
        <FormatSelect
          id="browse-format"
          name="format"
          form={BROWSE_FORM}
          value={view.format ?? ''}
          onValueChange={(format) =>
            navigate({ format: (format || null) as StoryFormat | null })
          }
          labelClassName={FILTER_HEADING}
          wrapperClassName="w-full"
          className="w-full"
        />
      </div>
      {/* Without JavaScript the drop-downs can't send themselves. */}
      <noscript>
        <Button type="submit" form={BROWSE_FORM}>
          Show stories
        </Button>
      </noscript>
    </div>
  );
}
