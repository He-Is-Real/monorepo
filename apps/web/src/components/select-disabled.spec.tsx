import React from 'react';
import { render } from '@testing-library/react';
import { Select } from '@heisreal/web-ui';

// A disabled drop-down posts nothing with its form, as a disabled native <select> doesn't. No
// page has a disabled drop-down yet, so the e2e suite can't see this; it runs here on a
// "computer" (no touch), where the themed list and its hidden input replace the native select
// (Codex review of #243, round 1).

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

const options = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
];

it.each([
  [true, false],
  [false, true],
])('disabled=%s: the form posts the value: %s', (disabled, posts) => {
  const { container } = render(
    <form>
      <Select
        name="group"
        aria-label="Group"
        options={options}
        defaultValue="b"
        disabled={disabled}
      />
    </form>,
  );
  const form = container.querySelector('form') as HTMLFormElement;
  // The themed list's button, not the native select.
  expect(container.querySelector('[data-slot=select-trigger]')).not.toBeNull();
  expect(new FormData(form).get('group')).toBe(posts ? 'b' : null);
});
