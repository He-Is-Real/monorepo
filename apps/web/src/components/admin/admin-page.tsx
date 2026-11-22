import { AdminNav } from '@/components/admin/admin-access';
import { Card, Heading, Text } from '@heisreal/web-ui';

/** The site's default container, as the site header and footer use it. */
const SITE = 'mx-auto w-full max-w-site px-4 sm:px-10';
/** The standard content column's inner width (800 px less the page's 40 px padding each side). */
const NARROW = 'max-w-[calc(var(--container-narrow)-5rem)]';

/**
 * How wide an admin page's content is, below its header, always centred on the page (OQ-4 D,
 * Joel 2026-11-19; the widths are each page's own, Joel 2026-11-17): `narrow` the standard 800 px column; `site` the site's full content width (1200 px);
 * `double` the standard column on phones and tablets, and twice it from 1280 px (consent's edit
 * box and preview side by side, Joel 2026-11-14), centred on the page there; `story` 800 px,
 * as the story page's article, which sets its own widths inside it (a story under review);
 * `wide` the site's width on phones and tablets, and up to 1600 px from 1280 px, centred like
 * `double` (the moderation list, OQ-3 A and MQ-1 E: Joel 2026-11-17; no column in it over 1200 px).
 */
export type AdminPageWidth = 'narrow' | 'site' | 'double' | 'story' | 'wide';
/** `double` and `wide` from 1280 px: twice the standard column (1600 px), centred. */
const WIDE = `${SITE} xl:max-w-[calc(var(--container-narrow)*2)]`;

/**
 * The shell every admin and moderation page shares (Joel, 2026-11-17; centred, OQ-4 D, Joel
 * 2026-11-19): the admin pages' links, the h1 and the description are centred in the site's
 * default container, so they stay in the same place when switching pages; the content below keeps
 * its own width, centred under them. Text inside the content stays left-aligned. `data-admin-page`
 * reserves the scrollbar's gutter (global.css), so a page that scrolls doesn't shift sideways from
 * one that doesn't.
 */
export function AdminPage({
  title,
  description,
  header,
  width = 'narrow',
  children,
}: {
  /** The page's h1; a page whose content renders its own h1 leaves it out. */
  title?: React.ReactNode;
  /** One or more paragraphs under the h1. */
  description?: React.ReactNode;
  /** Anything else in the header, after the description (a back link). */
  header?: React.ReactNode;
  width?: AdminPageWidth;
  children: React.ReactNode;
}) {
  const content = (
    <>
      <noscript>
        <Card asChild className="mb-6 p-6">
          <p>This page needs JavaScript.</p>
        </Card>
      </noscript>
      {children}
    </>
  );
  return (
    <main id="main" data-admin-page="" className="flex-1 py-10 sm:py-16">
      <div data-admin-header="" className={`${SITE} text-center`}>
        <AdminNav />
        {title && (
          <Heading level={1} className="mb-3">
            {title}
          </Heading>
        )}
        {description && (
          <Text
            as="div"
            size="intro"
            tone="quiet"
            className="mx-auto mb-8 max-w-measure space-y-3"
          >
            {description}
          </Text>
        )}
        {header}
      </div>
      {width === 'site' ? (
        <div data-admin-content="" className={SITE}>
          {content}
        </div>
      ) : width === 'narrow' || width === 'story' ? (
        <div className={SITE}>
          <div
            data-admin-content=""
            className={`mx-auto ${width === 'story' ? 'max-w-narrow' : NARROW}`}
          >
            {content}
          </div>
        </div>
      ) : width === 'wide' ? (
        <div data-admin-content="" className={WIDE}>
          {content}
        </div>
      ) : (
        <div className={WIDE}>
          <div
            data-admin-content=""
            className={`mx-auto ${NARROW} xl:max-w-none`}
          >
            {content}
          </div>
        </div>
      )}
    </main>
  );
}
