import { DraftNotice } from '@/components/page/draft-notice';
import { NarrowColumn } from '@/components/page/page-header';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). */
export function generateMetadata() {
  return pageMetadata({
    title: 'Privacy policy',
    description:
      'How He Is Real Today looks after your data, and the few cookies and storage items the site needs to work.',
    path: '/privacy',
  });
}

// What the site stores on a visitor's device, checked in a real (non-automated) browser on
// 2026-10-23 (M1 step 6b-2, #65 review): the theme the visitor picks, and Clerk's sign-in (it
// runs in the header on every page, D32), with Clerk's optional telemetry off.
// Bunny's player keeps the visitor's own playback settings once they change one (Codex, #65).
// Hearts pressed while signed out (or before the sign-up consent) stay in this browser's local
// storage (M2, Joel, 2026-10-28); only their story ids are sent, anonymously, to show their cards.
// All strictly necessary (PECR reg. 6(4)), so no consent banner. Clerk may add a short suffix
// to its cookie names.
const STORAGE = [
  {
    name: 'theme',
    kind: 'Local storage',
    by: 'This site',
    purpose:
      'Remembers the light or dark theme you picked. Only saved if you use the theme button.',
    lasts: 'Until you clear it',
  },
  {
    name: '__client_uat',
    kind: 'Cookie',
    by: 'Clerk, our sign-in provider',
    purpose:
      'Tells the site whether you’re signed in, so sign-in works across pages.',
    lasts: '1 year',
  },
  {
    name: '__session',
    kind: 'Cookie',
    by: 'Clerk',
    purpose: 'Keeps you signed in. Only set when you sign in.',
    lasts: 'Minutes, renewed while you’re signed in',
  },
  {
    name: '__clerk_environment',
    kind: 'Local storage',
    by: 'Clerk',
    purpose: 'Keeps a copy of the sign-in settings, so sign-in loads quickly.',
    lasts: 'Until you clear it',
  },
  {
    name: 'heisreal:device-hearts',
    kind: 'Local storage',
    by: 'This site',
    purpose:
      'The stories you hearted on this device: while signed out, or signed in before agreeing to keep favourites in your account, and which of them were added to an account from here. The list stays in your browser, and we keep no copy of it. To show these stories in My favourites, or to offer adding them to your account, your browser tells our site which stories they are, without saying who you are. Only if you choose Add are they saved to your account.',
    lasts: 'Until you remove the hearts or clear this browser’s data',
  },
  {
    name: '__cf_bm, _cfuvid',
    kind: 'Cookies',
    by: 'Cloudflare, for Clerk (on Clerk’s domain)',
    purpose: 'Protect sign-in from bots.',
    lasts: '30 minutes, or until you close the browser',
  },
  {
    name: 'bunny_stream_settings_…',
    kind: 'Local storage, in the video player (player.mediadelivery.net)',
    by: 'Bunny.net, our video player',
    purpose:
      'Remembers the playback speed, volume or mute you chose. Only saved if you change one of them.',
    lasts: 'Until you clear it',
  },
  {
    name: '__clerk_db_jwt',
    kind: 'Cookie',
    by: 'Clerk, on the development site only',
    purpose: 'Connects your browser to Clerk’s development setup.',
    lasts: '1 year',
  },
];

const COLUMNS = ['Name', 'Set by', 'What it’s for', 'How long'];
// On phones each cell shows its column name above it (from data-label; the header row is
// visually hidden there).
const cell =
  'max-sm:block max-sm:py-1 max-sm:before:block max-sm:before:text-xs max-sm:before:font-semibold max-sm:before:text-foreground max-sm:before:content-[attr(data-label)] sm:px-4 sm:py-3';

