#!/usr/bin/env python3
"""Applies the SurrealDB migration bundle (D14) as the `migrator` system user.

Ships in the bundle it applies (the surrealdb-migrate Job's ConfigMap; python3 from the pinned
google/cloud-sdk image) and runs, unchanged, in libs/database's integration tests. Standard
library only.

    migrate.py BUNDLE_DIR [--params FILE]

BUNDLE_DIR holds the files from libs/database/schema: flat (the Job's ConfigMap) or with the data
scripts in data/ (the repo). FILE (default BUNDLE_DIR/params.json) maps parameter names to values,
or null when not available yet; Terraform writes it.

Grammar (checked before anything runs; an allow-list, because 3.2.4 has more than one way to
skip statements silently: RETURN anywhere in a transaction ends it early (`[RETURN 1]`,
`1 + RETURN 1`, `IF … THEN RETURN … END`, blocks), and BREAK/CONTINUE inside an IF block skip
the rest of that block while the transaction goes on and commits):
  * data scripts and dpa-sync.surql: every statement, at the top level and inside IF / ELSE / FOR
    blocks, must start with one of ALLOWED_STATEMENTS; the words in REFUSED_WORDS may not appear
    anywhere outside strings and comments; a `;` anywhere but the top level or such a block (a
    block the scanner can't classify) is refused. tests: libs/database/integration, "allow-list";
  * schema.surql and access-clerk.surql: DDL only (every top-level statement is DEFINE or REMOVE);
    RETURN, BREAK and CONTINUE only inside a DEFINE (function, event, field and param bodies were
    tested: they can't end or skip the caller's transaction); BEGIN, COMMIT, CANCEL nowhere, and
    no OPTION statement.

Characters (review rounds 4 and 5): control and separator characters nowhere; outside string
literals only ASCII letters, digits, `_`, whitespace and PUNCTUATION (no `/`: regex literals can
hold quotes; no backslash, `@`, `%`, ...); no prefixed strings (r"", u'', d'', b"", s''); backtick and
angle-bracket identifiers without backslashes or line breaks. Whatever the scanner can't lex
exactly is refused.

Defence in depth, independent of the scanner, so a grammar gap can't be recorded as applied:
  * every step's transaction ends with `RETURN '<fresh random nonce>'`, a literal scripts can't
    reference: anything that ends the transaction early means the nonce never comes back;
  * before each step a _migrationPending:<step> row is committed; the step's own transaction ends
    with its _migration row (data scripts); the pending row is deleted only afterwards, in a
    separate statement, once the runner has verified every result (review round 4: a deletion
    inside the transaction could commit even when part of the script had been skipped);
  * a step counts as done only if the nonce is the last result before a successful COMMIT, every
    statement answered OK, the result count matches and (data scripts) a fresh read finds its
    _migration row. It
    counts as rolled back only if the server refused its COMMIT (verified, not assumed): then the
    pending row is removed and, for a retryable conflict, the step runs again (up to 3 attempts;
    3.2.4 refuses schema steps this way at times when a full-text index re-defined over rows), else
    the runner exits 1. Anything else (fewer results, a COMMIT that
    succeeded alongside a failure, no answer) means a partial commit is possible: the pending row
    stays, the runner exits 3, and every later run refuses to start until an operator has checked
    the data and deleted the row (infra/k8s/surrealdb/README.md, "If it fails").

Fencing (overlapping runners): each run first takes a token from the database
(_migrationRun:lock, incremented in a transaction), and every mutating transaction checks that
the token is still its own and writes the lock row, so a run that started later always wins: an
older one fails at its next check or at commit (write conflict). A rollback to an older bundle
is just a newer run.

Order, validate first:
  1. wait until the startup init's identities are verified (identity_hash: _identity:verified,
     written by the identity-check sidecar after it proved the intended credentials work), the
     system users are exactly MIGRATE_EXPECT_USERS and every MIGRATE_EXPECT_SERVICES has a login;
  2. take the token; refuse if a pending row exists (after waiting for an overtaken run to clean
     up); read-only checks: no applied data script changed, DPA texts still match (dpa-sync.surql
     in a cancelled transaction);
  3. schema.surql + the Clerk access (or its removal), one step;
  4. each data script not yet in _migration, in number order, one step each (a pending script that
     uses a parameter whose value is null is refused in step 2, before anything changes);
  5. dpa-sync.surql, one step.

Why not `surreal import`: on 3.2.4 it requires `OPTION IMPORT`, which turns off events and field
VALUE/ASSERT clauses. This uses the HTTP /rpc `query` method (the one surrealdb.js uses), with
parameters bound, never templated.

Environment: SURREAL_ENDPOINT (default http://surrealdb:8000), SURREAL_NAMESPACE,
SURREAL_DATABASE, SURREAL_USER, SURREAL_PASS, MIGRATE_WAIT_SECONDS (default 600),
MIGRATE_PENDING_WAIT_SECONDS (default 120), MIGRATE_EXPECT_USERS, MIGRATE_EXPECT_SERVICES.
Exit status: 0 done; 1 failed: a check failed (nothing changed) or a step's transaction was
confirmed aborted by the server; 2 bad bundle, nothing run; 3 partial commit possible or blocked
by one: manual recovery needed. The password and tokens are never printed.
"""

