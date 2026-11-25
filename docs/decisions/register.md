# Decision register

Every decision the reference rests on, one row each, newest first. To add one, put its row at the top
in the pull request that builds it, in the format in `.agents/skills/writing-the-reference/SKILL.md`.

| Id    | Date       | Decided, in plain words                                           | Now at                                                                      | Status   | Source                |
| ----- | ---------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- | -------- | --------------------- |
| KS-27 | 2026-11-25 | A skill, writing-the-reference, holds the format of the reference | .agents/skills/writing-the-reference/SKILL.md                               | in force | knowledge-system.html |
| KS-26 | 2026-11-25 | A script checks shape, sizes, ids, tags and banned patterns       | tools/scripts/docs-check.mjs                                                | in force | knowledge-system.html |
| KS-24 | 2026-11-25 | No history in the reference                                       | .agents/skills/writing-the-reference/SKILL.md, tools/scripts/docs-check.mjs | in force | knowledge-system.html |
| KS-23 | 2026-11-25 | A short tag on each rule; one register row holds the rest         | .agents/skills/writing-the-reference/SKILL.md, tools/scripts/docs-check.mjs | in force | knowledge-system.html |
| KS-22 | 2026-11-25 | One short reason line, only when it earns it                      | .agents/skills/writing-the-reference/SKILL.md, tools/scripts/docs-check.mjs | in force | knowledge-system.html |
| KS-21 | 2026-11-25 | A rule is one line with a tag                                     | .agents/skills/writing-the-reference/SKILL.md, tools/scripts/docs-check.mjs | in force | knowledge-system.html |
| KS-20 | 2026-11-25 | A short doctor script in two halves, repo and machine             | tools/scripts/agents-doctor.mjs                                             | in force | knowledge-system.html |
| KS-12 | 2026-11-25 | One real shared skills folder for every agent tool                | .agents/skills, .claude/skills                                              | in force | knowledge-system.html |
| KS-10 | 2026-11-25 | A decision register and a check script                            | docs/decisions/register.md, tools/scripts/docs-check.mjs                    | in force | knowledge-system.html |
| KS-3  | 2026-11-25 | One rule per bullet, trigger first                                | .agents/skills/writing-the-reference/SKILL.md, tools/scripts/docs-check.mjs | in force | knowledge-system.html |
| KS-2  | 2026-11-25 | Rules get stable ids; tests may quote them                        | .agents/skills/writing-the-reference/SKILL.md, tools/scripts/docs-check.mjs | in force | knowledge-system.html |
| J-2026-11-20-DB | 2026-11-20 | The largest picture file is a setting, 200 KiB to 20 MiB, 3 MiB by default, trusted people too | docs/system/data-permissions.md | in force | chat |
| J-2026-11-14-DB | 2026-11-14 | A story's picture has no description | docs/system/data-stories.md | in force | chat |
| J-2026-11-11-DB | 2026-11-11 | Story states: one append-only status entry per step; who may take which step; notes on send-back and reject | docs/system/data-story-log.md | in force | chat |
| J-2026-11-10-DB | 2026-11-10 | The system sends a story back when its video or audio file can't be used | docs/system/data-story-log.md | in force | chat |
| J-2026-11-07-API | 2026-11-07 | Database restarts answer 503 service_restarting with Retry-After; public reads serve their kept copy meanwhile | docs/system/api.md | in force | cloud-cost-and-pipelines.html |
| J-2026-11-07-DB | 2026-11-07 | Every media job is a database row written before it is queued; story changes write their check and render jobs | docs/system/data-media.md, docs/system/data-stories.md | in force | media-worker-final.html |
| J-2026-11-06b-DB | 2026-11-06 | Fix the database code leaks and trim the database notes as the agents judge best | docs/system/data-engine.md, docs/system/data-stories.md, docs/system/data-story-log.md | in force | chat: "fix the leaks, i trust you to decide what is best for the codebase" |
| J-2026-11-06-DB | 2026-11-06 | Search has its own table of published stories, with theme names and the list filter fields | docs/system/data-media.md | in force | search-drafts-decision.html |
| J-2026-11-01-DB | 2026-11-01 | Legal texts are immutable versions; people agree in their own session; the database enforces agree first | docs/system/data-permissions.md, docs/system/data-stories.md, docs/system/api.md | in force | privacy-consent-architecture.html |
| J-2026-10-31-DB | 2026-10-31 | Themes, categories and the theme catalog: everyone reads, api-admin writes; Other is fixed | docs/system/data-permissions.md | in force | themes-rebuild-plan.html |
| J-2026-10-30-DB | 2026-10-30 | No grandfathering: every later action meets the limits in force | docs/system/data-stories.md | in force | chat |
| J-2026-10-28-DB | 2026-10-28 | Submission settings and story text and theme limits are admin settings with fixed ceilings | docs/system/data-permissions.md, docs/system/data-stories.md | in force | m2-wave-b-ok.html |
| J-2026-10-25-DB | 2026-10-25 | Hearts are private to their owner; a heart needs the latest terms and a public story | docs/system/data-permissions.md | in force | m2-decisions.html |
| J-2026-10-23-DB | 2026-10-23 | An approved story whose media breaks or changes is hidden by the system and comes back when fixed | docs/system/data-story-log.md | in force | m1-open-decisions.html |
| M1-A2 | 2026-10-23 | Approval waits until every file is ready with its sizes and length | docs/system/data-stories.md | in force | m1-schema-assumptions.html |
