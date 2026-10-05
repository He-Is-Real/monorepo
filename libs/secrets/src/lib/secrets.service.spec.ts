import { SecretAccessor, SecretsService } from './secrets.service';

function fakeClient(payloads: Record<string, string | Uint8Array | null>) {
  const accessSecretVersion = jest.fn(async ({ name }: { name: string }) => {
    if (!(name in payloads)) throw new Error(`NOT_FOUND: ${name}`);
    const data = payloads[name];
    return [{ payload: data === null ? {} : { data } }];
  });
  return {
    client: { accessSecretVersion } as unknown as SecretAccessor,
    accessSecretVersion,
  };
}

const NAME = 'projects/heisreal-dev/secrets/db-pass/versions/latest';

describe('SecretsService', () => {
  it('builds the full resource name and decodes bytes', async () => {
    const { client } = fakeClient({
      [NAME]: new TextEncoder().encode('s3cret'),
    });
    const secrets = new SecretsService(client, 'heisreal-dev');
    await expect(secrets.get('db-pass')).resolves.toBe('s3cret');
  });

  it('supports pinned versions', async () => {
    const pinned = NAME.replace('latest', '3');
    const { client } = fakeClient({ [pinned]: 'v3' });
    const secrets = new SecretsService(client, 'heisreal-dev');
    await expect(secrets.get('db-pass', '3')).resolves.toBe('v3');
  });

  it('caches successful reads', async () => {
    const { client, accessSecretVersion } = fakeClient({ [NAME]: 'x' });
    const secrets = new SecretsService(client, 'heisreal-dev');
    await secrets.get('db-pass');
    await secrets.get('db-pass');
    expect(accessSecretVersion).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures', async () => {
    const { client, accessSecretVersion } = fakeClient({});
    const secrets = new SecretsService(client, 'heisreal-dev');
    await expect(secrets.get('db-pass')).rejects.toThrow('NOT_FOUND');
    await expect(secrets.get('db-pass')).rejects.toThrow('NOT_FOUND');
    expect(accessSecretVersion).toHaveBeenCalledTimes(2);
  });

  it('fails instead of hanging when Secret Manager does not answer', async () => {
    const client = {
      accessSecretVersion: jest.fn(() => new Promise(() => undefined)),
    } as unknown as SecretAccessor;
    const secrets = new SecretsService(client, 'heisreal-dev', 20);
    await expect(secrets.get('db-pass')).rejects.toThrow(
      `Reading secret ${NAME} timed out after 20ms`,
    );
  });

  it('rejects an empty payload', async () => {
    const { client } = fakeClient({ [NAME]: null });
    const secrets = new SecretsService(client, 'heisreal-dev');
    await expect(secrets.get('db-pass')).rejects.toThrow('has no payload');
  });
});