import argparse
import hashlib
import secrets
import unicodedata
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
DDL_FILES = {SCHEMA, CLERK}
DATA_NAME = re.compile(r"^\d{4}-[a-z0-9]+(-[a-z0-9]+)*\.surql$")
NEVER = {"BEGIN", "COMMIT", "CANCEL"}
# Data scripts and dpa-sync.surql (see the header): what the seeds and the sync need, nothing more.
ALLOWED_STATEMENTS = {"CREATE", "UPDATE", "UPSERT", "DELETE", "LET", "IF", "FOR", "THROW", "SELECT"}
REFUSED_WORDS = {
    "RETURN", "BREAK", "CONTINUE", "BEGIN", "COMMIT", "CANCEL", "OPTION", "SLEEP", "USE",
    "DEFINE", "REMOVE", "ALTER", "INFO", "KILL", "LIVE",
    "THEN", "END",  # IF … THEN … END: only brace blocks, which the scanner can classify
}
RESERVED_PARAMS = {"migration_id", "migration_checksum", "migration_token", "migration_bundle", "migration_step", "migration_current"}
SUMMARY_PREFIX = "MIGRATION SUMMARY "
# Characters SurrealDB may treat as line ends (ending a comment early) or that hide text: refused
# anywhere in a bundled file, strings included (review round 4: a U+2028 after `-- comment` made
# SurrealDB run a BREAK the scanner took for comment text).
SAFE_CONTROLS = {"\t", "\n", "\r"}
# Outside string literals and comments, the only characters the scanner positively recognises
# (besides ASCII letters, digits, `_` and whitespace). Everything else is refused, notably `/`
# (regex literals like /'/ can hold quotes and desynchronise a scanner; no division either), `\`,
# `@`, `%`, `&`, `^`, `~`. The schema also uses `|` (closures).
PUNCTUATION = {
    "data": set(";,.:(){}[]=!<>+-*$?"),
    "ddl": set(";,.:(){}[]=!<>+-*$?|"),
}


def forbidden_character(c):
    if c in SAFE_CONTROLS:
        return False
    return unicodedata.category(c) in ("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp")


class BundleError(Exception):
    """The bundle itself is wrong (exit 2)."""


class MigrationError(Exception):
    """A step failed and was rolled back, or a check failed (exit 1)."""


class RetryableCommitError(Exception):
    """The server refused a step's COMMIT with a retryable conflict: nothing was kept."""


# A step whose COMMIT is refused with a retryable conflict runs again, at most this often in all.
STEP_ATTEMPTS = 3


class PartialCommitError(Exception):
    """A step may have committed partly, or an earlier one did (exit 3)."""


def log(message):
    print(message, flush=True)


