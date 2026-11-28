---
name: writing-the-reference
description: >
  The format of the project's reference under docs/: the one-line shape of a behaviour or system rule, ids,
  approval tags, working agreements, opinions (principles), glossary terms, actors and the decision register.
  Use whenever you add, change or remove any rule, opinion, glossary term or register row under docs/, or move
  guidance into the reference. Ends with `pnpm docs:check`. For the wording itself, use writing-for-agents with
  it.
---

# Writing the reference

## Files

| File                                    | Holds                                  | Id                 |
| --------------------------------------- | -------------------------------------- | ------------------ |
| `docs/product/behaviour/<area>.md`      | behaviour rules                        | `REQ-<AREA>-<NNN>` |
| `docs/system/<area>.md`                 | system rules (architecture, data, API) | `REQ-<AREA>-<NNN>` |
| `docs/process/working-agreements.md`    | how we work                            | `WORK-<NNN>`       |
| `docs/product/principles.md`            | opinions                               | `PRIN-<NN>`        |
| `docs/product/glossary.md`, `actors.md` | terms, actors                          | the word itself    |
| `docs/decisions/register.md`            | one row per decision                   | the decision id    |

## How to write here

The words follow the `writing-for-agents` skill (`.agents/skills/writing-for-agents/SKILL.md`): read it first.
The rules below are the format this reference adds, and `pnpm docs:check` enforces the counts and banned words.

1. The lines are behaviours (their ids stay `REQ-…`). A behaviour line stays true if the site is rewritten on another stack. A line that fails that test is engineering detail: it goes in a code comment beside the code it describes. The short list of direction lines (`docs/system/direction.md`) is the one exception.
2. One behaviour per entry, on one line, at most 50 words and 2 sentences.
3. Trigger first, then who, then what happens. Present tense.
4. Glossary and actor names only. No soft words ("should", "usually", "generally", "appropriate", "where possible", "as needed", "TBD").
5. No dates, names, history ("used to", "previously", "no longer", "formerly", "superseded"), option letters or pull-request numbers. A line in a behaviour file (`docs/product/behaviour/`) or the direction page (`docs/system/direction.md`) ends with its approval tag; elsewhere the tag is optional.
6. Each promise is written once; everywhere else cites its id. Remove a specialised line when a broader line implies it so plainly that a reader would infer it from the broader line alone. A pull request that removes lines for this reason lists each removed line with the broader line that covers it.
7. Behaviour and direction lines are rewritten in this format, never kept in the owner's typed words. (The register's Source column quotes chat approvals as its template says.)
8. Add `Why:` only when it changes a case the rule does not name (always for an opinion). Add `Example:` or `Not:` only for a judgement word or a rule that was misread.
9. To change a rule: rewrite it in place, keep the id, delete the old words wherever they are, and add the register row, in the pull request that builds it.
10. Never link from the reference to a decision doc. The register is the only bridge.

## Ids

- Each rule file's first lines are a title, one line on who it covers and where the data is, and `Next id: <id>` (within the first 10 lines). A new rule takes that id; then raise `Next id:` by one.
- `REQ-<AREA>-<NNN>`: area is the file's 2 to 4 capital letters (`MOD`, `BRW`, `LOG`), number three digits. `WORK-<NNN>` and `PRIN-<NN>` likewise.
- A changed rule keeps its id. A removed rule's id is never used again.
- Files point at each other by id. Tests may quote the id they prove.

## Templates

**Rule** (behaviour, system or working agreement), one physical line, then up to three indented lines:

```
- **REQ-<AREA>-<NNN>** <When or While trigger,> <who or what> <what happens>. [<decision id>]
  Why: <one sentence>
  Example: <one typical case>
  Not: <the near-miss that is wrong>
```

| Part                | Rule                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                  | Required, from `Next id:`.                                                                                                                                                                                                                     |
| text                | Required. One behaviour, at most 2 sentences and 50 words.                                                                                                                                                                                     |
| `(planned)`         | Optional, just before the tag, when approved but not built. The pull request that builds it removes the word.                                                                                                                                  |
| `[<decision id>]`   | Required in the behaviour files and the direction page, optional elsewhere; last on the line. Exactly one id with a register row: a question id from a decision doc's decided box, an old id, or `J-YYYY-MM-DD` for an approval given in chat. |
| `Why:`              | Optional. One sentence, at most 25 words.                                                                                                                                                                                                      |
| `Example:` / `Not:` | Optional, one line each. Typical cases, not a full list.                                                                                                                                                                                       |

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

`Why:` and `Applies:` are required; `Except:` and the tag are optional; a tag is the last line.

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
