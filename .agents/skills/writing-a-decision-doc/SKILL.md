---
name: writing-a-decision-doc
description: >
  How to ask the owner to decide something, and how to answer the owner's questions in writing: one
  plain HTML decision doc in the project repository. Use whenever a decision at the database, API or
  behaviour level is needed, several questions are open at once, or the owner asked questions that
  need written answers. Also use when the owner answers on a decision doc and the page needs updating.
---

# Writing a decision doc

The wording follows the `writing-for-agents` skill (`.agents/skills/writing-for-agents/SKILL.md`). The rules below are about the page.

## Where and what

- A decision doc is one plain HTML page in the project repository's `context/research/` folder.
- It copies the CSS of an existing page there and loads no outside assets.
- Questions for the owner never go in a chat list and never in a hosted doc.
- Several decisions, or answers to the owner's questions, go on a page. One quick yes/no may be asked in chat.
- After every change to the page: commit, push, and open it in the owner's browser with `xdg-open <file>`.

## Each question

- It has its own id with a prefix no other page uses. Its title is the question in plain words.
- It carries level pills: "Database", "API", "Behaviour", or "No database change", "Docs only" and the like, so the owner sees what the answer touches.
- It says in plain words what happens today, what the problem is for a person or for the data, and what is being asked.
- It shows the current proposal only: options in a table (what it means, good, less good). No history, no struck-out or withdrawn text.
- It ends with a recommendation that weighs cost against benefit and prefers the simpler option.
- A question that changes what is stored has a database diagram. A question about structure has an architecture diagram.

## Order and compactness

- Open questions come first, the most important first.
- A real choice at the behaviour, database or API level comes before a wording or filing question.
- A question that settles many others comes before the ones it settles.
- An answered question leaves the open list. So does a question settled without the owner, for example one an earlier answer already covers.
- Each of those becomes one short line (the question in a few words, the outcome, the date) in a section at the end: "Answered" or "Settled without you".
- A compacted line keeps no options table, no problem text and no recommendation. It keeps the question's id and anchor, so old links still land.
- The page's opening counts say how many questions are open and how many are answered.

## The decided box

- An open question has no decided box and no empty placeholder for one. An open table row's answer cell is empty.
- When the owner decides, the decision is recorded in green with that question: the label "Decided", the date, the owner's exact words in quotes, and one sentence on what that means in practice.
- A compacted answered line carries those four things itself. It replaces the expanded question and any separate box.
- The label never contains a person's name.
- An answer that asks something back is not a decision. The page answers it under the question, in plain words, with a revised recommendation, and the question stays open.

## How to answer, and the footer

- The page ends with a short "How to answer" note: an id and a letter is enough, a range of rows may be confirmed at once, and rows not mentioned stay open.
- The footer names the tool, model and thinking mode "on behalf of" the owner, and the page's sources.

## Afterwards

- A decided answer is what the register row and the pull request's "Approved:" line cite (register rows: the `writing-the-reference` skill).
- The behaviour and direction lines that follow from a decision are written as the `writing-the-reference` skill says.
