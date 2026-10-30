import type {
  FullConfig,
  Reporter,
  Suite,
  TestRun,
} from '@playwright/test/reporter';

/**
 * CI's shards (ci.yml, `--shard=k/n`) deal the suite out like cards: test i goes to shard
 * (i mod n) + 1, in Playwright's own order (device, file, test). Playwright's built-in split gives
 * each shard a contiguous block of devices instead, and the devices aren't equal work: a test
 * skipped on all but the behaviour devices (BEHAVIOUR_DEVICES, `test.skip(...)` at run time)
 * still counts towards its block, so the shards holding phone-320 and desktop-1280 got ~40% more
 * real tests and finished up to twice as late (pipeline speed review, P5). Dealt out, every
 * shard gets about the same share of every device.
 *
 * Only the split changes: each shard runs its tests exactly as a local run does, and without
 * `--shard` this does nothing. Every shard sees the same list, so each test lands in exactly one.
 */
export default class ShardBalance implements Reporter {
  async preprocess({
    config,
    suite,
    testRun,
  }: {
    config: FullConfig;
    suite: Suite;
    testRun: TestRun;
  }) {
    const shard = config.shard;
    if (!shard) return;
    testRun.skipSharding();
    suite.allTests().forEach((test, i) => {
      if (i % shard.total !== shard.current - 1) testRun.exclude(test);
    });
  }

  printsToStdio() {
    return false;
  }
}
