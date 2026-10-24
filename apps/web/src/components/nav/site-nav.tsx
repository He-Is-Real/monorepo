'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

// The site's sections (mockups' nav). The static pages are M1 step 6b-2; Donate is a placeholder
// until M4. "Impact" from the mockups waits for real figures. Submission is M2, so "Share your
// story" leads to Get Ready to Share for now.
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
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-0 lg:gap-x-7">
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

/** Phones (below 640 px): a menu button and the links in a panel under the header. */
export function MobileNav() {
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
      wrapper.current.querySelectorAll<HTMLElement>('button, a[href]'),
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
        className="inline-flex size-11 items-center justify-center rounded-md text-secondary-text hover:text-foreground"
      >
        <span className="sr-only">Menu</span>
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
      </button>
      <div
        id={id}
        hidden={!open}
        className="absolute inset-x-0 top-full z-40 border-b border-border bg-background px-4 pb-6 shadow-lg"
      >
        <nav aria-label="Menu">
          <ul>
            {NAV_LINKS.map((l) => (
              <li key={l.href} className="border-b border-border">
                <Link
                  href={l.href}
                  onClick={closeAfterLink}
                  aria-current={
                    isCurrent(pathname, l.href) ? 'page' : undefined
                  }
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
          onClick={closeAfterLink}
          className="mt-6 flex min-h-11 items-center justify-center rounded-md bg-primary px-6 font-semibold text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
        >
          Share your story
        </Link>
      </div>
    </div>
  );
}
