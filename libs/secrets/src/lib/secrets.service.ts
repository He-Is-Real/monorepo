import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { withTimeout } from './timeout';

export const SECRET_MANAGER_CLIENT = Symbol('SECRET_MANAGER_CLIENT');
export const SECRETS_PROJECT = Symbol('SECRETS_PROJECT');
export const SECRET_ACCESS_TIMEOUT_MS = Symbol('SECRET_ACCESS_TIMEOUT_MS');

/**
 * Fail startup with a clear error instead of hanging when Google can't be
 * reached or credentials are invalid (e.g. an expired gcloud login).
 */
export const DEFAULT_SECRET_ACCESS_TIMEOUT_MS = 15_000;

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
 * Values are cached for the life of the process; rotate by restarting.
 */
@Injectable()
export class SecretsService {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(
    @Inject(SECRET_MANAGER_CLIENT) private readonly client: SecretAccessor,
    @Inject(SECRETS_PROJECT) private readonly project: string,
    @Optional()
    @Inject(SECRET_ACCESS_TIMEOUT_MS)
    private readonly timeoutMs: number = DEFAULT_SECRET_ACCESS_TIMEOUT_MS,
  ) {}

  /** Returns the payload of `secretId` (latest version unless pinned). */
  get(secretId: string, version = 'latest'): Promise<string> {
    const name = `projects/${this.project}/secrets/${secretId}/versions/${version}`;
    let value = this.cache.get(name);
    if (!value) {
      value = this.access(name);
      // Don't cache failures, so a later call can retry.
      value.catch(() => this.cache.delete(name));
      this.cache.set(name, value);
    }
    return value;
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
