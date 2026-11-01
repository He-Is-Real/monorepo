import { documentHref } from '@/lib/legal-text';

/**
 * "How we use your data: privacy notice", beside every consent box and at sign-up (8b P1 + P2):
 * the notice is information people are given, never something they tick.
 */
export function PrivacyNoticeLink({ className = '' }: { className?: string }) {
  return (
    <p
      data-privacy-notice-link=""
      className={`text-sm text-secondary-text ${className}`.trim()}
    >
      How we use your data:{' '}
      <a
        href={documentHref('privacy-notice')}
        className="inline-flex min-h-11 items-center font-medium text-link underline-offset-4 hover:text-link-hover hover:underline"
      >
        privacy notice
      </a>
    </p>
  );
}
