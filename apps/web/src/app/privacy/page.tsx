import { DraftNotice } from '@/components/page/draft-notice';
import { NarrowColumn } from '@/components/page/page-header';
import { pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata({
  title: 'Privacy policy',
  description:
    'How He Is Real Today looks after your data, and the few cookies and storage items the site needs to work.',
  path: '/privacy',
});

// What the site stores on a visitor's device, checked on the dev site (M1 step 6b-2): the
// theme the visitor picks, and Clerk's sign-in (it runs in the header on every page, D32).
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
    name: '__cf_bm, _cfuvid',
    kind: 'Cookies',
    by: 'Cloudflare, for Clerk (on Clerk’s domain)',
    purpose: 'Protect sign-in from bots.',
    lasts: '30 minutes, or until you close the browser',
  },
  {
    name: '__clerk_db_jwt',
    kind: 'Cookie',
    by: 'Clerk, on the development site only',
    purpose: 'Connects your browser to Clerk’s development setup.',
    lasts: '1 year',
  },
];

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
        <p className="mb-12 max-w-prose text-secondary-text">
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
          <div className="mb-6 max-w-prose space-y-4 text-secondary-text">
            <p>
              We only use the cookies and storage the site needs to work. We
              don’t use advertising or tracking cookies, and we don’t run
              analytics.
            </p>
            <p>
              That’s why there’s no cookie banner: nothing here needs your
              consent. If we ever want to use anything that isn’t essential,
              we’ll ask you first.
            </p>
          </div>
          {/* Scrolls sideways on narrow phones; focusable so keyboards can scroll it too. */}
          <div
            role="region"
            aria-label="Cookies and storage table"
            tabIndex={0}
            className="overflow-x-auto rounded-xl border border-border"
          >
            <table className="w-full min-w-[36rem] text-left text-sm">
              <caption className="sr-only">
                Cookies and storage this site uses
              </caption>
              <thead className="bg-raised text-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Set by
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    What it’s for
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    How long
                  </th>
                </tr>
              </thead>
              <tbody className="text-secondary-text">
                {STORAGE.map((s) => (
                  <tr key={s.name} className="border-t border-border align-top">
                    <th
                      scope="row"
                      className="px-4 py-3 font-mono text-xs font-normal break-all text-foreground"
                    >
                      {s.name}
                    </th>
                    <td className="px-4 py-3">
                      {s.by}
                      <span className="block text-xs text-muted-foreground">
                        {s.kind}
                      </span>
                    </td>
                    <td className="px-4 py-3">{s.purpose}</td>
                    <td className="px-4 py-3">{s.lasts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 max-w-prose text-sm text-secondary-text">
            Story videos and audio play in Bunny.net’s player, which sets no
            cookies when a story page loads.
          </p>
        </section>

        <section aria-labelledby="questions" className="mt-12">
          <h2
            id="questions"
            className="mb-4 text-2xl font-normal sm:text-[1.75rem]"
          >
            Questions
          </h2>
          <p className="max-w-prose text-secondary-text">
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
