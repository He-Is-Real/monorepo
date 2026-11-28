---
name: writing-for-agents
description: >
  How to write text that another AI agent will read and act on: behaviour and direction lines, AGENTS.md files,
  skills and their descriptions, briefs for sub-agents, code comments, pull-request descriptions, final reports
  and decision register rows. Use before writing or editing any of these. Covers what to include and what to
  leave out, wording, reasons and examples, structure, and what a brief or a report must contain. The line
  format and ids of the reference under docs/ are in writing-the-reference.
---

# Writing for agents

The reader is a capable agent that has none of your context. It has not seen your conversation, your tool calls
or the files you opened. It follows what you write closely and reads it literally.

Contents: What to include · Wording · Reasons and examples · Structure · Where it goes · By kind of text ·
Before you finish.

## What to include

1. Write only what the reader cannot find by reading the repository, or would not go and look for.
2. Keep a line only if the reader would act differently without it.
3. Give each fact one home. Elsewhere, point to it; do not say it again. Two versions of one rule leave the
   reader to pick one.
4. Say what is true now. Leave out dates, who decided, what it used to be and which option won. History is in
   git and the decision register. A record whose format asks for a date (a register row, a decided answer on a
   decision page) keeps it.
5. When something changes, rewrite the line in place and delete the old words everywhere. Delete a caution
   whose reason no longer holds.

## Wording

6. Use plain words and full sentences: one idea per sentence, active voice, present tense.
7. Use one word for one thing, the glossary's word where there is one.
8. Be exact: numbers with units, the command to run, the file path, the words on screen in quotes. "Run
   `pnpm docs:check`", not "check the docs".
9. When a person will read the text, give no id alone: a pull-request number, decision id or rule id comes after
   the words it points at. Use no label or short name you made up during the work.
10. Say what to do or what happens, not only what to avoid.
11. Write calmly. No capitals, bold or "IMPORTANT" to stress a line. If a line keeps being missed, shorten the
    file or turn the line into a check.
12. Keep "never" and "must" for rules with no exception. The reader treats "never" as absolute. If there is an
    exception, write the action wanted ("ask the owner before deleting data") or name the exception in the
    same line.
13. A rule that must hold every time is a check that runs (lint, CI, a refusal). The text explains the check.
14. Leave out "be thorough", "think hard", "double-check" and "keep going". Give a check to pass instead.

## Reasons and examples

15. Add a reason, in one sentence, when it changes what the reader does in a case the line does not name. Always
    give one for a "never" rule. Leave out a reason that only repeats the rule.
16. Add an example when a line holds a judgement word or has been misread. Use typical cases, not a list of
    edge cases.
17. When an example teaches a format, give three that differ, and mark them as examples. The reader copies an
    example closely.
18. Be as exact as the task is fragile. Give the exact command where one wrong step breaks something. Give the
    goal and the limits where many ways are fine.
19. Give one default, with the case where another choice applies. Not a menu.

## Structure

20. Put first what matters most: the general rule, then its exceptions, then rare details.
21. Use headings and bullets for separate rules, a numbered list for steps in order, a table for the same facts
    about many things, and a paragraph where ideas connect. Never a picture alone.
22. In a brief with long pasted material (a log, a document), put the material first inside named tags and the
    task after it.
23. Point at a file by path and at a rule by id, never by line number or heading text.
24. Sizes: the root `AGENTS.md` under 150 lines, a folder `AGENTS.md` at most 300 (no check counts it), a skill
    body under 500 (ours aim for 150). A file over 100 lines starts with a contents list. Link to detail files
    one level deep.

## Where it goes

- Needed on almost every task, and short: the root `AGENTS.md`. Commands, hard rules, things corrected twice.
- True for one folder: that folder's `AGENTS.md`, with a `CLAUDE.md` beside it holding `@AGENTS.md`.
- A procedure, or rules for some tasks only: a skill in `.agents/skills`.
- A fact about how the site or the system is: the reference under `docs/` (see writing-the-reference).
- True for one person or one machine: that person's own files, never the repository.

## By kind of text

**Folder `AGENTS.md`.** Only what is true in that folder and not obvious from its code: its commands, the
traps in it, the rules that apply there. Nothing the root `AGENTS.md` or a skill already says.

**Skill description.** Third person. Say what the skill does, then when to use it, main use first. Use the
words the task would contain. At most 1,024 characters.

**Skill body.** Standing instructions, not a story. Number the steps. End with the check to run.

**Brief for a sub-agent.** The reader starts with nothing but the brief and the repository's `AGENTS.md`. Say:

1. the goal, and what the result is for;
2. what done looks like, and the check that proves it;
3. what is already known or ruled out, and the paths of the files to read;
4. the limits: what not to change, and what needs the owner first;
5. what to send back, in what shape and how long, with the command run and its output as proof.

Hand over the file or the output itself; do not describe it. Repeat in the brief any rule that must reach the
reader.

**Code comment.** Say why the code is this way, or the limit the code does not show. Do not say what the next
line does. No history.

**Pull-request description, report or hand-off.** Outcome first. The reader must understand it alone. Say what
was checked, with the proof, and what was not. Say plainly what failed or was skipped. List what was removed.
Choose what to include; do not shorten by writing fragments or arrows.

**Behaviour line, direction line, register row.** The format is in writing-the-reference. The rules above
apply to the words.

## Before you finish

Read the text as a reader with none of your context. Cut each line that reader would not act on. If you
changed anything under `docs/`, run `pnpm docs:check`.
