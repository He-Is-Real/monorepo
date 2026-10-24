'use client';

import { Popover } from 'radix-ui';
import { type ReactNode, useId, useState } from 'react';
import { shareLinks } from '@/lib/share';

// The story page's share popup (mockups): WhatsApp, Facebook, Instagram, X and copy link. Plain
// links only (lib/share.ts). The address is the page's own, read in the browser without its
// query string. Radix keeps focus inside while open; Escape and clicking outside close it.

const option =
  'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-secondary-text transition-colors hover:bg-surface hover:text-foreground focus-visible:bg-surface';

function Icon({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className="flex w-5 shrink-0 justify-center">
      {children}
    </span>
  );
}

export function ShareMenu({ title }: { title: string }) {
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState('');
  const gradient = useId();

  const copy = async (done: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setMessage(done);
    } catch {
      setMessage('Couldn’t copy. Copy the address from your browser instead.');
    }
  };
  const links = shareLinks(url, title);
  const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (!open) return;
        setUrl(`${window.location.origin}${window.location.pathname}`);
        setMessage('');
      }}
    >
      <Popover.Trigger className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border-hover px-4 text-sm font-semibold text-secondary-text transition-colors hover:border-teal hover:bg-accent hover:text-foreground data-[state=open]:border-teal">
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-4 fill-none stroke-current"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v13" />
        </svg>
        Share
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          aria-labelledby={`${gradient}-title`}
          className="z-50 max-h-[var(--radix-popover-content-available-height)] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-2xl border border-border-hover bg-card p-3 text-card-foreground shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95"
        >
          <h2
            id={`${gradient}-title`}
            className="px-3 pt-1 pb-2 text-sm font-semibold text-muted-foreground"
          >
            Share this story
          </h2>
          <ul>
            <li>
              <a href={links.whatsapp} className={option} {...external}>
                <Icon>
                  <svg
                    viewBox="0 0 24 24"
                    className="size-[18px] fill-[#25D366]"
                  >
                    <path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.26-.46-2.39-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.14.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.07c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.7.63.71.22 1.36.19 1.87.12.57-.09 1.76-.72 2-1.41.25-.7.25-1.29.18-1.41-.08-.13-.28-.2-.57-.35M12.05 21.79h-.01a9.87 9.87 0 01-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 01-1.51-5.26c0-5.45 4.44-9.88 9.89-9.88 2.64 0 5.12 1.03 6.99 2.9a9.83 9.83 0 012.89 6.99c0 5.45-4.44 9.88-9.88 9.88m8.41-18.3A11.82 11.82 0 0012.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.88 11.88 0 005.68 1.45h.01c6.55 0 11.89-5.34 11.89-11.89a11.82 11.82 0 00-3.48-8.41z" />
                  </svg>
                </Icon>
                WhatsApp
              </a>
            </li>
            <li>
              <a href={links.facebook} className={option} {...external}>
                <Icon>
                  <svg
                    viewBox="0 0 24 24"
                    className="size-[18px] fill-[#1877F2]"
                  >
                    <path d="M24 12.07C24 5.45 18.63.07 12 .07S0 5.45 0 12.07c0 5.99 4.39 10.95 10.13 11.85v-8.38H7.08v-3.47h3.05V9.43c0-3.01 1.79-4.67 4.53-4.67 1.31 0 2.69.24 2.69.24v2.95h-1.51c-1.49 0-1.96.93-1.96 1.87v2.25h3.33l-.53 3.47h-2.8v8.38C19.61 23.03 24 18.06 24 12.07z" />
                  </svg>
                </Icon>
                Facebook
              </a>
            </li>
            <li>
              <button
                type="button"
                className={option}
                onClick={() => void copy('Link copied. Paste it in Instagram.')}
              >
                <Icon>
                  <svg viewBox="0 0 24 24" className="size-[18px]">
                    <defs>
                      <linearGradient
                        id={gradient}
                        x1="0%"
                        y1="100%"
                        x2="100%"
                        y2="0%"
                      >
                        <stop offset="0%" stopColor="#FFDC80" />
                        <stop offset="25%" stopColor="#F77737" />
                        <stop offset="50%" stopColor="#E1306C" />
                        <stop offset="75%" stopColor="#C13584" />
                        <stop offset="100%" stopColor="#833AB4" />
                      </linearGradient>
                    </defs>
                    <path
                      fill={`url(#${gradient})`}
                      d="M12 2.16c3.2 0 3.58.01 4.85.07 3.25.15 4.77 1.69 4.92 4.92.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.15 3.23-1.66 4.77-4.92 4.92-1.27.06-1.64.07-4.85.07s-3.58-.01-4.85-.07c-3.26-.15-4.77-1.7-4.92-4.92-.06-1.27-.07-1.64-.07-4.85s.01-3.58.07-4.85C2.38 3.92 3.9 2.38 7.15 2.23 8.42 2.17 8.8 2.16 12 2.16zM12 0C8.74 0 8.33.01 7.05.07 2.7.27.27 2.69.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.2 4.36 2.62 6.78 6.98 6.98 1.28.06 1.69.07 4.95.07s3.67-.01 4.95-.07c4.35-.2 6.78-2.62 6.98-6.98.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.2-4.35-2.62-6.78-6.98-6.98C15.67.01 15.26 0 12 0zm0 5.84a6.16 6.16 0 100 12.32 6.16 6.16 0 000-12.32zM12 16a4 4 0 110-8 4 4 0 010 8zm6.41-11.85a1.44 1.44 0 100 2.88 1.44 1.44 0 000-2.88z"
                    />
                  </svg>
                </Icon>
                Instagram
              </button>
            </li>
            <li>
              <a href={links.x} className={option} {...external}>
                <Icon>
                  <svg viewBox="0 0 24 24" className="size-4 fill-current">
                    <path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.12z" />
                  </svg>
                </Icon>
                X (Twitter)
              </a>
            </li>
            <li className="mt-1 border-t border-border pt-1">
              <button
                type="button"
                className={option}
                onClick={() => void copy('Link copied.')}
              >
                <Icon>
                  <svg
                    viewBox="0 0 24 24"
                    className="size-4 fill-none stroke-current"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M10 14a5 5 0 007.07 0l3-3a5 5 0 00-7.07-7.07l-1.5 1.5M14 10a5 5 0 00-7.07 0l-3 3a5 5 0 007.07 7.07l1.5-1.5" />
                  </svg>
                </Icon>
                Copy link
              </button>
            </li>
          </ul>
          <p role="status" className="px-3 pt-1 text-sm text-link empty:hidden">
            {message}
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
