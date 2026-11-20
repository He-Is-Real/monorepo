'use client';

import Form from 'next/form';
import { useSearchParams } from 'next/navigation';
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
 * The search box above the stories (BS-1 C; BS-2 A: a magnifier inside it, Enter searches too).
 * A plain GET form to /stories, so it works without JavaScript; with it, Next navigates without
 * a full reload. The other filters ride along as hidden fields, as they did when they shared its
 * form, so a search keeps them. Changing a filter starts again from the first page.
 */
export function BrowseSearch({ filters }: { filters: Filters }) {
  const favourites = favouritesOn(useSearchParams());
  return (
    <Form
      // The box starts from the URL's search; when that changes without a new page (Back,
      // a theme link), the form starts again so it never disagrees with the list.
      key={JSON.stringify(filters)}
      action="/stories"
      role="search"
      aria-label="Stories"
      className="min-w-0 flex-1"
    >
      {filters.theme && (
        <input type="hidden" name="theme" value={filters.theme} />
      )}
      {filters.format && (
        <input type="hidden" name="format" value={filters.format} />
      )}
      <input type="hidden" name="sort" value={filters.sort} />
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

/**
 * Sort and format, in the filters column (computer) or the Filters panel (tablet, phone). A GET
 * form to /stories: with JavaScript each applies as soon as it changes; without, its own
 * "Show stories" button sends it. The search, theme and "Favourites only" ride along.
 */
export function BrowseSortFormat({ filters }: { filters: Filters }) {
  const favourites = favouritesOn(useSearchParams());
  return (
    <Form key={JSON.stringify(filters)} action="/stories" className="space-y-5">
      {filters.q && <input type="hidden" name="q" value={filters.q} />}
      {filters.theme && (
        <input type="hidden" name="theme" value={filters.theme} />
      )}
      {favourites && <input type="hidden" name={FAVOURITES_PARAM} value="1" />}
      {/* Radio buttons, as the moderators' list's sort (Joel, 2026-11-20). */}
      <RadioGroup
        legend="Sort"
        name="sort"
        defaultValue={filters.sort}
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
          defaultValue={filters.format ?? ''}
          labelClassName={FILTER_HEADING}
          submitOnChange
          wrapperClassName="w-full"
          className="w-full"
        />
      </div>
      {/* Without JavaScript the drop-downs can't send themselves. */}
      <noscript>
        <Button type="submit" className="h-11 px-5">
          Show stories
        </Button>
      </noscript>
    </Form>
  );
}
