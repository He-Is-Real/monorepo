'use client';

import {
  type AriaAttributes,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Select as SelectPrimitive } from 'radix-ui';
import { cn } from './cn';
import { COMPACT_FIELD } from './field-style';
import { useFieldControl } from './field';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Pick<
  AriaAttributes,
  'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid'
> {
  /** Pairs with a `<label htmlFor>`; the closed control takes the id in both forms. */
  id?: string;
  /** Posted with the surrounding form (GET or POST), with or without JavaScript. */
  name?: string;
  /** The id of a form elsewhere on the page the value belongs to (the HTML `form` attribute). */
  form?: string;
  options: readonly SelectOption[];
  /** Controlled: the caller keeps the value and updates it from `onValueChange`. */
  value?: string;
  /** Uncontrolled: the first value; the control keeps it from then on. */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Submits its form (the surrounding one, or `form`) once the new value is in it (filters that apply at once). */
  submitOnChange?: boolean;
  disabled?: boolean;
  required?: boolean;
  /** Classes for the closed control (both forms). */
  className?: string;
  /** Classes for the wrapper: its width, mostly. */
  wrapperClassName?: string;
}

/** The U3 rule (Joel, 2026-10-24): touch screens keep their own picker. */
const TOUCH = '(hover: none), (pointer: coarse)';