export default function PrivacyPage() {
  return (
    <main id="main" className="flex-1 py-12 sm:py-20">
      <NarrowColumn>
        <DraftNotice>
          This is a placeholder. The real privacy policy, covering the stories
          people share and how we look after them, comes before the site goes
          live.
        </DraftNotice>
        <h1 className="mb-6 text-[2rem] leading-tight font-normal sm:text-[2.75rem]">
          Privacy policy
        </h1>
        <p className="mb-12 text-secondary-text">
          He Is Real Today is a UK-based not-for-profit. We follow UK data
          protection law, and we only collect what we need to run the site.
        </p>

        <section
          id="cookies"
          aria-labelledby="cookies-heading"
          className="scroll-mt-6"
        >
          <h2
            id="cookies-heading"
            className="mb-4 text-2xl font-normal sm:text-[1.75rem]"
          >
            Cookies and storage
          </h2>
          <div className="mb-6 space-y-4 text-secondary-text">
            <p>
              We only use the cookies and storage the site needs to work, or to
              remember a choice you made, like the theme or a video’s playback
              speed. We don’t use advertising or tracking cookies, and we don’t
              run analytics.
            </p>
            <p>
              That’s why there’s no cookie banner: nothing here needs your
              consent. If we ever want to use anything that isn’t essential,
              we’ll ask you first.
            </p>
          </div>
          {/* Below sm each row stacks as a block with its column names, so nothing scrolls
              sideways; explicit roles keep it a table for screen readers despite the CSS. */}
          {/* From 1024 px the table needs more room than the reading column: it breaks out
              by the same amount on both sides, so it stays centred on the text. */}
          <div className="rounded-xl border border-border lg:-mx-16">
            {/* From sm, break-word, not the site's `anywhere`: a table sizes its columns from
                their narrowest content, which `anywhere` would shrink to single letters. Below
                sm the rows stack as blocks, where `anywhere` is harmless. */}
            <table
              role="table"
              className="w-full text-left text-sm sm:[overflow-wrap:break-word]"
            >
              <caption className="sr-only">
                Cookies and storage this site uses
              </caption>
              <thead role="rowgroup" className="bg-raised text-foreground">
                <tr role="row">
                  {COLUMNS.map((c) => (
                    <th
                      key={c}
                      role="columnheader"
                      scope="col"
                      // On each cell, not the thead: `overflow` doesn't apply to table rows
                      // and row groups, so a hidden thead's cells still widened the page.
                      className="px-4 py-3 font-semibold max-sm:sr-only"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup" className="text-secondary-text">
                {STORAGE.map((s, i) => (
                  <tr
                    key={s.name}
                    role="row"
                    className={`align-top max-sm:block max-sm:px-4 max-sm:py-4 ${i ? 'border-t border-border' : 'sm:border-t sm:border-border'}`}
                  >
                    <th
                      role="rowheader"
                      scope="row"
                      className="font-mono text-xs font-normal break-all text-foreground max-sm:block max-sm:pb-2 sm:px-4 sm:py-3"
                    >
                      {s.name}
                    </th>
                    <td role="cell" data-label={COLUMNS[1]} className={cell}>
                      {s.by}
                      <span className="block text-xs text-muted-foreground">
                        {s.kind}
                      </span>
                    </td>
                    <td role="cell" data-label={COLUMNS[2]} className={cell}>
                      {s.purpose}
                    </td>
                    <td role="cell" data-label={COLUMNS[3]} className={cell}>
                      {s.lasts}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-6 space-y-3 text-sm text-secondary-text">
            <p>
              Clerk’s optional product telemetry is turned off, so it neither
              stores anything nor sends usage data.
            </p>
            <p>
              Story videos and audio, and our founder’s introduction on the
              About page, play in Bunny.net’s player. It stores nothing on your
              device unless you change a player setting (listed above). While a
              video plays, it sends Bunny playback statistics (which video, and
              how long it played) so we can tell that videos work.
            </p>
          </div>
        </section>

        <section aria-labelledby="questions" className="mt-12">
          <h2
            id="questions"
            className="mb-4 text-2xl font-normal sm:text-[1.75rem]"
          >
            Questions
          </h2>
          <p className="text-secondary-text">
            Email us at{' '}
            <a
              href="mailto:info@heisreal.today"
              className="inline-flex min-h-11 items-center"
            >
              info@heisreal.today
            </a>
            .
          </p>
        </section>
      </NarrowColumn>
    </main>
  );
}
