import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';

/**
 * Checks HTTP responses against an OpenAPI 3.1 contract in `openapi/` (D23: the contracts are
 * the source of truth). Used on both sides of a fake: api-public-read's integration tests check
 * what the real service answers, and web checks its e2e stub (apps/web/e2e/stub-api.mjs), so
 * the stub can't drift from the API with every test green.
 */
export interface ContractResponse {
  method: string;
  /** The request path, without the query string. */
  path: string;
  status: number;
  contentType: string | null;
  /** The parsed JSON body, or undefined when there is none. */
  body: unknown;
}

type Json = Record<string, unknown>;
const BASE = 'https://contracts.heisreal.invalid/';
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

/** The repository's libs/contracts/openapi, found from the working directory (tests run in a project). */
function openapiDir(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, 'libs/contracts/openapi');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir)
      throw new Error('libs/contracts/openapi not found');
  }
}

/** `/v1/stories/{slug}` → a regular expression for one path segment per parameter. */
const pathPattern = (template: string) =>
  new RegExp(
    `^${template
      .split(/\{[^}]+\}/)
      .map((part) => part.replace(/[.*+?^$()|[\]\\]/g, '\\$&'))
      .join('[^/]+')}$`,
  );

export class Contract {
  private readonly ajv = new Ajv2020({ strict: false, allErrors: true });
  private readonly docs = new Map<string, Json>();
  private readonly paths: { pattern: RegExp; template: string }[];

  /** `spec`: a file in libs/contracts/openapi, e.g. `api-public-read.yaml`. */
  constructor(private readonly spec: string) {
    // CommonJS: under nodenext the default import is the module; `.default` is the plugin.
    formats.default(this.ajv);
    const dir = openapiDir();
    for (const file of [spec, 'components.yaml']) {
      const doc = parseYaml(readFileSync(join(dir, file), 'utf8')) as Json;
      this.docs.set(file, doc);
      this.ajv.addSchema(doc, `${BASE}${file}`);
    }
    // Literal paths before templated ones (`/v1/tags` before `/v1/{x}`).
    this.paths = Object.keys(this.doc(spec)['paths'] as Json)
      .sort((a, b) => a.split('{').length - b.split('{').length)
      .map((template) => ({ template, pattern: pathPattern(template) }));
  }

  /** Every way the response breaks the contract; empty when it fits. */
  problems(r: ContractResponse): string[] {
    const where = `${r.method.toUpperCase()} ${r.path} → ${r.status}`;
    const path = this.paths.find((p) => p.pattern.test(r.path));
    if (!path) return [`${where}: the path isn't in ${this.spec}`];
    const pointer = `#/paths/${path.template.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    const [file, operation] = this.resolve(this.spec, pointer);
    const op = (operation as Json)[r.method.toLowerCase()] as Json | undefined;
    if (!op || !METHODS.includes(r.method.toLowerCase()))
      return [`${where}: the method isn't in ${this.spec}`];
    const responses = op['responses'] as Json;
    // An exact status, then its range (`5XX`), then `default` (OpenAPI 3.1).
    const key = [String(r.status), `${String(r.status)[0]}XX`, 'default'].find(
      (k) => k in responses,
    );
    if (!key) return [`${where}: status ${r.status} isn't in the contract`];
    const [responseFile, response] = this.resolve(
      file,
      `${pointer}/${r.method.toLowerCase()}/responses/${key}`,
    );
    const content = (response as Json)['content'] as Json | undefined;
    if (!content) {
      return r.body === undefined
        ? []
        : [`${where}: the contract has no body for this status`];
    }
    const type = (r.contentType ?? '').split(';')[0].trim();
    if (!(type in content))
      return [`${where}: content type "${type}" isn't in the contract`];
    const responsePointer = this.pointerOf(response as Json);
    const validate = this.ajv.getSchema(
      `${BASE}${responseFile}${responsePointer}/content/${type.replace(/\//g, '~1')}/schema`,
    );
    if (!validate) return [`${where}: no schema for ${type}`];
    if (validate(r.body)) return [];
    return (validate.errors ?? []).map(
      (e) => `${where}: body${e.instancePath} ${e.message}`,
    );
  }

  /** Checks a fetch Response (its body is read from a clone). */
  async check(method: string, response: Response): Promise<string[]> {
    const contentType = response.headers.get('content-type');
    const text = await response.clone().text();
    return this.problems({
      method,
      path: new URL(response.url).pathname,
      status: response.status,
      contentType,
      body: text === '' ? undefined : JSON.parse(text),
    });
  }

  private doc(file: string): Json {
    return this.docs.get(file) as Json;
  }

  /** Follows `$ref`s (to components.yaml too) from a JSON pointer; returns the file and object. */
  private resolve(file: string, pointer: string): [string, unknown] {
    let target: unknown = this.doc(file);
    for (const part of pointer.replace(/^#\//, '').split('/')) {
      target = (target as Json)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    const ref = (target as Json | undefined)?.['$ref'];
    if (typeof ref !== 'string') {
      this.located.set(target as Json, pointer);
      return [file, target];
    }
    const [refFile, refPointer] = ref.split('#');
    return this.resolve(
      refFile ? refFile.replace(/^\.\//, '') : file,
      `#${refPointer}`,
    );
  }

  private readonly located = new Map<Json, string>();
  private pointerOf(object: Json): string {
    return this.located.get(object) as string;
  }
}
