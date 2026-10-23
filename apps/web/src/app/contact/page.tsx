import { ButtonLink } from '@/components/page/button-link';
import { Card } from '@/components/page/card';
import { PageHeader } from '@/components/page/page-header';
import { pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata({
  title: 'Contact us',
  description:
    'Got a question, an idea, or just want to say hello? Email He Is Real Today and a real person will read your message.',
  path: '/contact',
});

const EMAIL = 'info@heisreal.today';

/**
 * No form yet: there's no email service until Resend arrives, and we don't collect personal
 * data without a backend and a privacy basis. Email meanwhile.
 */
export default function ContactPage() {
  return (
    <main id="main" className="flex-1 py-12 sm:py-20">
      <div className="mx-auto w-full max-w-[36rem] px-4 sm:px-10">
        <PageHeader
          eyebrow="Hello"
          title="Get in touch"
          lead="Got a question, an idea, or just want to say hello? A real person will read your message."
        />
        <Card className="p-6 text-center sm:p-8">
          <p className="mb-6 text-secondary-text">
            Our contact form is coming soon. Until then, email us and we’ll get
            back to you.
          </p>
          <ButtonLink
            href={`mailto:${EMAIL}`}
            className="w-full [overflow-wrap:anywhere]"
          >
            Email {EMAIL}
          </ButtonLink>
        </Card>
      </div>
    </main>
  );
}
