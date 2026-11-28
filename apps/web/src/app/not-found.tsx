import { Heading, Text } from '@heisreal/web-ui';
import { TextLink } from '@/components/page/text-link';

/**
 * The "not found" page answers 200, not 404 (PC-1): Next.js streams a page's start, and with it
 * the status, before the page has checked whether its story or text exists. Its `noindex` robots
 * tag, which Next.js adds to a not-found render, is what keeps it out of search results.
 */
export default function NotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-measure flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center"
    >
      <Heading as="p" size="small">
        404
      </Heading>
      <Heading level={1}>We couldn’t find that page</Heading>
      <Text tone="quiet">
        The story may have moved or is no longer published.
      </Text>
      <TextLink href="/" kind="standalone">
        Go to the home page
      </TextLink>
    </main>
  );
}
