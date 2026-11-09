/**
 * The worker's identity on disk (W1-A): one directory per user, 0700, every file 0600.
 *
 *   ca.pem                    our authority's certificate (public): checks each new certificate
 *   identity.json             machine name, Google project, pool, provider, service account,
 *                             signing service URL (written by `worker-identity.sh enrol`)
 *   credentials.json          Google's standard external_account credential configuration
 *                             (GOOGLE_APPLICATION_CREDENTIALS for the worker and Dapr)
 *   certificate_config.json   names keys/current.pem as both certificate and key (never changes)
 *   keys/current.pem          the current certificate, then its private key, in one file.
 *                             Renewal renames a new file over it, so the old key is gone at once
 *                             and nothing ever sees a certificate without its key.
 *
 * Default place: $XDG_STATE_HOME/heisreal/worker-identity (~/.local/state/...), so it survives a
 * restart; WORKER_IDENTITY_DIR overrides it. Nothing here is ever printed.
 */
import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultIdentityDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env['WORKER_IDENTITY_DIR']) return env['WORKER_IDENTITY_DIR'];
  const state = env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state');
  return join(state, 'heisreal', 'worker-identity');
}

/** What enrol records about this machine's identity (no secrets). */
export interface IdentityInfo {
  machine: string;
  project: string;
  projectNumber: string;
  pool: string;
  provider: string;
  serviceAccount: string;
  signerUrl: string;
}

export interface CurrentPair {
  certificate: string;
  key: string;
  certPath: string;
  keyPath: string;
}

/** Writes a file readable by its owner only, atomically: a temporary name, then rename. */
async function writePrivate(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const file = await open(tmp, 'wx', 0o600);
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, path);
}

/** The one PEM block of this type in a file (the pair file holds a certificate and a key). */
function pemBlock(pem: string, type: string): string {
  const match = new RegExp(
    `-----BEGIN ${type}-----[A-Za-z0-9+/=\\s]+-----END ${type}-----`,
  ).exec(pem);
  if (!match) throw new Error(`no ${type.toLowerCase()} in the identity files`);
  return `${match[0]}\n`;
}

export class IdentityStore {
  constructor(readonly dir: string) {}

  get credentialsPath(): string {
    return join(this.dir, 'credentials.json');
  }
  get certificateConfigPath(): string {
    return join(this.dir, 'certificate_config.json');
  }
  private get keysDir(): string {
    return join(this.dir, 'keys');
  }
  /**
   * One fixed path for the pair. Dapr's Go client (cloud.google.com/go/auth v0.18.2,
   * internal/transport/cert/workload_cert.go) reads certificate_config.json once and keeps the
   * paths, but loads the files again on every TLS handshake, and its subject token reads them
   * again on every token refresh; Node's google-auth-library reads both on every refresh. So a
   * rename over this path reaches both without a restart (dapr-rotation.compat-spec.ts).
   */
  get pairPath(): string {
    return join(this.keysDir, 'current.pem');
  }

  /** Makes the directory (0700), refusing one anybody else can read. */
  async prepare(): Promise<void> {
    await mkdir(this.keysDir, { recursive: true, mode: 0o700 });
    for (const dir of [this.dir, this.keysDir]) {
      await chmod(dir, 0o700);
      const info = await stat(dir);
      if (
        typeof process.getuid === 'function' &&
        info.uid !== process.getuid()
      ) {
        throw new Error(`${dir} belongs to another user`);
      }
    }
  }

  async writeInfo(
    info: IdentityInfo,
    caPem: string,
    credentials: object,
  ): Promise<void> {
    await writePrivate(
      join(this.dir, 'identity.json'),
      JSON.stringify(info, null, 2),
    );
    await writePrivate(join(this.dir, 'ca.pem'), caPem);
    await writePrivate(
      this.credentialsPath,
      JSON.stringify(credentials, null, 2),
    );
  }

  async info(): Promise<IdentityInfo> {
    return JSON.parse(
      await readFile(join(this.dir, 'identity.json'), 'utf8'),
    ) as IdentityInfo;
  }

  async ca(): Promise<string> {
    return readFile(join(this.dir, 'ca.pem'), 'utf8');
  }

  /** The certificate and key certificate_config.json names now. */
  async current(): Promise<CurrentPair> {
    const config = JSON.parse(
      await readFile(this.certificateConfigPath, 'utf8'),
    ) as {
      cert_configs?: { workload?: { cert_path?: string; key_path?: string } };
    };
    const certPath = config.cert_configs?.workload?.cert_path;
    const keyPath = config.cert_configs?.workload?.key_path;
    if (!certPath || !keyPath)
      throw new Error('certificate_config.json is incomplete');
    const certificate = pemBlock(
      await readFile(certPath, 'utf8'),
      'CERTIFICATE',
    );
    const key = pemBlock(await readFile(keyPath, 'utf8'), 'PRIVATE KEY');
    return { certificate, key, certPath, keyPath };
  }

  /**
   * Makes a new pair current: certificate then key in one file, renamed over keys/current.pem
   * (writePrivate), so the old key is deleted in the same step. certificate_config.json always
   * names that path; it is written too, for a first enrolment.
   */
  async install(keyPem: string, certPem: string): Promise<void> {
    await writePrivate(this.pairPath, `${certPem.trim()}\n${keyPem.trim()}\n`);
    await writePrivate(
      this.certificateConfigPath,
      JSON.stringify(
        {
          cert_configs: {
            workload: { cert_path: this.pairPath, key_path: this.pairPath },
          },
        },
        null,
        2,
      ),
    );
  }

  /**
   * Files in keys/ that are neither the pair file nor named by certificate_config.json
   * (interrupted writes; an older layout's files once a renewal has replaced them).
   */
  async unused(): Promise<string[]> {
    const keep = new Set([this.pairPath]);
    try {
      const { certPath, keyPath } = await this.current();
      keep.add(certPath).add(keyPath);
    } catch {
      // No readable current pair: only the pair file is kept.
    }
    return (await readdir(this.keysDir))
      .map((name) => join(this.keysDir, name))
      .filter((path) => !keep.has(path));
  }

  async remove(paths: string[]): Promise<void> {
    await Promise.all(paths.map((path) => rm(path, { force: true })));
  }
}
