/**
 * @jest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import ts from 'typescript';
import { INPUT_REFUSALS, SYSTEM_CODES } from './api-user';

// Joel, 2026-11-09: "errors caused by user mistakes should be visible. errors where the backend is
// crashing or would be useful for attackers should be generic to the public (except for the
// restart countdown)". Web shows an API's own words only for codes in INPUT_REFUSALS; everything
// else gets the plain message. So that nothing a person could fix is hidden by accident, every
// code the APIs can answer web with must be in one list or the other: a new code fails here until
// someone decides which.
//
// The scan is a guard, not a proof. It reads the syntax of the files below (no type checker), and
// whatever it can't follow at an error site fails with file:line rather than being skipped. What it
// deliberately does not follow (accepted limits):
// - a body spread into an object (`{ ...body }`) or built at run time (`body[key] = …`): only a
//   `code` property written in an object literal counts;
// - a code passed through a method (`this.fail(code)`) or a function stored in an object: those
//   parameters fail as unresolved rather than being followed;
// - which of two same-named helpers a workspace import (`@heisreal/…`) means: callers are matched
//   by the imported name, so a call may be checked against both (stricter, never looser);
// - a helper re-exported by a barrel that imports it first (`import { f } …; export { f }`) or
//   reached through a namespace used as a value (`const { f } = ns`): those fail as unresolved;
// - exception classes other than ProblemException and `@nestjs/common`'s (e.g. a subclass) are
//   seen only through the object literals they build.

const ROOT = join(__dirname, '../../../..');
/** The services web calls, and the libs whose errors they answer with. */
const SOURCES = [
  'apps/api-user/src',
  'apps/api-admin/src',
  'libs/http/src',
  'libs/database/src',
  'libs/auth/src',
];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(name)
      ? [path]
      : [];
  });

/** A property's name, quoted or not (`code`, `'code'`, `"code"`). */
const propertyName = (p: ts.ObjectLiteralElementLike) =>
  (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
  (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))
    ? p.name.text
    : undefined;

/** `x`, `(x)`, `x as const`, `x satisfies T` → `x`. */
const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) ||
  ts.isAsExpression(e) ||
  ts.isSatisfiesExpression(e)
    ? unwrap(e.expression)
    : e;

/**
 * The exact forwarding expressions (`file:container:name`): the name passes on a code that was
 * written somewhere this scan already reads, so it holds no code of its own. Any other expression
 * in these containers is read like everywhere else.
 */
const FORWARDS = new Set([
  // `new ProblemException(status, code, …)`: the constructor's `code`, into its body
  'libs/http/src/lib/problem.filter.ts:ProblemException:code',
  // a Nest exception body's `code`, passed on into the problem
  'libs/http/src/lib/problem.filter.ts:coded:code',
]);

/** A workspace library (`@heisreal/http`): its importers may call any of the scanned helpers. */
const WORKSPACE = /^@heisreal\//;
const NEST = '@nestjs/common';

interface Scan {
  /** Every code at an error site, with where it was written. */
  codes: { code: string; at: string }[];
  /** Error sites whose code isn't a string this scan can see (`file:line`): each one fails. */
  unresolved: string[];
}

/**
 * Every answer's `code` in the scanned files: `code: …` in an object literal (a Nest exception's
 * body, a problem; plain, quoted or shorthand) unless it's a field error (it has a `pointer`: web
 * goes by the answer's code), and `new ProblemException(status, …, …)` however it's imported. A code
 * that's a name is followed to its `const` string (in the same file, or one imported by a relative
 * path), and a parameter to the arguments of every call of its function in any scanned file. A
 * Nest exception's body must be an object literal (or a const one) or a message. Anything else is
 * reported as unresolved.
 *
 * `texts` maps each scanned file to its text; `load` reads a file outside them that one imports.
 */
