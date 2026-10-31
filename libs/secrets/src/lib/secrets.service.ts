import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { withTimeout } from './timeout';

export const SECRET_MANAGER_CLIENT = Symbol('SECRET_MANAGER_CLIENT');
export const SECRETS_PROJECT = Symbol('SECRETS_PROJECT');
export const SECRET_ACCESS_TIMEOUT_MS = Symbol('SECRET_ACCESS_TIMEOUT_MS');

/**
 * Fail startup with a clear error instead of hanging when Google can't be
 * reached or credentials are invalid (e.g. an expired gcloud login).
 */
export const DEFAULT_SECRET_ACCESS_TIMEOUT_MS = 15_000;

/** After a refresh fails, the last good value is used for this long before trying again. */
export const REFRESH_RETRY_MS = 30_000;

interface CacheEntry {
  value: Promise<string>;
  /** When it was read. */
  at: number;
  /** A failed refresh: not before this. */
  retryAt: number;
}

/** The subset of the Secret Manager client we use; lets tests pass a fake. */
export type SecretAccessor = Pick<
  SecretManagerServiceClient,
  'accessSecretVersion'
>;

/**
 * Reads secrets from Google Cloud Secret Manager.
 *
 * Authentication is Application Default Credentials (ADC): `gcloud auth
 * application-default login` on a local developer machine, the attached service account on
 * Cloud Run, Workload Identity on GKE and Workload Identity Federation on-prem.
 * Values are cached for the life of the process (rotate by restarting), unless the caller
 * gives a `maxAgeMs`: then a value older than that is read again, so a corrected or rotated
 * secret is picked up without a redeploy. If that read fails, the last good value is kept and
 * the read is tried again after {@link REFRESH_RETRY_MS}; only a first read that fails fails.
 */
@Injectable()
export class SecretsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly logger = new Logger(SecretsService.name);

  constructor(
    @Inject(SECRET_MANAGER_CLIENT) private readonly client: SecretAccessor,
    @Inject(SECRETS_PROJECT) private readonly project: string,
    @Optional()
    @Inject(SECRET_ACCESS_TIMEOUT_MS)
    private readonly timeoutMs: number = DEFAULT_SECRET_ACCESS_TIMEOUT_MS,
  ) {}

  /**
   * Returns the payload of `secretId` (latest version unless pinned), read again once it is
   * older than `maxAgeMs` (if given).
   */
  get(
    secretId: string,
    version = 'latest',
    { maxAgeMs }: { maxAgeMs?: number } = {},
  ): Promise<string> {
    const name = `projects/${this.project}/secrets/${secretId}/versions/${version}`;
    const previous = this.cache.get(name);
    const now = Date.now();
    if (
      previous &&
      (maxAgeMs === undefined ||
        now - previous.at < maxAgeMs ||
        now < previous.retryAt)
    ) {
      return previous.value;
    }
    const entry: CacheEntry = {
      value: Promise.resolve(''),
      at: now,
      retryAt: 0,
    };
    entry.value = this.access(name).catch((err: unknown) => {
      const current = this.cache.get(name) === entry;
      // A first read that fails isn't cached, so a later call can retry.
      if (!previous) {
        if (current) this.cache.delete(name);
        throw err;
      }
      // A refresh that fails keeps the last good value, and is tried again shortly.
      this.logger.warn(
        `Refreshing secret ${name} failed; keeping the last value: ${(err as Error).message}`,
      );
      if (current) {
        this.cache.set(name, {
          ...previous,
          retryAt: Date.now() + REFRESH_RETRY_MS,
        });
      }
      return previous.value;
    });
    this.cache.set(name, entry);
    return entry.value;
  }

  private async access(name: string): Promise<string> {
    const [response] = await withTimeout(
      this.client.accessSecretVersion({ name }),
      this.timeoutMs,
      `Reading secret ${name}`,
    );
    const data = response.payload?.data;
    if (data === undefined || data === null) {
      throw new Error(`Secret ${name} has no payload`);
    }
    return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
  }
}
