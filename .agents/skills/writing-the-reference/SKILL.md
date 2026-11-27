---
name: writing-the-reference
description: >
  The format of the project's reference under docs/: behaviour and system rules, working
  agreements, opinions (principles), glossary terms, actors and the decision register. Use whenever
  you add, change or remove any rule, opinion, glossary term or register row under docs/, or move
  guidance into the reference. Ends with `pnpm docs:check`.
---

# Writing the reference

## Where a piece of guidance goes

- Needed on almost every task, and short: the root `AGENTS.md`, one or two lines.
- A fact about how the site or the system is: the reference (`docs/product`, `docs/system`, `docs/process`).
- True for one folder only: a short `AGENTS.md` in that folder, with a `CLAUDE.md` beside it holding `@AGENTS.md`.
- A procedure with steps, or rules needed only for some tasks: a skill in `.agents/skills`.
- Must never be broken: a check that runs (lint, CI, a refusal), with the text as explanation only.
- True for one person or one machine: that person's own files, never the repo.

| File                                    | Holds                               | Id                 |
| --------------------------------------- | ----------------------------------- | ------------------ |
| `docs/product/behaviour/<area>.md`      | behaviour rules                     | `REQ-<AREA>-<NNN>` |
| `docs/system/direction.md`              | direction: what we build with today | `REQ-DIR-<NNN>`    |
| `docs/process/working-agreements.md`    | how we work                         | `WORK-<NNN>`       |
| `docs/product/principles.md`            | opinions                            | `PRIN-<NN>`        |
| `docs/product/glossary.md`, `actors.md` | terms, actors                       | the word itself    |
| `docs/decisions/register.md`            | one row per decision                | the decision id    |

## How to write here

1. Write only what an agent could not learn from the code and would get wrong without.
2. One home per fact. Everywhere else, cite the id; never restate.
3. One behaviour per entry, on one line, at most 50 words and 2 sentences.
4. Trigger first, then who, then what happens. Present tense.
5. Be exact: numbers, units, the words on screen in "quotes", glossary and actor names only. No soft words ("should", "usually", "generally", "appropriate", "where possible", "as needed", "TBD").
6. Say what happens. Keep "must" and "never" for hard rules. No capitals for emphasis.
7. Now only: no dates, names, history ("used to", "previously", "no longer", "formerly", "superseded"), option letters or pull-request numbers. End with the approval tag.
8. Add `Why:` only when it changes a case the rule does not name (always for an opinion). Add `Example:` or `Not:` only for a judgement word or a rule that was misread.
9. To change a rule: rewrite it in place, keep the id, delete the old words wherever they are, and add the register row, in the pull request that builds it.
10. A table for the same facts about many things; a numbered list for steps; never a picture alone.
11. Never link from the reference to a decision doc. The register is the only bridge.

## Ids

- Each rule file's first lines are a title, one line on who it covers and where the data is, and `Next id: <id>` (within the first 10 lines). A new rule takes that id; then raise `Next id:` by one.
- `REQ-<AREA>-<NNN>`: area is the file's 2 to 4 capital letters (`MOD`, `BRW`, `LOG`), number three digits. `WORK-<NNN>` and `PRIN-<NN>` likewise.
- A changed rule keeps its id. A removed rule's id is never used again.
- Files point at each other by id, never by line number or heading. Tests may quote the id they prove.

## Templates

**Rule** (behaviour, system or working agreement), one physical line, then up to three indented lines:

```
- **REQ-<AREA>-<NNN>** <When or While trigger,> <who or what> <what happens>. [<decision id>]
  Why: <one sentence>
  Example: <one typical case>
  Not: <the near-miss that is wrong>
```

| Part                | Rule                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                  | Required, from `Next id:`.                                                                                                                                                   |
| text                | Required. One behaviour, at most 2 sentences and 50 words.                                                                                                                   |
| `(planned)`         | Optional, just before the tag, when approved but not built. The pull request that builds it removes the word.                                                                |
| `[<decision id>]`   | Required, last on the line. Exactly one id with a register row: a question id from a decision doc's decided box, an old id, or `J-YYYY-MM-DD` for an approval given in chat. |
| `Why:`              | Optional. One sentence, at most 25 words.                                                                                                                                    |
| `Example:` / `Not:` | Optional, one line each. Typical cases, not a full list.                                                                                                                     |

**Register row**, in `docs/decisions/register.md`, newest first. No file per decision.

```
| Id | Date | Decided, in plain words | Now at | Status | Source |
```

| Column  | Rule                                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Id      | The decision id, unique in the register. A new decision doc picks a prefix the register does not use. `J-YYYY-MM-DD` (then `b`, `c`) for a chat approval. |
| Date    | The date in the decided box, `YYYY-MM-DD`.                                                                                                                |
| Decided | At most 20 words, readable alone.                                                                                                                         |
| Now at  | The rule ids or files it was written into, comma-separated; `removed` if it only removed something.                                                       |
| Status  | `approved, not built` · `in force` · `replaced by <id>` · `withdrawn`.                                                                                    |
| Source  | The decision doc's file name, or chat: "the words" (at most 25). The only place a decision doc is named.                                                  |

**Opinion**, in `docs/product/principles.md`:

```
## PRIN-<NN> <Short name>

<The position, one or two sentences, at most 40 words.>
Why: <one sentence, at most 25 words>
Applies: <where it bites>
Except: <the one allowed exception>
[<decision id>]
```

`Why:` and `Applies:` are required; `Except:` is optional; the tag is the last line.

**Glossary term**, in `docs/product/glossary.md`, alphabetical, no id and no tag:

```
- **<Term>**: <one sentence>. Code: `<name in code>`. Not: <words that must not be used for it>.
```

`Code:` and `Not:` are optional. `Not:` is the one place an old name may appear.

**Sizes.** A section under one `##` heading is at most 60 lines; a rule file at most 300. A file over 100 lines has a `## Contents` list in its first 20 lines. The root `AGENTS.md` stays under 150 lines.

## One change, end to end

1. The decision exists: a decided box in a decision doc, or an approval in chat.
2. In one pull request with the code and its tests: rewrite or add the rule line (keep the id when changing it), add the register row at the top, and delete any repeat elsewhere or replace it with the id.
3. Set the old row's status to `replaced by <new id>` if this was its only rule; otherwise leave it `in force`.
4. The pull request description says `Approved: <decision id>`; the reviewer checks the line says what was decided, no more and no less.
5. Check: run `pnpm docs:check` (add `--base origin/main` to check only what the branch changed, as CI does) and fix every message.

## Worked example

Decision `LG-9b`: input refusals and rate limits log long text in full, like errors. The pull request changes one line in `docs/system/logging.md`, keeping its id:

```
- - **REQ-LOG-014** When a request or job ends in an error, long text (story text, transcripts, request bodies) is logged in full. Otherwise it is logged as a keyed hash plus its length. [LG-2]
+ - **REQ-LOG-014** When a request or job ends in an error, an input refusal or a rate limit, long text (story text, transcripts, request bodies) is logged in full. In every other outcome, including not found and restarting, it is logged as a keyed hash plus its length. [LG-9b]
    Why: hashing long text only keeps log volume down. It is not a privacy measure.
```

and adds one row at the top of `docs/decisions/register.md`:

```
| LG-9b | 2026-11-24 | Input refusals and rate limits log long text in full, like errors | REQ-LOG-014 | in force | logging.html |
```

Files that cite `REQ-LOG-014` change nothing.
