import { Text, TextLink } from '@heisreal/web-ui';
import { documentHref } from '@/lib/legal-text';

/**
 * "How we use your data: privacy notice", beside every consent box and at sign-up (8b P1 + P2):
 * the notice is information people are given, never something they tick.
 */
export function PrivacyNoticeLink({ className = '' }: { className?: string }) {
  return (
    <Text
      size="small"
      tone="quiet"
      data-privacy-notice-link=""
      className={className || undefined}
    >
      How we use your data:{' '}
      <TextLink
        href={documentHref('privacy-notice')}
        className="inline-flex min-h-11 items-center"
      >
        privacy notice
      </TextLink>
    </Text>
  );
}