const subscribe = (onChange: () => void) => {
  const query = matchMedia(TOUCH);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/** True only after hydration, on a mouse or trackpad: the server and touch screens say false. */
const useThemedList = () =>
  useSyncExternalStore(
    subscribe,
    () => !matchMedia(TOUCH).matches,
    () => false,
  );

// Radix reserves "" (it clears the value), and "All formats" is "": a stand-in inside Radix only.
const EMPTY = '\u0000empty';
const toRadix = (value: string) => (value === '' ? EMPTY : value);
const fromRadix = (value: string) => (value === EMPTY ? '' : value);

// The text box's compact field (field-style.ts), with room for the chevron.
const field = `${COMPACT_FIELD} cursor-pointer py-0 pr-10 pl-3`;

/**
 * The site's drop-down (Joel, 2026-10-24 and 2026-11-17): every drop-down is this one.
 *
 * Closed, it's a theme field with the theme's chevron. Open, on a computer (a mouse or
 * trackpad) once the page's JavaScript has run, it's the themed list in every browser (Radix
 * Select: the popover surface, 44 px options, teal for the hovered and the chosen option, a
 * check mark). Before that, without JavaScript, and on phones and tablets (U3), it's a native
 * `<select>`: forms work without JavaScript and touch screens keep their own picker.
 */
export function Select({
  id: ownId,
  name,
  form,
  options,
  value,
  defaultValue,
  onValueChange,
  submitOnChange = false,
  disabled,
  required,
  className,
  wrapperClassName,
  ...ownAria
}: SelectProps) {
  // Inside a Field (field.tsx): its id, hint and error, unless given an id of its own.
  const { id: fieldId, ...fieldAria } = useFieldControl({
    id: ownId,
    ...ownAria,
  });
  const id = fieldId ?? ownId;
  const aria = { ...ownAria, ...fieldAria };
  const themed = useThemedList();
  const [own, setOwn] = useState(defaultValue ?? options[0]?.value ?? '');
  const current = value ?? own;
  const wrapper = useRef<HTMLSpanElement>(null);
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusTrigger = useRef(false);
  const submitPending = useRef(false);
  // Inside a modal <dialog> (the top layer), the list opens inside it too, or it would be under it.
  const [container, setContainer] = useState<HTMLElement | null>(null);

  // After the render that put the new value into the form (the native select, or the hidden
  // input beside the themed list), so the form posts it.
  useEffect(() => {
    if (!submitPending.current) return;
    submitPending.current = false;
    // The form the value is posted with: the native select's or the hidden field's (which follow
    // `form`), else the surrounding one.
    const field = wrapper.current?.querySelector<
      HTMLSelectElement | HTMLInputElement
    >('select, input[type=hidden]');
    (field?.form ?? wrapper.current?.closest('form'))?.requestSubmit();
  }, [current]);

  // Hydration: the person may have used the native select while the page's JavaScript loaded.
  // Keep their choice (React leaves the DOM's value alone and doesn't replay the change), and
  // if it had focus, give focus to the themed list's button when it replaces the select. A
  // `submitOnChange` select applies that choice now, as it would have had the JavaScript been
  // there (the Stories page's sort and format have no other button to send them).
  useLayoutEffect(() => {
    const el = native.current;
    if (!el) return;
    focusTrigger.current =
      document.activeElement === el && !matchMedia(TOUCH).matches;
    if (el.value !== current && options.some((o) => o.value === el.value)) {
      if (value === undefined) setOwn(el.value);
      submitPending.current = submitOnChange;
      onValueChange?.(el.value);
    }
    // Once, on hydration only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (!themed || !focusTrigger.current) return;
    focusTrigger.current = false;
    trigger.current?.focus();
  }, [themed]);

  const choose = (next: string) => {
    if (next === current) return;
    if (value === undefined) setOwn(next);
    submitPending.current = submitOnChange;
    onValueChange?.(next);
  };

  const chosen = options.find((o) => o.value === current);

  return (
    <span
      ref={wrapper}
      className={cn('relative inline-flex', wrapperClassName)}
    >
      {themed ? (
        <>
          <SelectPrimitive.Root
            value={toRadix(current)}
            onValueChange={(v) => choose(fromRadix(v))}
            onOpenChange={(open) => {
              if (open)
                setContainer(wrapper.current?.closest('dialog') ?? null);
            }}
            disabled={disabled}
            required={required}
          >
            <SelectPrimitive.Trigger
              ref={trigger}
              id={id}
              data-slot="select-trigger"
              className={cn(
                field,
                'inline-flex items-center text-left',
                className,
              )}
              {...aria}
            >
              {/* The widest option sets the width, as a native select's does, so the control
                  doesn't change size when the page's JavaScript takes over or the choice changes. */}
              <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]">
                <span
                  data-slot="select-value"
                  className="col-start-1 row-start-1 truncate"
                >
                  <SelectPrimitive.Value>{chosen?.label}</SelectPrimitive.Value>
                </span>
                {options.map((o) => (
                  <span
                    key={o.value}
                    aria-hidden="true"
                    className="invisible col-start-1 row-start-1 h-0 truncate"
                  >
                    {o.label}
                  </span>
                ))}
              </span>
            </SelectPrimitive.Trigger>
            <SelectPrimitive.Portal container={container ?? undefined}>
              <SelectPrimitive.Content
                position="popper"
                align="start"
                sideOffset={6}
                collisionPadding={8}
                className="z-50 max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-1rem)] overflow-hidden rounded-[var(--radius)] border border-border-hover bg-popover text-popover-foreground shadow-popover duration-120 motion-safe:data-[side=bottom]:slide-in-from-top-1 motion-safe:data-[side=top]:slide-in-from-bottom-1 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0"
              >
                <SelectPrimitive.Viewport className="p-1">
                  {options.map((o) => (
                    <SelectPrimitive.Item
                      key={o.value}
                      value={toRadix(o.value)}
                      disabled={o.disabled}
                      className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[calc(var(--radius)-4px)] px-3 text-sm outline-none select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-[color-mix(in_srgb,var(--brand)_16%,transparent)] data-[state=checked]:font-semibold data-[state=checked]:text-link data-[state=checked]:data-[highlighted]:text-link-hover"
                    >
                      <SelectPrimitive.ItemText>
                        {o.label}
                      </SelectPrimitive.ItemText>
                      <SelectPrimitive.ItemIndicator className="ml-auto">
                        <svg
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                          className="size-4 fill-none stroke-current"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </SelectPrimitive.ItemIndicator>
                    </SelectPrimitive.Item>
                  ))}
                </SelectPrimitive.Viewport>
              </SelectPrimitive.Content>
            </SelectPrimitive.Portal>
          </SelectPrimitive.Root>
          {name !== undefined && (
            <input
              type="hidden"
              name={name}
              form={form}
              value={current}
              disabled={disabled}
            />
          )}
        </>
      ) : (
        <select
          ref={native}
          id={id}
          data-slot="select-native"
          name={name}
          form={form}
          value={current}
          disabled={disabled}
          required={required}
          onChange={(e) => choose(e.target.value)}
          className={cn('native-select', field, className)}
          {...aria}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <svg
        data-chevron=""
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 fill-none stroke-muted-foreground"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
}
