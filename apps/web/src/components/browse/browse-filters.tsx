'use client';

import Form from 'next/form';
import { useSearchParams } from 'next/navigation';
import { Button, Input, Select } from '@heisreal/web-ui';
import { FormatSelect } from '@/components/story-filters/format-select';
import {
  type BrowseFilters as Filters,
  FAVOURITES_PARAM,
  favouritesOn,
} from '@/lib/browse-query';

/**
 * Search, sort and format (browse mockup's filter bar). A plain GET form to /stories, so it
 * works without JavaScript; with it, Next navigates without a full reload and the selects apply
 * as soon as they change. The chosen theme rides along as a hidden field. Changing a filter
 * starts again from the first page. With "Favourites only" on, they filter the favourites and
 * the switch rides along too.
 */
export function BrowseFilters({ filters }: { filters: Filters }) {
  const favourites = favouritesOn(useSearchParams());
  return (
    <Form
      // The fields start from the URL's filters; when those change without a new page (Back,
      // a theme link), the form starts again so it never disagrees with the list.
      key={JSON.stringify(filters)}
      action="/stories"
      role="search"
      aria-label="Stories"
      className="flex flex-wrap items-center gap-3"
    >
      {filters.theme && (
        <input type="hidden" name="theme" value={filters.theme} />
      )}
      {favourites && <input type="hidden" name={FAVOURITES_PARAM} value="1" />}
      <div className="min-w-[min(100%,16rem)] flex-1 sm:max-w-sm">
        <label htmlFor="browse-q" className="sr-only">
          Search stories
        </label>
        <Input
          id="browse-q"
          type="search"
          name="q"
          defaultValue={filters.q}
          maxLength={200}
          placeholder="Search stories…"
          className="px-4"
        />
      </div>
      <label htmlFor="browse-sort" className="sr-only">
        Sort
      </label>
      <Select
        id="browse-sort"
        name="sort"
        defaultValue={filters.sort}
        options={[
          ...(filters.q ? [{ value: 'relevance', label: 'Best match' }] : []),
          { value: 'latest', label: 'Latest first' },
          { value: 'oldest', label: 'Oldest first' },
        ]}
        submitOnChange
      />
      <FormatSelect
        id="browse-format"
        name="format"
        defaultValue={filters.format ?? ''}
        submitOnChange
      />
      <Button type="submit" className="h-11 px-5">
        Search
      </Button>
    </Form>
  );
}
