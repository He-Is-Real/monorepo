#!/usr/bin/env python3
"""Applies the SurrealDB migration bundle (D14) as the `migrator` system user.

Ships in the bundle it applies (the surrealdb-migrate Job's ConfigMap; python3 from the pinned
google/cloud-sdk image) and runs, unchanged, in libs/database's integration tests. Standard
library only.

    migrate.py BUNDLE_DIR [--params FILE]

BUNDLE_DIR holds the files from libs/database/schema: flat (the Job's ConfigMap) or with the data
scripts in data/ (the repo). FILE (default BUNDLE_DIR/params.json) maps parameter names to values,
or null when not available yet; Terraform writes it.

Validate first, then mutate:
  0. Every file is scanned (strings, comments, blocks): a RETURN/BEGIN/COMMIT/CANCEL/OPTION
     statement outside a DEFINE body is refused, because on 3.2.4 a RETURN inside a transaction,
     even inside an IF or FOR block, commits it early and skips the rest. After each step the
     number of results must equal the number of statements, so an early exit is caught anyway.
  1. Read-only checks: the init's identities are in place (identity_hash marker, system users,
     service logins), no applied data script has changed, no newer bundle generation has run,
     and the DPA texts still match (dpa-sync.surql in a cancelled transaction).
  2. schema.surql, plus access-clerk.surql when clerk_jwt_public_key is set (otherwise the clerk
     access is removed), and the generation fence, in ONE transaction.
  3. Each data script NNNN-*.surql not yet in _migration, in number order, each in its own
     transaction that checks the fence and first creates its _migration row (id = file name,
     checksum = sha256 of the file). A failure rolls back the script and its row. A script that
     uses a parameter whose value is null is held back, with every later script.
  4. dpa-sync.surql, in one transaction.

Generation fence: MIGRATE_GENERATION (or params "generation"), an RFC 3339 time that Terraform
fixes when the bundle changes. The schema transaction refuses to run if a newer generation has
already been applied, and records its own in _migrationRun:current; every later transaction
refuses if another generation has taken over meanwhile, and writes the row too, so overlapping
runners conflict at commit instead of interleaving.

Why not `surreal import`: on 3.2.4 it requires `OPTION IMPORT`, which turns off events and field
VALUE/ASSERT clauses. This uses the HTTP /rpc `query` method (the one surrealdb.js uses), with
parameters bound, never templated.

Environment: SURREAL_ENDPOINT (default http://surrealdb:8000), SURREAL_NAMESPACE,
SURREAL_DATABASE, SURREAL_USER, SURREAL_PASS, MIGRATE_WAIT_SECONDS (default 600),
MIGRATE_GENERATION, MIGRATE_EXPECT_USERS, MIGRATE_EXPECT_SERVICES (comma-separated).
Exit status: 0 done (held-back scripts are reported, not an error), 1 failed, 2 bad bundle.
The password and tokens are never printed.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SCHEMA = "schema.surql"
CLERK = "access-clerk.surql"
DPA_SYNC = "dpa-sync.surql"
TOP_LEVEL = {SCHEMA, CLERK, DPA_SYNC}
DATA_NAME = re.compile(r"^\d{4}-[a-z0-9]+(-[a-z0-9]+)*\.surql$")
FORBIDDEN_STATEMENTS = {"RETURN", "BEGIN", "COMMIT", "CANCEL", "OPTION"}
RESERVED_PARAMS = {"migration_id", "migration_checksum", "migration_generation", "migration_bundle"}
SUMMARY_PREFIX = "MIGRATION SUMMARY "


class BundleError(Exception):
    """The bundle itself is wrong (exit 2)."""


class MigrationError(Exception):
    """A step failed in the database (exit 1)."""


def log(message):
    print(message, flush=True)


def scan(text):
    """Counts the top-level statements of SurrealQL text and finds forbidden statements.

    Tracks strings ('', "", backtick and angle-bracket ids), comments (--, //, #, /* */) and
    bracket depth. A keyword counts as a statement when it's the first token at the top level or
    inside a { } or ( ) block. Conservative: anything it can't parse is reported as a problem.
    Returns (statement_count, problems).
    """
    problems = []
    count = 0
    tokens_in_statement = 0
    top_keyword = None
    stack = [True]  # per depth: is the next token a statement start?
    i, n, line = 0, len(text), 1

    def token(word=None):
        nonlocal tokens_in_statement, top_keyword
        if len(stack) == 1 and tokens_in_statement == 0:
            top_keyword = word
        tokens_in_statement += 1
        stack[-1] = False

    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            i += 1
        elif c.isspace():
            i += 1
        elif text.startswith("--", i) or text.startswith("//", i) or c == "#":
            end = text.find("\n", i)
            i = n if end < 0 else end
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0:
                problems.append(f"line {line}: unterminated /* comment")
                break
            line += text.count("\n", i, end)
            i = end + 2
        elif c in "'\"`⟨":
            close = "⟩" if c == "⟨" else c
            j = i + 1
            while j < n and text[j] != close:
                j += 2 if text[j] == "\\" and c != "⟨" else 1
            if j >= n:
                problems.append(f"line {line}: unterminated {c}")
                break
            line += text.count("\n", i, j)
            token()
            i = j + 1
        elif c in "({[":
            token()
            stack.append(c != "[")
            i += 1
        elif c in ")}]":
            if len(stack) == 1:
                problems.append(f"line {line}: unbalanced {c}")
                break
            stack.pop()
            stack[-1] = False
            i += 1
        elif c == ";":
            if len(stack) == 1:
                if tokens_in_statement:
                    count += 1
                tokens_in_statement = 0
                top_keyword = None
            stack[-1] = True
            i += 1
        elif c.isalpha() or c == "_":
            j = i
            while j < n and (text[j].isalnum() or text[j] == "_"):
                j += 1
            word = text[i:j].upper()
            k = j
            while k < n and text[k] in " \t":
                k += 1
            is_key = k < n and text[k] == ":" and not text.startswith("::", k)  # { return: 1 }
            if stack[-1] and word in FORBIDDEN_STATEMENTS and not is_key and top_keyword != "DEFINE":
                problems.append(f"line {line}: {word} statement (the runner owns transactions)")
            token(word)
            i = j
        else:
            token()
            i += 1
    if len(stack) > 1 and not problems:
        problems.append("unbalanced brackets at end of file")
    if tokens_in_statement:
        count += 1
    return count, problems


class Client:
    def __init__(self, endpoint, namespace, database, user, password):
        self.endpoint = endpoint.rstrip("/")
        self.namespace = namespace
        self.database = database
        self.user = user
        self.password = password
        self.token = None

    def _post(self, path, body, timeout):
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
            headers["surreal-ns"] = self.namespace
            headers["surreal-db"] = self.database
        request = urllib.request.Request(
            self.endpoint + path, data=json.dumps(body).encode(), headers=headers, method="POST"
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)

    def signin(self):
        body = {"ns": self.namespace, "db": self.database, "user": self.user, "pass": self.password}
        self.token = None
        self.token = self._post("/signin", body, timeout=30)["token"]

    def query(self, sql, variables):
        body = {"id": 1, "method": "query", "params": [sql, variables]}
        reply = self._post("/rpc", body, timeout=600)
        if "error" in reply:
            raise MigrationError(reply["error"].get("message", str(reply["error"])))
        return reply["result"]


def run(client, label, sql, variables, check_count=True, cancelled=False):
    """Runs SurrealQL; raises with the root cause if any statement failed or some didn't run.

    cancelled=True: a transaction that ends in CANCEL (a dry run); its statements report
    "Cancelled", which isn't a failure.
    """
    try:
        results = client.query(sql, variables)
    except urllib.error.HTTPError as err:
        raise MigrationError(f"{label}: HTTP {err.code} {err.read().decode(errors='replace')[:500]}")
    failed = [
        r for r in results
        if r.get("status") != "OK" and not (cancelled and (r.get("details") or {}).get("kind") == "Cancelled")
    ]
    if failed:
        # In a failed transaction every other statement reports NotExecuted; show the cause.
        cause = next(
            (r for r in failed if (r.get("details") or {}).get("kind") != "NotExecuted"), failed[0]
        )
        raise MigrationError(f"{label}: {cause.get('result')}")
    expected, _ = scan(sql)
    if check_count and len(results) != expected:
        raise MigrationError(
            f"{label}: {len(results)} results for {expected} statements: something ended the "
            "transaction early, so it may have committed only part of the step"
        )
    return results


def in_transaction(*parts):
    return "BEGIN TRANSACTION;\n" + "\n;\n".join(parts) + "\n;\nCOMMIT TRANSACTION;"


def wait_until(deadline, what, attempt):
    """Retries attempt() (returns None when done, else a reason) until the deadline."""
    while True:
        reason = attempt()
        if reason is None:
            return
        if time.monotonic() > deadline:
            raise MigrationError(f"gave up waiting for {what}: {reason}")
        log(f"waiting for {what}: {reason}")
        time.sleep(5)


def load_bundle(bundle):
    top, data = {}, {}
    for directory in (bundle, bundle / "data"):
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.surql")):
            if path.name in TOP_LEVEL and directory == bundle:
                top[path.name] = path.read_text(encoding="utf-8")
            elif DATA_NAME.match(path.name):
                if path.name in data:
                    raise BundleError(f"{path.name} is in the bundle twice")
                data[path.name] = path.read_text(encoding="utf-8")
            else:
                raise BundleError(f"unexpected file {path} (data scripts are NNNN-name.surql)")
    for name in TOP_LEVEL:
        if name not in top:
            raise BundleError(f"{name} is missing from {bundle}")
    numbers = [name[:4] for name in data]
    duplicates = sorted({n for n in numbers if numbers.count(n) > 1})
    if duplicates:
        raise BundleError(f"data script numbers used twice: {', '.join(duplicates)}")
    for name, text in {**top, **data}.items():
        _, problems = scan(text)
        if problems:
            raise BundleError(f"{name}: {'; '.join(problems)}")
    return top, dict(sorted(data.items()))


def uses(text, param):
    return re.search(r"\$" + re.escape(param) + r"\b", text) is not None


FENCE_TAKE = """
IF (SELECT VALUE generation FROM ONLY _migrationRun:current) > <datetime> $migration_generation {
  THROW 'a newer migration (generation ' + <string> _migrationRun:current.generation + ') has already been applied: this bundle is stale';
};
UPSERT _migrationRun:current SET generation = <datetime> $migration_generation,
  bundle = $migration_bundle, startedAt = time::now() RETURN NONE"""
FENCE_HOLD = """
IF (SELECT VALUE generation FROM ONLY _migrationRun:current) != <datetime> $migration_generation {
  THROW 'superseded: another migration (generation ' + <string> _migrationRun:current.generation + ') took over';
};
UPDATE _migrationRun:current SET touchedAt = time::now() RETURN NONE"""


def migrate(client, top, data, params, generation, deadline):
    variables = {k: v for k, v in params.items() if v is not None and k != "generation"}
    fence = {}
    if generation:
        bundle_hash = hashlib.sha256(json.dumps([top, data], sort_keys=True).encode()).hexdigest()
        fence = {"migration_generation": generation, "migration_bundle": bundle_hash}
    summary = {"schemaStatements": 0, "clerk": "clerk_jwt_public_key" in variables,
               "applied": [], "alreadyApplied": [], "heldBack": []}

    def try_signin():
        try:
            client.signin()
            return None
        except urllib.error.HTTPError as err:
            return f"sign-in refused (HTTP {err.code}; SurrealDB's startup init creates the migrator)"
        except (urllib.error.URLError, OSError) as err:
            return f"SurrealDB not reachable ({getattr(err, 'reason', err)})"

    wait_until(deadline, "SurrealDB and the migrator user", try_signin)
    log(f"signed in as {client.user} on {client.namespace}/{client.database}")

    # 1. Validate first: nothing below changes the database.
    expect_identity = params.get("identity_hash")
    expect_users = sorted(filter(None, os.environ.get("MIGRATE_EXPECT_USERS", "").split(",")))
    expect_services = sorted(filter(None, os.environ.get("MIGRATE_EXPECT_SERVICES", "").split(",")))

    def tables():
        return run(client, "INFO FOR DB", "INFO FOR DB", {})[0]["result"]["tables"].keys()

    if expect_identity or expect_users or expect_services:

        def identities_ready():
            info = run(client, "identities", "INFO FOR DB", {})[0]["result"]
            problems = []
            if expect_identity:
                marker = None
                if "_identity" in info["tables"]:
                    marker = run(client, "identity", "SELECT VALUE hash FROM ONLY _identity:current", {})[0]["result"]
                if marker != expect_identity:
                    problems.append(f"SurrealDB hasn't restarted with identity config {expect_identity} yet (it has {marker})")
            users = sorted(info["users"].keys())
            if expect_users and users != expect_users:
                problems.append(f"system users are {users}, expected {expect_users}")
            if expect_services:
                services = set()
                if "service" in info["tables"]:
                    services = set(run(client, "services", "SELECT VALUE record::id(id) FROM service WHERE secretHash != NONE", {})[0]["result"])
                if not set(expect_services) <= services:
                    problems.append(f"no service login yet for {sorted(set(expect_services) - services)}")
            return "; ".join(problems) or None

        wait_until(deadline, "the startup init's identities", identities_ready)
        log("identities: as expected" + (f" (identity config {expect_identity})" if expect_identity else ""))

    existing = tables()
    applied = {}
    if "_migration" in existing:
        rows = run(client, "_migration", "SELECT record::id(id) AS id, checksum FROM _migration", {})
        applied = {row["id"]: row.get("checksum") for row in rows[0]["result"]}
    checksums = {name: hashlib.sha256(text.encode("utf-8")).hexdigest() for name, text in data.items()}
    for name in data:
        script_id = name[: -len(".surql")]
        if script_id in applied and applied[script_id] != checksums[name]:
            raise MigrationError(
                f"{name} changed after it was applied: data scripts are run once; "
                "restore it and add a new script instead"
            )
    for script_id in sorted(set(applied) - {n[: -len('.surql')] for n in data}):
        log(f"warning: _migration:{script_id} was applied but its script isn't in the bundle")
    if generation and "_migrationRun" in existing:
        newer = run(
            client, "_migrationRun",
            "RETURN (SELECT VALUE generation FROM ONLY _migrationRun:current) > <datetime> $migration_generation",
            fence,
        )[0]["result"]
        if newer:
            raise MigrationError(
                f"a newer migration has already been applied: this bundle (generation {generation}) is stale"
            )
    if "dpaVersion" in existing:
        # The sync's own checks, in a transaction that is then cancelled.
        sql = "BEGIN TRANSACTION;\n" + top[DPA_SYNC] + "\n;\nCANCEL TRANSACTION;"
        run(client, f"{DPA_SYNC} (check)", sql, variables, check_count=False, cancelled=True)
    log("checks passed: applying")

    # 2. Declarative schema + Clerk access + fence, atomically.
    access = top[CLERK] if summary["clerk"] else "REMOVE ACCESS IF EXISTS clerk ON DATABASE"
    parts = [top[SCHEMA], access] + ([FENCE_TAKE] if fence else [])
    run(client, SCHEMA, in_transaction(*parts), {**variables, **fence})
    summary["schemaStatements"], _ = scan(top[SCHEMA])
    log(f"{SCHEMA}: {summary['schemaStatements']} statements applied; clerk access "
        + ("defined" if summary["clerk"] else "removed (no clerk_jwt_public_key)"))

    # 3. Data scripts, each exactly once.
    holding = None
    for name, text in data.items():
        script_id = name[: -len(".surql")]
        if script_id in applied:
            summary["alreadyApplied"].append(script_id)
            continue
        missing = [p for p, v in params.items() if v is None and uses(text, p)]
        if holding is None and missing:
            holding = f"{name} needs {', '.join(missing)}"
        if holding is not None:
            summary["heldBack"].append(script_id)
            continue
        parts = ([FENCE_HOLD] if fence else []) + [
            "CREATE type::record('_migration', $migration_id) SET checksum = $migration_checksum",
            text,
        ]
        run(client, name, in_transaction(*parts),
            {**variables, **fence, "migration_id": script_id, "migration_checksum": checksums[name]})
        summary["applied"].append(script_id)
        log(f"{name}: applied")
    if holding:
        log(f"HELD BACK: {', '.join(summary['heldBack'])} ({holding}; set it, then migrate again)")

    # 4. DPA hashes follow their files (D20).
    run(client, DPA_SYNC, in_transaction(*([FENCE_HOLD] if fence else []), top[DPA_SYNC]), {**variables, **fence})
    log(f"{DPA_SYNC}: done")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--params", type=Path)
    args = parser.parse_args()
    try:
        top, data = load_bundle(args.bundle)
        params_path = args.params or args.bundle / "params.json"
        params = json.loads(params_path.read_text(encoding="utf-8"))
        if not isinstance(params, dict) or RESERVED_PARAMS & params.keys():
            raise BundleError(f"{params_path}: an object without {sorted(RESERVED_PARAMS)}")
        generation = os.environ.get("MIGRATE_GENERATION") or params.get("generation")
        if generation and not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z", generation):
            raise BundleError(f"generation {generation!r} isn't an RFC 3339 UTC time (…Z)")
    except (BundleError, OSError, ValueError) as err:
        log(f"ERROR (bundle): {err}")
        return 2
    env = os.environ
    client = Client(
        env.get("SURREAL_ENDPOINT", "http://surrealdb:8000"),
        env["SURREAL_NAMESPACE"],
        env["SURREAL_DATABASE"],
        env["SURREAL_USER"],
        env["SURREAL_PASS"],
    )
    deadline = time.monotonic() + float(env.get("MIGRATE_WAIT_SECONDS", "600"))
    try:
        summary = migrate(client, top, data, params, generation, deadline)
    except MigrationError as err:
        log(f"ERROR: {err}")
        log("Nothing from the failed step was kept (each step is one transaction); "
            "earlier steps of this run stay applied. See the README's recovery section.")
        return 1
    log(SUMMARY_PREFIX + json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
