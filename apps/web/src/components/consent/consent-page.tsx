import { connection } from 'next/server';
import {
  ClerkConsentForm,
  type ConsentAsk,
  FixtureConsentForm,
} from '@/components/consent/consent-form';
import { NarrowColumn } from '@/components/page/page-header';
import {
  apiUserUrl,
  clerkPublishableKey,
  e2eFixtures,
  e2eSignedInName,
} from '@/lib/config';
import {
  type ConsentFormName,
  type ConsentStatement,
  type ConsentBox,
  getConsentForm,
  parseLegalText,
} from '@/lib/legal';
import { safeReturnPath } from '@/lib/return-path';

/**
 * Where to go after a consent page: the page the person came from (`redirect_url`, a path on
 * this site), but never a consent page itself, which would only send them round again.
 */
export function consentReturnPath(raw: string | string[] | undefined): string {
  const path = safeReturnPath(raw);
  return path === '/consent' || path.startsWith('/consent/') ? '/' : path;
}

/**
 * A consent page (D73, D85): the form in force, read on the server from api-public-read with
 * nothing from the visitor's request (D32), and its boxes, ticked and recorded in the browser
 * through api-user with the person's own token. Per request, so a newly published version is
 * shown at once. D114: the boxes and the words beside them come from the version's statements
 * data and are drawn by the page, outside the document; nothing in the document's words can
 * add, remove or break one. If the form can't be read, or lacks a box this page asks for,
 * nothing can be ticked (fail closed).
 */
export async function ConsentPage({
  form,
  ask,
  mechanism,
  title,
  lead,
  returnTo,
}: {
  form: ConsentFormName;
  /** The boxes this page asks for (all must be on the version in force). */
  ask: ConsentStatement[];
  mechanism: ConsentAsk['mechanism'];
  title: string;
  lead: React.ReactNode;
  returnTo: string;
}) {
  await connection();
  const result = await getConsentForm(form);
  const publishableKey = clerkPublishableKey();
  let body: React.ReactNode;
  if (result.kind !== 'ok') {
    body = (
      <Unavailable>
        {result.kind === 'not_published'
          ? 'This form isn’t available on this site yet.'
          : 'We couldn’t load this form just now. Please try again in a moment.'}
      </Unavailable>
    );
  } else {
    // D114: the boxes come from the version's statements data, never from its words. Every box
    // this page asks for must be there, with words beside it (the migration makes sure).
    const boxes = ask.map((s) =>
      result.form.boxes.find((b) => b.statement === s),
    );
    if (!boxes.every((b) => b !== undefined)) {
      console.error(
        `consent form ${form} ${result.form.id} lacks a box this page asks for`,
      );
      body = (
        <Unavailable>
          We couldn’t load this form just now. Please try again in a moment.
        </Unavailable>
      );
    } else {
      const props: ConsentAsk = {
        form,
        formVersion: result.form.id,
        boxes: boxes as ConsentBox[],
        mechanism,
        blocks: parseLegalText(result.form.text),
        privacy: {
          version: result.privacy.current.id,
          blocks: parseLegalText(result.privacy.current.text),
          pdf: result.privacy.current.pdf,
        },
        terms: result.terms
          ? { version: result.terms.current.id, pdf: result.terms.current.pdf }
          : null,
        returnTo,
        apiUserUrl: apiUserUrl(),
      };
      body = e2eFixtures() ? (
        <FixtureConsentForm {...props} signedIn={!!e2eSignedInName()} />
      ) : publishableKey ? (
        <ClerkConsentForm {...props} />
      ) : (
        <Unavailable>Signing in isn’t available on this site yet.</Unavailable>
      );
    }
  }
  return (
    <main id="main" className="flex-1 py-10 sm:py-16">
      <NarrowColumn>
        <h1 className="mb-3 text-[2rem] leading-tight font-normal text-balance sm:text-[2.5rem]">
          {title}
        </h1>
        <p className="mb-8 text-[1.0625rem] text-secondary-text">{lead}</p>
        <noscript>
          <p className="mb-6 rounded-2xl border border-border bg-card p-6">
            This step needs JavaScript. Please turn it on, or use a browser that
            has it, to continue.
          </p>
        </noscript>
        {body}
      </NarrowColumn>
    </main>
  );
}

function Unavailable({ children }: { children: React.ReactNode }) {
  return (
    <p
      data-consent-unavailable=""
      className="rounded-2xl border border-border bg-card p-6 text-secondary-text"
    >
      {children}
    </p>
  );
}
