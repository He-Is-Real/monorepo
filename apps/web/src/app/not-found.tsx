import { Heading, Text } from '@heisreal/web-ui';
import { TextLink } from '@/components/page/text-link';

/**
 * An unknown address answers 404 with this page. When a page finds its story or text missing only
 * after it started streaming, the status has already gone out as 200 and this page answers 200
 * (PC-1); its `noindex` robots tag, which Next.js adds to a not-found render, is what keeps that
 * out of search results.
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
