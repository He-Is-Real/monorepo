#!/usr/bin/env python3
"""Applies the SurrealDB migration bundle (D14) as the `migrator` system user.

Ships in the bundle it applies (the surrealdb-migrate Job's ConfigMap; python3 from the pinned
google/cloud-sdk image) and runs, unchanged, in libs/database's integration tests. Standard
library only.

    migrate.py BUNDLE_DIR [--params FILE]

BUNDLE_DIR holds the files from libs/database/schema: flat (the Job's ConfigMap) or with the data
scripts in data/ (the repo). FILE (default BUNDLE_DIR/params.json) maps parameter names to values,
or null when not available yet; Terraform writes it.

Order, each step all-or-nothing:
  1. schema.surql, plus access-clerk.surql when clerk_jwt_public_key is set (otherwise the clerk
     access is removed), in ONE transaction: declarative, re-applied in full every time.
  2. Each data script NNNN-*.surql not yet in _migration, in number order, each in its own
     transaction that first creates its _migration row (id = file name, checksum = sha256 of the
     file). A failure rolls back the script and its row. A script that uses a parameter whose
     value is null is held back, with every later script, until the value exists.
  3. dpa-sync.surql, in one transaction.
  4. Optionally waits until the identities the init Job creates are in place
     (MIGRATE_EXPECT_USERS, MIGRATE_EXPECT_SERVICES).

Why not `surreal import`: on 3.2.4 it requires `OPTION IMPORT`, which turns off events and field
VALUE/ASSERT clauses, so data scripts would bypass the schema's rules. This uses the HTTP /rpc
`query` method instead (the one surrealdb.js uses), with parameters bound, never templated.

Environment: SURREAL_ENDPOINT (default http://surrealdb:8000), SURREAL_NAMESPACE,
SURREAL_DATABASE, SURREAL_USER, SURREAL_PASS, MIGRATE_WAIT_SECONDS (default 600).
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
# The runner owns the transactions. A top-level RETURN inside one commits it early and skips
# the rest of the script (3.2.4), so only indented RETURNs (inside blocks) are allowed.
FORBIDDEN = re.compile(r"^(BEGIN|COMMIT|CANCEL|RETURN|OPTION)\b", re.IGNORECASE | re.MULTILINE)
RESERVED_PARAMS = {"migration_id", "migration_checksum"}
SUMMARY_PREFIX = "MIGRATION SUMMARY "


class BundleError(Exception):
    """The bundle itself is wrong (exit 2)."""


class MigrationError(Exception):
    """A step failed in the database (exit 1)."""


def log(message):
    print(message, flush=True)


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


def run(client, label, sql, variables):
    """Runs SurrealQL; raises with the root cause if any statement failed."""
    try:
        results = client.query(sql, variables)
    except urllib.error.HTTPError as err:
        raise MigrationError(f"{label}: HTTP {err.code} {err.read().decode(errors='replace')[:500]}")
    failed = [r for r in results if r.get("status") != "OK"]
    if failed:
        # In a failed transaction every other statement reports NotExecuted; show the cause.
        cause = next(
            (r for r in failed if (r.get("details") or {}).get("kind") != "NotExecuted"), failed[0]
        )
        raise MigrationError(f"{label}: {cause.get('result')}")
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
        match = FORBIDDEN.search(text)
        if match:
            raise BundleError(f"{name}: top-level {match.group(1).upper()} (the runner owns transactions)")
    return top, dict(sorted(data.items()))


def uses(text, param):
    return re.search(r"\$" + re.escape(param) + r"\b", text) is not None


def migrate(client, top, data, params, deadline):
    variables = {k: v for k, v in params.items() if v is not None}
    summary = {"schemaStatements": 0, "clerk": "clerk_jwt_public_key" in variables,
               "applied": [], "alreadyApplied": [], "heldBack": []}

    def try_signin():
        try:
            client.signin()
            return None
        except urllib.error.HTTPError as err:
            return f"sign-in refused (HTTP {err.code}; the init Job creates the migrator)"
        except (urllib.error.URLError, OSError) as err:
            return f"SurrealDB not reachable ({getattr(err, 'reason', err)})"

    wait_until(deadline, "SurrealDB and the migrator user", try_signin)
    log(f"signed in as {client.user} on {client.namespace}/{client.database}")

    # 1. Declarative schema + Clerk access, atomically.
    access = top[CLERK] if summary["clerk"] else "REMOVE ACCESS IF EXISTS clerk ON DATABASE"
    results = run(client, SCHEMA, in_transaction(top[SCHEMA], access), variables)
    summary["schemaStatements"] = len(results) - 3  # minus BEGIN, the access statement, COMMIT
    log(f"{SCHEMA}: {summary['schemaStatements']} statements applied; clerk access "
        + ("defined" if summary["clerk"] else "removed (no clerk_jwt_public_key)"))

    # 2. Data scripts, each exactly once.
    rows = run(client, "_migration", "SELECT record::id(id) AS id, checksum FROM _migration", {})
    applied = {row["id"]: row.get("checksum") for row in rows[-1]["result"]}
    holding = None
    for name, text in data.items():
        script_id = name[: -len(".surql")]
        checksum = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if script_id in applied:
            if applied[script_id] != checksum:
                raise MigrationError(
                    f"{name} changed after it was applied: data scripts are run once; "
                    "restore it and add a new script instead"
                )
            summary["alreadyApplied"].append(script_id)
            continue
        missing = [p for p, v in params.items() if v is None and uses(text, p)]
        if holding is None and missing:
            holding = f"{name} needs {', '.join(missing)}"
        if holding is not None:
            summary["heldBack"].append(script_id)
            continue
        sql = in_transaction(
            "CREATE type::record('_migration', $migration_id) SET checksum = $migration_checksum",
            text,
        )
        run(client, name, sql, {**variables, "migration_id": script_id, "migration_checksum": checksum})
        summary["applied"].append(script_id)
        log(f"{name}: applied")
    for script_id in sorted(set(applied) - {n[: -len('.surql')] for n in data}):
        log(f"warning: _migration:{script_id} was applied but its script isn't in the bundle")
    if holding:
        log(f"HELD BACK: {', '.join(summary['heldBack'])} ({holding}; set it, then migrate again)")

    # 3. DPA hashes follow their files (D20).
    run(client, DPA_SYNC, in_transaction(top[DPA_SYNC]), variables)
    log(f"{DPA_SYNC}: done")

    # 4. The identities the init Job owns (D13 B): only these system users, and every service
    #    can sign in. Waits, because the init Job may still be running.
    expect_users = sorted(filter(None, os.environ.get("MIGRATE_EXPECT_USERS", "").split(",")))
    expect_services = sorted(filter(None, os.environ.get("MIGRATE_EXPECT_SERVICES", "").split(",")))
    if expect_users or expect_services:

        def identities_ready():
            info = run(client, "identities", "INFO FOR DB; SELECT VALUE record::id(id) FROM service WHERE secretHash != NONE", {})
            users = sorted(info[0]["result"]["users"].keys())
            services = set(info[1]["result"])
            problems = []
            if expect_users and users != expect_users:
                problems.append(f"system users are {users}, expected {expect_users}")
            if expect_services and not set(expect_services) <= services:
                problems.append(f"no service login yet for {sorted(set(expect_services) - services)}")
            return "; ".join(problems) or None

        wait_until(deadline, "the init Job's identities", identities_ready)
        log("identities: system users and service logins as expected")
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
        summary = migrate(client, top, data, params, deadline)
    except MigrationError as err:
        log(f"ERROR: {err}")
        log("Nothing from the failed step was kept (each step is one transaction).")
        return 1
    log(SUMMARY_PREFIX + json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
