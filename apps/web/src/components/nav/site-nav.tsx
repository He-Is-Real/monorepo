'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

// The site's sections (mockups' nav). The static pages are M1 step 6b-2; Donate shows Stripe's
// Buy Buttons where they're set (M4), otherwise a placeholder. "Impact" from the mockups waits
// for real figures. Submission is M2, so "Share your story" leads to Get Ready to Share for now.
export const NAV_LINKS = [
  { href: '/stories', label: 'Stories' },
  { href: '/about', label: 'About' },
  { href: '/faqs', label: 'FAQs' },
  { href: '/greatest-story', label: 'Greatest Story' },
  { href: '/contact', label: 'Contact' },
  { href: '/donate', label: 'Donate' },
] as const;
export const SHARE_HREF = '/get-ready';

const isCurrent = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/** The main navigation: one row on desktops, a second header row on tablets (plan 1.6). */
export function NavLinks({ className = '' }: { className?: string }) {
  const pathname = usePathname() ?? '/';
  return (
    <nav aria-label="Main navigation" className={className}>
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-0 lg:gap-x-7 xl:flex-nowrap">
        {NAV_LINKS.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              aria-current={isCurrent(pathname, l.href) ? 'page' : undefined}
              className="relative inline-flex min-h-11 min-w-11 items-center justify-center text-sm font-medium text-secondary-text after:absolute after:inset-x-0 after:bottom-2 after:h-0.5 after:origin-left after:scale-x-0 after:bg-teal after:transition-transform hover:text-foreground hover:after:scale-x-100 aria-[current=page]:text-foreground aria-[current=page]:after:scale-x-100 motion-reduce:after:transition-none"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const MENU_BUTTON =
  'inline-flex size-11 items-center justify-center rounded-md text-secondary-text hover:text-foreground';
// The menu's focusable items, in order: the disclosure's and the button's are the same list.
const DISCLOSURE_ITEMS = 'summary, a[href]';
const MENU_ITEMS = 'button, a[href]';
const PANEL =
  'absolute inset-x-0 top-full z-40 border-b border-border bg-background px-4 pb-6 shadow-lg';

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-6 fill-none stroke-current"
      strokeWidth="2"
      strokeLinecap="round"
    >
      {open ? (
        <path d="M6 6l12 12M18 6L6 18" />
      ) : (
        <path d="M3 6h18M3 12h18M3 18h18" />
      )}
    </svg>
  );
}

/** The menu's links and its "Share your story" button. */
function MenuLinks({
  pathname,
  onLink,
}: {
  pathname: string;
  onLink?: () => void;
}) {
  return (
    <>
      <nav aria-label="Menu">
        <ul>
          {NAV_LINKS.map((l) => (
            <li key={l.href} className="border-b border-border">
              <Link
                href={l.href}
                onClick={onLink}
                aria-current={isCurrent(pathname, l.href) ? 'page' : undefined}
                className="flex min-h-12 items-center text-lg text-secondary-text hover:text-foreground aria-[current=page]:font-semibold aria-[current=page]:text-foreground"
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Link
        href={SHARE_HREF}
        onClick={onLink}
        className="mt-6 flex min-h-11 items-center justify-center rounded-md bg-primary px-6 font-semibold text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
      >
        Share your story
      </Link>
    </>
  );
}

/**
 * Phones (below 640 px): a menu button and the links in a panel under the header. In the
 * server's HTML (and so for visitors without JavaScript) it's a disclosure the browser opens
 * by itself; once React runs, the button below takes over, with its focus handling and Escape.
 * Both are the same size, so nothing moves when it swaps, and the button's menu starts as the
 * visitor left the disclosure: open if they opened it, focus on the item it was on.
 */
export function MobileNav() {
  const [upgraded, setUpgraded] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  // The item focused in the disclosure when it was swapped (its place in the list), if any.
  const focusedItem = useRef(-1);
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  const [shownFor, setShownFor] = useState(pathname);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  // A new page closes the menu (adjusting state while rendering, not in an effect).
  if (shownFor !== pathname) {
    setShownFor(pathname);
    setOpen(false);
  }

  const wrapper = useRef<HTMLDivElement>(null);

  // Once React runs: swap in the button's menu, open if the disclosure was open.
  useEffect(() => {
    const disclosure = details.current;
    if (!disclosure) return;
    focusedItem.current = Array.from(
      disclosure.querySelectorAll(DISCLOSURE_ITEMS),
    ).indexOf(document.activeElement as Element);
    setOpen(disclosure.open);
    setUpgraded(true);
  }, []);

  // Focus goes back to the item it was on (the swap removed it), before the next paint.
  useLayoutEffect(() => {
    if (!upgraded || focusedItem.current < 0) return;
    wrapper.current
      ?.querySelectorAll<HTMLElement>(MENU_ITEMS)
      [focusedItem.current]?.focus();
    focusedItem.current = -1;
  }, [upgraded]);

  // Any link in the menu closes it, also one to the page already open (same pathname, so the
  // pathname check above can't), and focus goes back to the menu button.
  const closeAfterLink = () => {
    setOpen(false);
    button.current?.focus();
  };

  // While open, Escape closes the menu wherever focus is, and gives focus back to the button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // While open, Tab stays in the menu (the panel covers the page): it wraps from the last link
  // to the button and back.
  const keepFocusInside = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !open || !wrapper.current) return;
    const items = Array.from(
      wrapper.current.querySelectorAll<HTMLElement>(MENU_ITEMS),
    );
    const first = items[0];
    const last = items.at(-1);
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    }
  };

  if (!upgraded)
    return (
      <details ref={details} data-mobile-nav="" className="sm:hidden">
        <summary
          className={`${MENU_BUTTON} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
        >
          <span className="sr-only">Menu</span>
          <MenuIcon open={false} />
        </summary>
        <div className={PANEL}>
          <MenuLinks pathname={pathname} />
        </div>
      </details>
    );

  return (
    <div
      ref={wrapper}
      data-mobile-nav=""
      className="sm:hidden"
      onKeyDown={keepFocusInside}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={MENU_BUTTON}
      >
        <span className="sr-only">Menu</span>
        <MenuIcon open={open} />
      </button>
      <div id={id} hidden={!open} className={PANEL}>
        <MenuLinks pathname={pathname} onLink={closeAfterLink} />
      </div>
    </div>
  );
}
