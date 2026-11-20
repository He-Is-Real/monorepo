'use client';

import Form from 'next/form';
import { useSearchParams } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from 'react';
import { Button, RadioGroup, SearchBox } from '@heisreal/web-ui';
import { FormatSelect } from '@/components/story-filters/format-select';
import {
  type BrowseFilters as Filters,
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
 * A plain GET form to /stories, so it works without JavaScript; with it, Next navigates without
 * a full reload. The theme and "Favourites only" ride along as hidden fields. Changing a filter
 * starts again from the first page.
 */
export function BrowseSearch({ filters }: { filters: Filters }) {
  const favourites = favouritesOn(useSearchParams());
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
    >
      {filters.theme && (
        <input type="hidden" name="theme" value={filters.theme} />
      )}
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

/** The sort and format as chosen on this page, which may be ahead of the address. */
type Choices = {
  sort: string;
  format: string;
  setSort: (sort: string) => void;
  setFormat: (format: string) => void;
};
const ChoicesContext = createContext<Choices | null>(null);

/**
 * Keeps the sort and format choices above the filters, so they survive the filters moving
 * between the column and the Filters panel (which remounts them) while a change is still
 * loading: closing the panel then searching sends the new sort, not the address's (Codex, #254).
 * They start from the address's filters, and again whenever those change.
 */
export function BrowseChoices({
  filters,
  children,
}: {
  filters: Filters;
  children: ReactNode;
}) {
  const from = JSON.stringify(filters);
  const [state, setState] = useState({
    from,
    sort: filters.sort as string,
    format: filters.format ?? '',
  });
  // A new address (a change applied, Back, a link): start again from it. React's "adjust state
  // while rendering".
  if (state.from !== from)
    setState({ from, sort: filters.sort, format: filters.format ?? '' });
  const choices = useMemo(
    () => ({
      sort: state.sort,
      format: state.format,
      setSort: (sort: string) => setState((s) => ({ ...s, sort })),
      setFormat: (format: string) => setState((s) => ({ ...s, format })),
    }),
    [state.sort, state.format],
  );
  return (
    <ChoicesContext.Provider value={choices}>
      {children}
    </ChoicesContext.Provider>
  );
}

/**
 * Sort and format, in the filters column (computer) or the Filters panel (tablet, phone), part of
 * the search box's form (BROWSE_FORM): with JavaScript each applies as soon as it changes, with
 * whatever is typed in the search box; without, the "Show stories" button sends them all. Their
 * values are BrowseChoices'.
 */
export function BrowseSortFormat({ filters }: { filters: Filters }) {
  const choices = useContext(ChoicesContext);
  if (!choices) throw new Error('BrowseSortFormat needs BrowseChoices');
  return (
    <div className="space-y-5">
      {/* Radio buttons, as the moderators' list's sort (Joel, 2026-11-20). */}
      <RadioGroup
        legend="Sort"
        name="sort"
        form={BROWSE_FORM}
        value={choices.sort}
        onValueChange={choices.setSort}
        options={[
          ...(filters.q ? [{ value: 'relevance', label: 'Best match' }] : []),
          { value: 'latest', label: 'Latest first' },
          { value: 'oldest', label: 'Oldest first' },
        ]}
        submitOnChange
      />
      <div>
        <FormatSelect
          id="browse-format"
          name="format"
          form={BROWSE_FORM}
          value={choices.format}
          onValueChange={choices.setFormat}
          labelClassName={FILTER_HEADING}
          submitOnChange
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