def scan(text, mode="data"):
    """Counts the top-level statements of SurrealQL text and checks the grammar (see the header).

    mode "data": the allow-list. mode "ddl": DEFINE/REMOVE only, RETURN/BREAK/CONTINUE only inside a
    DEFINE. Both: no BEGIN/COMMIT/CANCEL, no OPTION statement. "runner": counting only (the runner's
    own SQL). Tracks strings ('', "", backtick and angle-bracket ids), comments (--, //, #, /* */)
    and brackets; in data mode it also tells blocks (after IF, ELSE, FOR) from object or
    expression braces. Anything it can't parse is a problem. Returns (statement_count, problems).
    """
    problems = []
    count = 0
    tokens_in_statement = 0
    top_keyword = None
    # One frame per open bracket: [kind, statement_start, block_pending]. kind "top"/"block" hold
    # statements; "value" (object, expression, parentheses, array) doesn't.
    frames = [["top", True, False]]
    i, n, line = 0, len(text), 1

    def problem(message):
        problems.append(f"line {line}: {message}")

    def token(word=None):
        nonlocal tokens_in_statement, top_keyword
        frame = frames[-1]
        if len(frames) == 1 and tokens_in_statement == 0:
            top_keyword = word
            if mode == "ddl" and word not in ("DEFINE", "REMOVE"):
                problem(f"{word or 'this'} statement (only DEFINE/REMOVE here)")
        if mode == "data" and frame[0] in ("top", "block") and frame[1]:
            if word is None:
                problem("a statement that doesn't start with a keyword (not allowed in data scripts)")
            elif word not in ALLOWED_STATEMENTS:
                problem(f"{word} statement (data scripts allow only {', '.join(sorted(ALLOWED_STATEMENTS))})")
            if word in ("IF", "FOR"):
                frame[2] = True  # the next brace at this level is its block
        if word == "ELSE":
            frame[2] = True
        tokens_in_statement += 1
        frame[1] = False

    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            i += 1
        elif c in " \t\r":  # ASCII only: other spaces fall through and are refused
            i += 1
        elif text.startswith("--", i) or text.startswith("//", i) or c == "#":
            # Ends at LF or CR: never later than SurrealDB ends it (stricter is safe).
            end = min([k for k in (text.find("\n", i), text.find("\r", i)) if k >= 0] or [n])
            if mode != "runner" and any(not (" " <= ch <= "~" or ch == "\t") for ch in text[i:end]):
                problem("a character other than printable ASCII in a comment")
            i = end
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0:
                problem("unterminated /* comment")
                break
            if mode != "runner" and any(
                not (" " <= ch <= "~" or ch in SAFE_CONTROLS) for ch in text[i:end]
            ):
                problem("a character other than printable ASCII in a comment")
            line += text.count("\n", i, end)
            i = end + 2
        elif c in "'\"`⟨":
            if mode != "runner" and c in "'\"" and i > 0 and (text[i - 1].isalnum() or text[i - 1] == "_"):
                # r"…", u'…', d'…', b"…", s'…' and future prefixes: not lexed, so refused.
                problem(f"a prefixed string literal ({text[i - 1]}{c}…{c})")
            close = "⟩" if c == "⟨" else c
            j = i + 1
            while j < n and text[j] != close:
                j += 2 if text[j] == "\\" and c not in "`⟨" else 1
            if j >= n:
                problem(f"unterminated {c}")
                break
            if mode != "runner" and c in "`⟨" and any(ch in "\\\r\n" for ch in text[i + 1 : j]):
                problem(f"a backslash or line break in a {c}…{close} identifier")
            line += text.count("\n", i, j)
            token()
            i = j + 1
        elif c in "({[":
            frame = frames[-1]
            if mode == "data":
                is_block = c == "{" and frame[2]
                if c == "{":
                    frame[2] = False  # only a brace consumes the IF/ELSE/FOR block flag
                token()
                frames.append(["block" if is_block else "value", is_block, False])
            else:
                token()
                frames.append(["block", c != "[", False])
            i += 1
        elif c in ")}]":
            if len(frames) == 1:
                problem(f"unbalanced {c}")
                break
            frames.pop()
            frames[-1][1] = False
            i += 1
        elif c == ";":
            frame = frames[-1]
            if mode == "data" and frame[0] == "value":
                problem("`;` inside a value: a block the scanner can't classify (use IF/FOR blocks)")
            if len(frames) == 1:
                if tokens_in_statement:
                    count += 1
                tokens_in_statement = 0
                top_keyword = None
            frame[1] = True
            frame[2] = False
            i += 1
        elif c.isascii() and (c.isalpha() or c == "_"):
            j = i
            while j < n and text[j].isascii() and (text[j].isalnum() or text[j] == "_"):
                j += 1
            word = text[i:j].upper()
            at_start = frames[-1][1]
            token(word)
            if mode == "data":
                if word in REFUSED_WORDS:
                    problem(f"{word} (not allowed anywhere in data scripts)")
            elif mode == "ddl":
                if word in NEVER:
                    problem(f"{word} (the runner owns transactions)")
                elif word == "OPTION" and at_start:
                    problem("OPTION statement")
                elif word in ("RETURN", "BREAK", "CONTINUE") and top_keyword != "DEFINE":
                    problem(f"{word} (only inside a DEFINE here)")
            i = j
        else:
            if mode != "runner" and not (c.isascii() and c.isdigit()) and c not in PUNCTUATION[mode]:
                if " " <= c <= "~":
                    problem(f"`{c}` outside a string (the runner can't lex it safely here)")
                else:
                    problem(f"character U+{ord(c):04X} outside a string (only printable ASCII here)")
            token()
            i += 1
    if len(frames) > 1 and not problems:
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


