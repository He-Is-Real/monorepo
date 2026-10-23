#!/usr/bin/env python3
"""Readiness check for SurrealDB's identities (D13 B): the identity-check sidecar.

SurrealDB's startup init (init.surql.tmpl) is one transaction, but the server starts even when
it fails, and /health is 200 during and after a failed import. This check is what makes the pod
Ready, on every start and every probe: it proves the init succeeded with the INTENDED
credentials, from the same Secret the init was rendered from (credentials.json, identity-hash):

  * migrator and backup sign in with their current passwords;
  * the system users are exactly backup and migrator, plus any in system-users.json (D49: in dev
    only, `dev_seed`), each signing in with its current password;
  * each service's stored hash matches its current password (crypto::argon2::compare, so it works
    before the schema defines `svc`), and once `svc` exists each service signs in through it;
  * _identity:current (the init's last write) equals the expected identity config hash.

On success it records _identity:verified = that hash (as the migrator), which the migrate Job
waits for, so the Job never needs a service password. While the pod isn't Ready its DNS record
is withdrawn, so services, the backup and the migrate Job can't reach a database whose
identities are wrong (fail closed).

    identity_check.py            one check: exit 0 ready, 1 not (the readinessProbe)
    identity_check.py --serve    the sidecar's main process: waits for SIGTERM

Environment: SURREAL_ENDPOINT (default http://127.0.0.1:8000), SURREAL_NAMESPACE,
SURREAL_DATABASE, IDENTITY_CREDENTIALS (default /init/credentials.json), IDENTITY_EXPECTED_FILE
(default /init/identity-hash; absent = no marker check, e.g. locally), IDENTITY_EXTRA_USERS
(default /init/system-users.json, {name: password}; absent = none: OpenTofu adds it only with
dev_seed_login). Standard library only.
Prints reasons, never a password or token.
"""

import json
import os
import signal
import sys
import urllib.error
import urllib.request

ENDPOINT = os.environ.get("SURREAL_ENDPOINT", "http://127.0.0.1:8000").rstrip("/")
NS = os.environ.get("SURREAL_NAMESPACE", "heisreal")
DB = os.environ.get("SURREAL_DATABASE", "main")


class NotReady(Exception):
    pass


def post(path, body, token=None):
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers.update({"Authorization": "Bearer " + token, "surreal-ns": NS, "surreal-db": DB})
    request = urllib.request.Request(ENDPOINT + path, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def signin(who, body):
    try:
        return post("/signin", body)["token"]
    except urllib.error.HTTPError as err:
        raise NotReady(f"{who} can't sign in with its current password (HTTP {err.code})")
    except (urllib.error.URLError, OSError) as err:
        raise NotReady(f"SurrealDB not reachable ({getattr(err, 'reason', err)})")


def query(token, sql, variables=None):
    reply = post("/rpc", {"id": 1, "method": "query", "params": [sql, variables or {}]}, token)
    if "error" in reply:
        raise NotReady(f"query failed: {reply['error'].get('message')}")
    results = reply["result"]
    for r in results:
        if r.get("status") != "OK":
            raise NotReady(f"query failed: {r.get('result')}")
    return [r["result"] for r in results]


def check():
    path = os.environ.get("IDENTITY_CREDENTIALS", "/init/credentials.json")
    try:
        with open(path, encoding="utf-8") as f:
            creds = json.load(f)
    except (OSError, ValueError) as err:
        raise NotReady(f"no credentials at {path} ({type(err).__name__})")
    expected = None
    expected_path = os.environ.get("IDENTITY_EXPECTED_FILE", "/init/identity-hash")
    if os.path.exists(expected_path):
        with open(expected_path, encoding="utf-8") as f:
            expected = f.read().strip() or None

    extra = {}
    extra_path = os.environ.get("IDENTITY_EXTRA_USERS", "/init/system-users.json")
    if os.path.exists(extra_path):
        try:
            with open(extra_path, encoding="utf-8") as f:
                extra = json.load(f)
        except (OSError, ValueError) as err:
            raise NotReady(f"unreadable {extra_path} ({type(err).__name__})")
        if not isinstance(extra, dict) or not all(
            isinstance(k, str) and k.isidentifier() and k not in ("backup", "migrator") and isinstance(v, str)
            for k, v in extra.items()
        ):
            raise NotReady(f"{extra_path} must map other user names to passwords")

    token = signin("migrator", {"ns": NS, "db": DB, "user": "migrator", "pass": creds["migrator"]})
    signin("backup", {"ns": NS, "db": DB, "user": "backup", "pass": creds["backup"]})
    for name, password in sorted(extra.items()):
        signin(name, {"ns": NS, "db": DB, "user": name, "pass": password})

    info = query(token, "INFO FOR DB")[0]
    users = sorted(info["users"].keys())
    expected_users = sorted(["backup", "migrator", *extra])
    if users != expected_users:
        raise NotReady(f"system users are {users}, expected {expected_users}")

    for name, password in sorted(creds["services"].items()):
        [matches] = query(
            token,
            "RETURN crypto::argon2::compare((SELECT VALUE secretHash FROM ONLY type::record('service', $name)) ?? '', $password)",
            {"name": name, "password": password},
        )
        if matches is not True:
            raise NotReady(f"service:{name}'s stored hash doesn't match its current password")
        if "svc" in info["accesses"]:
            signin(f"service:{name}", {"ns": NS, "db": DB, "ac": "svc", "name": name, "secret": password})

    if expected:
        current = None
        if "_identity" in info["tables"]:
            [current, verified] = query(
                token,
                "SELECT VALUE hash FROM ONLY _identity:current; SELECT VALUE hash FROM ONLY _identity:verified",
            )
        if current != expected:
            raise NotReady(f"identity config is {current}, expected {expected} (the startup init failed or hasn't run)")
        if verified != expected:
            query(token, "UPSERT _identity:verified SET hash = $hash, appliedAt = time::now()", {"hash": expected})


def main():
    if "--serve" in sys.argv[1:]:
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        while True:
            signal.pause()
    try:
        check()
    except NotReady as err:
        print(f"identity check: NOT READY: {err}", flush=True)
        return 1
    except Exception as err:  # never leak details that could include request bodies
        print(f"identity check: NOT READY: {type(err).__name__}", flush=True)
        return 1
    print("identity check: ready", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
