# Contributing

Thanks for your interest in He Is Real Today.

## Issues first

**Every pull request must be linked to an issue.** Open an issue describing the problem or idea
first, and wait for a maintainer to agree it's wanted before writing code. Pull requests without a
linked issue will be closed.

## What happens to your pull request

- Only members of the `@He-Is-Real/developers` team can push to this repository or merge.
- CI workflows on pull requests from outside contributors **do not run until a developer approves
  them**. This is deliberate; there's no need to ping.
- A pull request is merged only after a developer has reviewed it and CI has passed.

## Dependency updates

[Renovate](https://docs.renovatebot.com) (the Mend-hosted GitHub app) keeps dependencies up to
date; its settings are in [`.github/renovate.json5`](.github/renovate.json5). Dependabot no longer
opens version-update PRs. GitHub's Dependabot security alerts stay on, and Renovate reads them.

- **When:** once a week, Monday before 6am London time. Security fixes come straight away.
- **Every update waits three days** after its release before Renovate offers it, so a bad or
  hijacked release has time to be pulled. Only security fixes skip the wait. An update Renovate
  can't date (the distroless base image's digests on gcr.io) waits under "Pending Status Checks" on
  the Dependency Dashboard until someone ticks it. Docker Hub dates an image by its last push.
- **What arrives:** one PR per group, labelled `dependencies`: npm (every minor and patch update),
  OpenTofu providers (all roots and modules), Docker base images, GitHub Actions (still pinned by
  commit SHA), and the vendor CLIs in `mise.toml`. Each of
  OpenTofu, gitleaks and kubeconform gets its own PR that moves every copy of its version
  together (`mise.toml`, the workflows and `.github/actions/tofu`). At most 5 PRs are open at a
  time.
- **Minor and patch updates merge themselves** (squash, through GitHub's auto-merge) once the
  required `main` check passes. A provider update that merges this way still waits for the usual
  approval before `tofu-apply.yml` applies it.
- **These never merge themselves:** majors; GitHub Actions, which run in workflows that sign in
  to Google (check that the new SHA belongs to the release the comment names: the three-day wait
  dates a tag by its release, so it can't catch a tag that was moved to other code); OpenTofu itself (read its release notes first);
  gitleaks and kubeconform, whose download checksums in the workflows Renovate can't update
  (the PR says where to paste the new one, and CI fails until you do); and the SurrealDB and
  cloud-sdk images, which wait for approval even for a patch (back up and try dev first:
  [infra/k8s/surrealdb/README.md](infra/k8s/surrealdb/README.md)).
- **Approving a major:** open the **Dependency Dashboard** issue, find the update under
  "Pending Approval" and tick its box. Renovate opens the PR on its next run; review it and merge
  it like any other. nx and NestJS majors each come as one PR for the whole family.
- **Never offered:** Node majors (LTS only, chosen by hand; 24 now) and `@types/node` majors,
  which follow Node.

## Security

Please don't open public issues for security problems. Use GitHub's **private vulnerability
reporting** (Security tab → "Report a vulnerability") instead.

Never include real personal data, testimonies, or credentials in issues, pull requests or test
fixtures.