function scanFiles(
  texts: Map<string, string>,
  {
    label = (file: string) => file,
    load,
  }: { label?: (file: string) => string; load?: (file: string) => string } = {},
): Scan {
  const scan: Scan = { codes: [], unresolved: [] };
  const sources = new Map<string, ts.SourceFile | undefined>();
  const source = (file: string) => {
    if (!sources.has(file)) {
      let text = texts.get(file);
      if (text === undefined && load) {
        try {
          text = load(file);
        } catch {
          text = undefined;
        }
      }
      sources.set(
        file,
        text === undefined
          ? undefined
          : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
      );
    }
    return sources.get(file);
  };
  const scanned = () =>
    [...texts.keys()].map((f) => source(f) as ts.SourceFile);

  /** The file a relative import names, if it can be read. */
  const locate = (from: string, module: string) => {
    if (!module.startsWith('.')) return undefined;
    for (const candidate of [`${module}.ts`, `${module}/index.ts`]) {
      const file = normalize(join(dirname(from), candidate));
      if (source(file)) return file;
    }
    return undefined;
  };

  const at = (node: ts.Node) => {
    const file = node.getSourceFile();
    const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    return `${label(file.fileName)}:${line}`;
  };

  const moduleOf = (spec: ts.ImportSpecifier | ts.NamespaceImport) =>
    (
      (spec.parent.parent.parent as ts.ImportDeclaration)
        .moduleSpecifier as ts.StringLiteral
    ).text;

  /** The import binding a name has in its file, if it has one. */
  const importOf = (id: ts.Identifier) => {
    for (const s of id.getSourceFile().statements) {
      const b = ts.isImportDeclaration(s) && s.importClause?.namedBindings;
      if (b && ts.isNamedImports(b)) {
        const spec = b.elements.find((el) => el.name.text === id.text);
        if (spec) return spec;
      }
    }
    return undefined;
  };

  /** The name a class is known by where `e` uses it (through an import alias, if any). */
  const classNamed = (e: ts.Expression) => {
    e = unwrap(e);
    if (!ts.isIdentifier(e)) return undefined;
    const spec = importOf(e);
    return spec
      ? { name: (spec.propertyName ?? spec.name).text, module: moduleOf(spec) }
      : { name: e.text, module: undefined };
  };

  /** The string(s) `e` stands for, or undefined if it can't be told from the source. */
  const resolve = (
    e: ts.Expression,
    seen = new Set<ts.Node>(),
  ): string[] | undefined => {
    e = unwrap(e);
    if (ts.isStringLiteralLike(e)) return [e.text];
    if (!ts.isIdentifier(e) || seen.has(e)) return undefined;
    seen.add(e);
    return resolveName(e, seen);
  };

  /** The nearest declaration of the name, walking out from where it's used. */
  const declarationOf = (
    id: ts.Identifier,
  ):
    | { parameter: ts.SignatureDeclaration; index: number }
    | ts.VariableDeclaration
    | ts.ImportSpecifier
    | null
    | undefined => {
    for (
      let scope: ts.Node | undefined = id.parent;
      scope;
      scope = scope.parent
    ) {
      if (ts.isFunctionLike(scope)) {
        const index = scope.parameters.findIndex(
          (p) => ts.isIdentifier(p.name) && p.name.text === id.text,
        );
        if (index >= 0) return { parameter: scope, index };
      }
      const found = declarationIn(scope, id.text);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const resolveName = (
    id: ts.Identifier,
    seen: Set<ts.Node>,
  ): string[] | undefined => {
    const d = declarationOf(id);
    if (!d) return undefined;
    if ('parameter' in d) return resolveParameter(d.parameter, d.index, seen);
    return resolveDeclaration(d, seen);
  };

  /** `null`: the name is declared here in a way we can't follow; undefined: not declared here. */
  const declarationIn = (
    scope: ts.Node,
    name: string,
  ): ts.VariableDeclaration | ts.ImportSpecifier | null | undefined => {
    const statements =
      ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)
        ? scope.statements
        : undefined;
    if (!statements) return undefined;
    for (const s of statements) {
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) {
            return s.declarationList.flags & ts.NodeFlags.Const ? d : null;
          }
        }
      }
      if (ts.isImportDeclaration(s) && s.importClause?.namedBindings) {
        const b = s.importClause.namedBindings;
        if (ts.isNamedImports(b)) {
          const spec = b.elements.find((el) => el.name.text === name);
          if (spec) return spec;
        }
      }
    }
    return undefined;
  };

  const resolveDeclaration = (
    d: ts.VariableDeclaration | ts.ImportSpecifier,
    seen: Set<ts.Node>,
  ): string[] | undefined => {
    if (ts.isVariableDeclaration(d)) {
      return d.initializer ? resolve(d.initializer, seen) : undefined;
    }
    const file = locate(d.getSourceFile().fileName, moduleOf(d));
    const other = file && source(file);
    if (!other) return undefined;
    const name = (d.propertyName ?? d.name).text;
    for (const s of other.statements) {
      if (
        ts.isVariableStatement(s) &&
        s.declarationList.flags & ts.NodeFlags.Const &&
        s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const v = s.declarationList.declarations.find(
          (x) => ts.isIdentifier(x.name) && x.name.text === name,
        );
        if (v?.initializer && ts.isStringLiteralLike(unwrap(v.initializer))) {
          return [(unwrap(v.initializer) as ts.StringLiteralLike).text];
        }
      }
    }
    return undefined;
  };

  /** The function's name (a declaration, a method, or the const it's assigned to). */
  const functionName = (f: ts.SignatureDeclaration): string | undefined => {
    if (ts.isConstructorDeclaration(f)) {
      return ts.isClassLike(f.parent) ? f.parent.name?.text : undefined;
    }
    if (f.name && ts.isIdentifier(f.name)) return f.name.text;
    if (ts.isVariableDeclaration(f.parent) && ts.isIdentifier(f.parent.name)) {
      return f.parent.name.text;
    }
    return undefined;
  };

  /** Whether `id` names its own declaration or a property, rather than using a value. */
  const notAUse = (id: ts.Identifier) => {
    const p = id.parent;
    return (
      ((ts.isFunctionDeclaration(p) ||
        ts.isVariableDeclaration(p) ||
        ts.isClassDeclaration(p) ||
        ts.isParameter(p) ||
        ts.isPropertyAccessExpression(p) ||
        ts.isPropertyAssignment(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isPropertyDeclaration(p) ||
        ts.isPropertySignature(p) ||
        ts.isMethodSignature(p)) &&
        p.name === id) ||
      (ts.isQualifiedName(p) && p.right === id) ||
      ts.isImportSpecifier(p) ||
      // re-exported under the same name: its importers are found by that name
      (ts.isExportSpecifier(p) &&
        (p.propertyName ?? p.name).text === p.name.text)
    );
  };

  /**
   * A parameter: the arguments of every call of its function, in its own file and in each scanned
   * file that imports it (under any alias). If the function is used any other way (passed as a
   * value, re-exported under another name, called as a method, reached through a namespace) the
   * parameter can't be followed.
   */
  const resolveParameter = (
    f: ts.SignatureDeclaration,
    index: number,
    seen: Set<ts.Node>,
  ): string[] | undefined => {
    const name = functionName(f);
    if (!name) return undefined;
    const home = f.getSourceFile();
    const codes: string[] = [];
    let calls = 0;
    let ok = true;
    /** Whether a relative module is `home`, or a barrel re-exporting it (`export * from …`). */
    const leadsHome = (
      file: string | undefined,
      seenFiles = new Set<string>(),
    ): boolean => {
      if (!file || seenFiles.has(file)) return false;
      if (file === home.fileName) return true;
      seenFiles.add(file);
      return (source(file)?.statements ?? []).some(
        (s) =>
          ts.isExportDeclaration(s) &&
          !!s.moduleSpecifier &&
          leadsHome(
            locate(file, (s.moduleSpecifier as ts.StringLiteral).text),
            seenFiles,
          ),
      );
    };
    for (const file of scanned()) {
      const local = new Set<string>(file === home ? [name] : []);
      const namespaces = new Set<string>();
      for (const s of file.statements) {
        if (file === home) break;
        if (
          !(ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) ||
          !s.moduleSpecifier
        )
          continue;
        const module = (s.moduleSpecifier as ts.StringLiteral).text;
        const fromHome =
          WORKSPACE.test(module) || leadsHome(locate(file.fileName, module));
        if (!fromHome) continue;
        if (ts.isExportDeclaration(s)) {
          // `export { refuse as deny } from …`: callers of `deny` aren't followed
          const e = s.exportClause;
          if (
            e &&
            ts.isNamedExports(e) &&
            e.elements.some(
              (el) =>
                (el.propertyName ?? el.name).text === name &&
                el.name.text !== name,
            )
          )
            ok = false;
          continue;
        }
        const b = s.importClause?.namedBindings;
        if (!b) continue;
        if (ts.isNamespaceImport(b)) namespaces.add(b.name.text);
        else
          for (const el of b.elements)
            if ((el.propertyName ?? el.name).text === name)
              local.add(el.name.text);
      }
      if (!local.size && !namespaces.size) continue;
      // `import { refuse } from …; export { refuse }`: a barrel's callers aren't followed
      if (file !== home)
        for (const s of file.statements)
          if (
            (ts.isExportDeclaration(s) &&
              !s.moduleSpecifier &&
              s.exportClause &&
              ts.isNamedExports(s.exportClause) &&
              s.exportClause.elements.some((el) =>
                local.has((el.propertyName ?? el.name).text),
              )) ||
            (ts.isExportAssignment(s) &&
              ts.isIdentifier(s.expression) &&
              local.has(s.expression.text))
          )
            ok = false;
      const visit = (node: ts.Node) => {
        // A namespace used as a value (`const { refuse } = h`, `f(h)`): not followed
        if (
          ts.isIdentifier(node) &&
          namespaces.has(node.text) &&
          !ts.isNamespaceImport(node.parent) &&
          !(
            ts.isPropertyAccessExpression(node.parent) &&
            node.parent.expression === node &&
            node.parent.name.text !== name
          )
        )
          ok = false;
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          namespaces.has(node.expression.text) &&
          node.name.text === name
        ) {
          ok = false; // through a namespace: not followed
        }
        if (ts.isIdentifier(node) && local.has(node.text) && !notAUse(node)) {
          const p = node.parent;
          if (
            (ts.isCallExpression(p) || ts.isNewExpression(p)) &&
            p.expression === node
          ) {
            calls++;
            const arg = p.arguments?.[index];
            const found = arg && resolve(arg, seen);
            if (found) codes.push(...found);
            else ok = false;
          } else {
            ok = false; // the function escapes: passed on, aliased, extended…
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    return ok && calls > 0 ? codes : undefined;
  };

  /** Whether `value` is one of the exact forwarding expressions in FORWARDS. */
  const forwards = (value: ts.Expression) => {
    value = unwrap(value);
    if (!ts.isIdentifier(value)) return false;
    const file = label(value.getSourceFile().fileName);
    for (let n: ts.Node | undefined = value; n; n = n.parent) {
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) {
        const name = ts.isClassLike(n) ? n.name?.text : functionName(n);
        if (name && FORWARDS.has(`${file}:${name}:${value.text}`)) return true;
      }
    }
    return false;
  };

  const site = (node: ts.Node, value: ts.Expression) => {
    if (forwards(value)) return;
    const found = resolve(value);
    if (found)
      for (const code of found) scan.codes.push({ code, at: at(node) });
    else scan.unresolved.push(at(node));
  };

  /** A Nest exception's body: a message, or an object literal (the visit reads its `code`). */
  const plainBody = (e: ts.Expression | undefined): boolean => {
    if (!e) return true;
    e = unwrap(e);
    if (
      ts.isStringLiteralLike(e) ||
      ts.isTemplateExpression(e) ||
      ts.isObjectLiteralExpression(e)
    )
      return true;
    if (!ts.isIdentifier(e)) return false;
    const d = declarationOf(e);
    return (
      !!d &&
      !('parameter' in d) &&
      ts.isVariableDeclaration(d) &&
      !!d.initializer &&
      plainBody(d.initializer)
    );
  };

  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = node.properties.map(propertyName);
      const code = node.properties.find((p) => propertyName(p) === 'code');
      if (code && !names.includes('pointer')) {
        if (ts.isPropertyAssignment(code)) site(code, code.initializer);
        else if (ts.isShorthandPropertyAssignment(code)) site(code, code.name);
      }
    }
    if (ts.isNewExpression(node)) {
      const made = classNamed(node.expression);
      if (made?.name === 'ProblemException') {
        const code = node.arguments?.[1];
        if (code) site(node, code);
        else scan.unresolved.push(at(node));
      } else if (
        made?.module === NEST &&
        made.name.endsWith('Exception') &&
        !plainBody(node.arguments?.[0])
      ) {
        scan.unresolved.push(at(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of scanned()) visit(file);
  return scan;
}

const { codes: found, unresolved } = scanFiles(
  new Map(
    SOURCES.flatMap((dir) => sourceFiles(join(ROOT, dir))).map((file) => [
      file,
      readFileSync(file, 'utf8'),
    ]),
  ),
  {
    label: (file) => relative(ROOT, file),
    load: (file) => readFileSync(file, 'utf8'),
  },
);
const answered = new Map(found.map(({ code, at }) => [code, at]));

test('finds the APIs’ codes (the scan still sees them)', () => {
  for (const code of [
    'validation_failed',
    'story_text_too_long',
    'if_match_required',
    'idempotency_key_required',
    'role_required',
    'document_changed',
    'service_restarting',
  ]) {
    expect(answered.has(code)).toBe(true);
  }
});

test('every code the APIs answer is an input refusal or a system code', () => {
  const unclassified = [...answered]
    .filter(([code]) => !INPUT_REFUSALS.has(code) && !SYSTEM_CODES.has(code))
    .map(([code, file]) => `${code} (${file})`);
  expect(unclassified).toEqual([]);
});

test('no code is in both lists', () => {
  expect([...INPUT_REFUSALS].filter((c) => SYSTEM_CODES.has(c))).toEqual([]);
});

test('every code at an error site can be read from the source', () => {
  expect(unresolved).toEqual([]);
});

describe('the scan sees a code however it is written', () => {
  /** Scans `probe.ts` (and any other in-memory files: `files` are scanned too). */
  const probe = (text: string, files: Record<string, string> = {}) =>
    scanFiles(new Map([['probe.ts', text], ...Object.entries(files)]));
  const codes = (text: string, files?: Record<string, string>) =>
    probe(text, files).codes.map((c) => c.code);

  test.each([
    ["{ code: 'x' }", "new BadRequestException({ code: 'x' })"],
    ["{ 'code': 'x' }", "new BadRequestException({ 'code': 'x' })"],
    ['{ "code": … }', 'new BadRequestException({ "code": `x` })'],
    ['a const', "const CODE = 'x'; new BadRequestException({ code: CODE })"],
    [
      'a const, as const',
      "const CODE = 'x' as const; throw new Error({ code: CODE })",
    ],
    [
      'shorthand',
      "const code = 'x'; new ForbiddenException({ code, message: 'm' })",
    ],
    ['ProblemException, a literal', "new ProblemException(400, 'x', 'T')"],
    [
      'ProblemException, a const',
      "const CODE = 'x'; new ProblemException(400, CODE, 'T')",
    ],
    [
      'ProblemException, imported under another name',
      "import { ProblemException as P } from '@heisreal/http'; new P(400, 'x', 'T')",
    ],
    [
      'a helper’s parameter',
      "const fail = (c: string) => new ProblemException(400, c, 'T'); fail('x');",
    ],
  ])('%s', (_form, text) => {
    expect(codes(text)).toEqual(['x']);
  });

  test('an imported const', () => {
    expect(
      codes(
        "import { CODE } from './codes'; new ProblemException(400, CODE, 'T')",
        { 'codes.ts': "export const CODE = 'x';" },
      ),
    ).toEqual(['x']);
  });

  const helper =
    "export const refuse = (c: string) => new ProblemException(400, c, 'T');";

  test('an exported helper, called from other files under any name', () => {
    expect(
      codes(helper, {
        'a.ts': "import { refuse } from './probe'; refuse('x');",
        'b.ts': "import { refuse as no } from '@heisreal/http'; no('y');",
        'index.ts': "export * from './probe';",
        'c.ts': "import { refuse } from './index'; refuse('z');",
      }).sort(),
    ).toEqual(['x', 'y', 'z']);
  });

  test('a field error (it has a pointer) is not an answer', () => {
    expect(probe("[{ pointer: '/a', code: 'x', message: 'm' }]")).toEqual({
      codes: [],
      unresolved: [],
    });
  });

  test('a Nest exception with a message or an object body is read as usual', () => {
    expect(
      probe(
        "import { NotFoundException as N } from '@nestjs/common'; const body = { code: 'x' }; new N(); new N('m'); new N(body);",
      ),
    ).toEqual({ codes: [{ code: 'x', at: 'probe.ts:1' }], unresolved: [] });
  });

  test.each([
    ['a let', "let CODE = 'x'; new BadRequestException({ code: CODE })"],
    ['an unknown name', 'new BadRequestException({ code: CODE })'],
    ['a computed code', "new ProblemException(400, 'x' + y, 'T')"],
    [
      'an unread import',
      "import { CODE } from 'elsewhere'; new BadRequestException({ code: CODE })",
    ],
    ['a parameter never called', 'const fail = (code: string) => ({ code });'],
    [
      'an aliased ProblemException with a computed code',
      "import { ProblemException as P } from '@heisreal/http'; new P(400, f(), 'T')",
    ],
    [
      'an aliased Nest exception with a body built elsewhere',
      "import { BadRequestException as B } from '@nestjs/common'; new B(makeBody())",
    ],
  ])('%s fails with where it is', (_form, text) => {
    expect(probe(text)).toEqual({ codes: [], unresolved: ['probe.ts:1'] });
  });

  test.each([
    [
      'called from another file with an unknown code',
      { 'a.ts': "import { refuse } from './probe'; refuse(code());" },
    ],
    [
      'passed as a value in another file',
      { 'a.ts': "import { refuse } from './probe'; [1].forEach(refuse);" },
    ],
    [
      're-exported under another name',
      { 'a.ts': "export { refuse as deny } from './probe';" },
    ],
    [
      'reached through a namespace',
      { 'a.ts': "import * as h from '@heisreal/http'; h.refuse('x');" },
    ],
    [
      're-exported by a barrel that imports it first',
      {
        'b.ts': "import { refuse } from './probe'; export { refuse };",
        'a.ts': "import { refuse } from './b'; refuse('x');",
        'c.ts': "import { refuse } from './probe'; refuse('known');",
      },
    ],
    [
      'taken out of a namespace',
      {
        'a.ts':
          "import * as h from './probe'; const { refuse } = h; refuse('x');",
        'c.ts': "import { refuse } from './probe'; refuse('known');",
      },
    ],
  ])('an exported helper %s fails where its code is', (_form, files) => {
    expect(probe(helper, files).unresolved).toEqual(['probe.ts:1']);
  });

  test('only the exact forwarding name is exempt inside a forwarding container', () => {
    const file = 'libs/http/src/lib/problem.filter.ts';
    const scan = scanFiles(
      new Map([
        [
          file,
          `export class ProblemException {
             constructor(status: number, code: string) { super({ code }); }
           }
           function coded(body: unknown) {
             const { code } = body as { code: string };
             return [{ code }, { code: other() }];
           }`,
        ],
      ]),
    );
    expect(scan.unresolved).toEqual([`${file}:6`]);
  });
});