def root_cause(results):
    failed = [r for r in results if r.get("status") != "OK"]
    # In a failed transaction every other statement reports NotExecuted; show the cause.
    cause = next((r for r in failed if (r.get("details") or {}).get("kind") != "NotExecuted"), failed[0])
    return cause.get("result")


def run(client, label, sql, variables, cancelled=False):
    """Runs read-only or self-contained SurrealQL (not a migration step); raises on any failure.

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
        raise MigrationError(f"{label}: {root_cause(failed)}")
    expected, _ = scan(sql, "runner")
    if not cancelled and len(results) != expected:
        raise MigrationError(f"{label}: {len(results)} results for {expected} statements")
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
        time.sleep(2)


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
        for number, line_text in enumerate(text.split("\n"), start=1):
            bad = sorted({c for c in line_text if forbidden_character(c)})
            if bad:
                raise BundleError(
                    f"{name}: line {number}: control or separator character(s) "
                    + ", ".join(f"U+{ord(c):04X}" for c in bad)
                    + " (refused anywhere, strings included)"
                )
        _, problems = scan(text, "ddl" if name in DDL_FILES else "data")
        if problems:
            raise BundleError(f"{name}: {'; '.join(problems)}")
    return top, dict(sorted(data.items()))


def uses(text, param):
    return re.search(r"\$" + re.escape(param) + r"\b", text) is not None


# The bookkeeping tables, as in schema.surql, so the lease works before the schema exists.
BOOKKEEPING = """
DEFINE TABLE IF NOT EXISTS _migrationRun SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS token     ON _migrationRun TYPE int;
DEFINE FIELD IF NOT EXISTS bundle    ON _migrationRun TYPE string;
DEFINE FIELD IF NOT EXISTS takenAt   ON _migrationRun TYPE datetime;
DEFINE FIELD IF NOT EXISTS touchedAt ON _migrationRun TYPE option<datetime>;
DEFINE TABLE IF NOT EXISTS _migrationPending SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS token     ON _migrationPending TYPE int;
DEFINE FIELD IF NOT EXISTS startedAt ON _migrationPending TYPE datetime"""
TAKE_TOKEN = """
LET $previous = (SELECT VALUE token FROM ONLY _migrationRun:lock) ?? 0;
UPSERT _migrationRun:lock SET token = $previous + 1, bundle = $migration_bundle,
  takenAt = time::now(), touchedAt = NONE"""
# (3.2.4: a bare record path like _migrationRun:lock.token in an IF fails with "Specify a database
# to use"; SELECT … FROM ONLY works.)
FENCE = """
LET $migration_current = (SELECT VALUE token FROM ONLY _migrationRun:lock);
IF $migration_current != $migration_token {
  THROW 'superseded: a newer migration run (token ' + <string> $migration_current + ') has started';
};
UPDATE _migrationRun:lock SET touchedAt = time::now()"""


class Runner:
    def __init__(self, client, token, base_vars):
        self.client = client
        self.token = token
        self.vars = {**base_vars, "migration_token": token}

    def step(self, name, parts, extra_vars=None, marker=None):
        """Runs `attempt` until it succeeds, retrying (up to STEP_ATTEMPTS, short backoff) only when
        the server refused the step's COMMIT with a retryable transaction conflict: then nothing of
        the step was kept and its pending row is already cleared, so running it again is the same
        as a fresh run. 3.2.4 + RocksDB can refuse a schema step this way while it re-defines the
        full-text index on a table with rows (seen with publicStory). Anything else stops the run.
        """
        for attempt in range(1, STEP_ATTEMPTS + 1):
            try:
                return self.attempt(name, parts, extra_vars, marker)
            except RetryableCommitError as err:
                if attempt == STEP_ATTEMPTS:
                    raise MigrationError(str(err)) from err
                log(f"{name}: retryable conflict, the step was rolled back; retrying ({attempt}/{STEP_ATTEMPTS - 1})")
                time.sleep(0.5 * attempt)

    def attempt(self, name, parts, extra_vars=None, marker=None):
        """One mutating step: a pending row, the step's transaction, then (only once the runner has
        verified it) the pending row's deletion in a separate statement.

        The transaction's last statement returns a fresh random nonce, written into the SQL as a
        literal (scripts can't reference it). Anything that ends the transaction early, however
        the scanner missed it, means the nonce never comes back. The pending row is cleared only
        if the nonce is the last result before a successful COMMIT, every result is OK, the count
        matches, and (data scripts) a fresh read finds the _migration row. Anything else leaves
        the row, which blocks every later run until an operator has checked and cleared it.
        """
        variables = {**self.vars, **(extra_vars or {}), "migration_step": name}
        run(self.client, f"{name} (pending)", in_transaction(
            FENCE,
            "CREATE type::record('_migrationPending', $migration_step) SET token = $migration_token, startedAt = time::now()",
        ), variables)
        nonce = secrets.token_hex(16)
        sql = in_transaction(FENCE, *parts, f"RETURN '{nonce}'")
        expected, _ = scan(sql, "runner")
        try:
            results = self.client.query(sql, variables)
        except Exception as err:  # no answer: we can't know what committed
            raise PartialCommitError(f"{name}: no complete answer ({err})")
        all_ok = all(r.get("status") == "OK" for r in results)
        acknowledged = (
            len(results) >= 2
            and results[-2].get("status") == "OK"
            and results[-2].get("result") == nonce
            and results[-1].get("status") == "OK"  # the COMMIT
        )
        if acknowledged and all_ok and len(results) == expected:
            if marker is not None:
                stored = run(self.client, f"{name} (marker)",
                    "SELECT VALUE checksum FROM ONLY type::record('_migration', $migration_id)",
                    variables)[0]["result"]
                if stored != marker:
                    raise PartialCommitError(f"{name}: acknowledged, but its _migration row isn't there; its pending row stays")
            self.clear_pending(name, variables, "after the step's acknowledgement and checks")
            return
        commit = results[-1] if len(results) == expected else None
        if commit is not None and commit.get("status") != "OK":
            # The server refused the COMMIT (aborted transaction or write conflict): nothing from
            # the step was kept.
            self.clear_pending(name, variables, "after the server refused the step's COMMIT")
            message = (
                f"{name}: {root_cause(results)} (the server refused the step's COMMIT, so the "
                "step was rolled back; its pending row is cleared)"
            )
            if "can be retried" in root_cause(results):
                raise RetryableCommitError(message)
            raise MigrationError(message)
        raise PartialCommitError(
            f"{name}: no acknowledgement ({len(results)} results for {expected} statements"
            + ("" if acknowledged else ", the step's closing nonce never came back")
            + "): the step may have committed partly; its pending row stays"
        )

    def clear_pending(self, name, variables, why):
        cleared = run(self.client, f"{name} (clear pending)",
            "DELETE type::record('_migrationPending', $migration_step) WHERE token = $migration_token RETURN BEFORE",
            variables)[0]["result"]
        if len(cleared) != 1:
            raise PartialCommitError(f"{name}: its pending row wasn't there to clear ({why})")

def migrate(client, top, data, params, deadline):
    variables = {k: v for k, v in params.items() if v is not None}
    bundle_id = hashlib.sha256(json.dumps([top, data, params], sort_keys=True).encode()).hexdigest()
    summary = {"schemaStatements": 0, "clerk": "clerk_jwt_public_key" in variables,
               "applied": [], "alreadyApplied": [], "token": None, "bundle": bundle_id}

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

    # 1. The startup init's identities, verified with the intended credentials.
    expect_identity = params.get("identity_hash")
    expect_users = sorted(filter(None, os.environ.get("MIGRATE_EXPECT_USERS", "").split(",")))
    expect_services = sorted(filter(None, os.environ.get("MIGRATE_EXPECT_SERVICES", "").split(",")))
    if expect_identity or expect_users or expect_services:

        def identities_ready():
            info = run(client, "identities", "INFO FOR DB", {})[0]["result"]
            problems = []
            if expect_identity:
                verified = None
                if "_identity" in info["tables"]:
                    verified = run(client, "identity", "SELECT VALUE hash FROM ONLY _identity:verified", {})[0]["result"]
                if verified != expect_identity:
                    problems.append(
                        f"identity config {expect_identity} not verified yet (verified: {verified}); "
                        "the identity-check sidecar verifies it once SurrealDB restarted with it"
                    )
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
        log("identities: as expected" + (f" (identity config {expect_identity} verified)" if expect_identity else ""))

    # 2. The token, then read-only checks.
    lease = None
    for attempt in range(10):
        try:
            lease = run(client, "token", in_transaction(BOOKKEEPING, TAKE_TOKEN), {"migration_bundle": bundle_id})
            break
        except MigrationError as err:
            if "conflict" not in str(err).lower() or attempt == 9:
                raise
            time.sleep(0.2)
    token = lease[-2]["result"][0]["token"]
    summary["token"] = token
    runner = Runner(client, token, variables)
    log(f"token {token} (bundle {bundle_id[:12]})")

    pending_deadline = time.monotonic() + float(os.environ.get("MIGRATE_PENDING_WAIT_SECONDS", "120"))

    def no_pending():
        rows = run(client, "_migrationPending", "SELECT record::id(id) AS step, token, startedAt FROM _migrationPending", {})[0]["result"]
        if not rows:
            return None
        return ", ".join(f"{r['step']} (token {r['token']}, {r['startedAt']})" for r in rows)

    while (reason := no_pending()) is not None:
        if time.monotonic() > pending_deadline:
            raise PartialCommitError(
                f"blocked: unfinished step(s) {reason}. A run stopped without confirming whether that "
                "step committed. Check the data, then delete the _migrationPending row (README, "
                "'If it fails') and migrate again"
            )
        log(f"waiting for an overtaken run to clean up: {reason}")
        time.sleep(2)

    existing = run(client, "INFO FOR DB", "INFO FOR DB", {})[0]["result"]["tables"].keys()
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
    for name, text in data.items():
        missing = [p for p, v in params.items() if v is None and uses(text, p)]
        if name[: -len(".surql")] not in applied and missing:
            raise MigrationError(f"{name} uses {', '.join(missing)}, which Terraform passed as null: set it first")
    if "dpaVersion" in existing:
        # The sync's own checks, in a transaction that is then cancelled.
        sql = "BEGIN TRANSACTION;\n" + top[DPA_SYNC] + "\n;\nCANCEL TRANSACTION;"
        run(client, f"{DPA_SYNC} (check)", sql, variables, cancelled=True)
    log("checks passed: applying")

    # 3. Declarative schema + Clerk access, one step.
    access = top[CLERK] if summary["clerk"] else "REMOVE ACCESS IF EXISTS clerk ON DATABASE"
    runner.step("schema", [top[SCHEMA], access])
    summary["schemaStatements"], _ = scan(top[SCHEMA], "runner")
    log(f"{SCHEMA}: {summary['schemaStatements']} statements applied; clerk access "
        + ("defined" if summary["clerk"] else "removed (no clerk_jwt_public_key)"))

    # 4. Data scripts, each exactly once; the _migration row is the last write.
    for name, text in data.items():
        script_id = name[: -len(".surql")]
        if script_id in applied:
            summary["alreadyApplied"].append(script_id)
            continue
        runner.step(script_id, [
            text,
            "CREATE type::record('_migration', $migration_id) SET checksum = $migration_checksum",
        ], {"migration_id": script_id, "migration_checksum": checksums[name]}, marker=checksums[name])
        summary["applied"].append(script_id)
        log(f"{name}: applied")

    # 5. DPA hashes follow their files (D20).
    runner.step("dpa-sync", [top[DPA_SYNC]])
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
    except (BundleError, OSError, ValueError) as err:
        log(f"ERROR (bundle, nothing was run): {err}")
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
        summary = migrate(client, top, data, params, deadline)
    except PartialCommitError as err:
        log(f"ERROR: PARTIAL COMMIT POSSIBLE, MANUAL RECOVERY NEEDED: {err}")
        log("Migrations are blocked until the _migrationPending row is cleared "
            "(infra/k8s/surrealdb/README.md, 'If it fails').")
        return 3
    except MigrationError as err:
        log(f"ERROR: {err}")
        log("A failed check changes nothing; a failed step is reported as rolled back only when the "
            "server refused its COMMIT. Earlier steps of this run stay applied. See "
            "infra/k8s/surrealdb/README.md, 'If it fails'.")
        return 1
    log(SUMMARY_PREFIX + json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
