'use client';

import Form from 'next/form';
import { type ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import type { BrowseFilters as Filters } from '@/lib/browse-query';

const field =
  'h-11 rounded-lg border border-input bg-input-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30';

/**
 * Search, sort and format (browse mockup's filter bar). A plain GET form to /stories, so it
 * works without JavaScript; with it, Next navigates without a full reload and the selects apply
 * as soon as they change. The selected tags ride along as hidden fields. Changing a filter
 * starts again from the first page.
 */
export function BrowseFilters({ filters }: { filters: Filters }) {
  const submitOnChange = (e: ChangeEvent<HTMLSelectElement>) =>
    e.currentTarget.form?.requestSubmit();
  return (
    <Form
      // The fields start from the URL's filters; when those change without a new page (Back,
      // a tag link), the form starts again so it never disagrees with the list.
      key={JSON.stringify(filters)}
      action="/stories"
      role="search"
      aria-label="Stories"
      className="flex flex-wrap items-center gap-3"
    >
      {filters.tags.map((t) => (
        <input key={t} type="hidden" name="tag" value={t} />
      ))}
      <div className="min-w-[min(100%,16rem)] flex-1 sm:max-w-sm">
        <label htmlFor="browse-q" className="sr-only">
          Search stories
        </label>
        <input
          id="browse-q"
          type="search"
          name="q"
          defaultValue={filters.q}
          maxLength={200}
          placeholder="Search stories…"
          className={`${field} w-full px-4 placeholder:text-faint`}
        />
      </div>
      <label htmlFor="browse-sort" className="sr-only">
        Sort
      </label>
      <select
        id="browse-sort"
        name="sort"
        defaultValue={filters.sort}
        onChange={submitOnChange}
        className={field}
      >
        {filters.q && <option value="relevance">Best match</option>}
        <option value="latest">Latest first</option>
        <option value="oldest">Oldest first</option>
      </select>
      <label htmlFor="browse-format" className="sr-only">
        Format
      </label>
      <select
        id="browse-format"
        name="format"
        defaultValue={filters.format ?? ''}
        onChange={submitOnChange}
        className={field}
      >
        <option value="">All formats</option>
        <option value="video">Video</option>
        <option value="audio">Audio</option>
        <option value="written">Written</option>
      </select>
      <Button type="submit" className="h-11 px-5">
        Search
      </Button>
    </Form>
  );
}
