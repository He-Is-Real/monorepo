'use client';

import {
  ANY_FORMAT_LABEL,
  FORMAT_LABELS,
  STORY_FORMATS,
  type StoryFormat,
} from '@heisreal/story-filters';
import { Select, type SelectProps } from '@heisreal/web-ui';

/**
 * The format filter every story list shares (revised OQ-2, Joel 2026-11-19): one format, or all
 * of them, as the public browse page offers it; the moderators' list uses the same control, with
 * how many of its stories are in each format.
 */
export function FormatSelect({
  id,
  counts,
  labelClassName = 'sr-only',
  ...select
}: {
  id: string;
  /** How many stories each format holds, shown beside its name. */
  counts?: Record<StoryFormat, number> | null;
  labelClassName?: string;
} & Pick<
  SelectProps,
  | 'name'
  | 'value'
  | 'defaultValue'
  | 'onValueChange'
  | 'submitOnChange'
  | 'className'
  | 'wrapperClassName'
>) {
  return (
    <>
      <label htmlFor={id} className={labelClassName}>
        Format
      </label>
      <Select
        id={id}
        options={[
          { value: '', label: ANY_FORMAT_LABEL },
          ...STORY_FORMATS.map((f) => ({
            value: f,
            label: counts
              ? `${FORMAT_LABELS[f]} (${counts[f]})`
              : FORMAT_LABELS[f],
          })),
        ]}
        {...select}
      />
    </>
  );
}
