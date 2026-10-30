# legal

The words people agree to, versioned. Two legal documents (D121): the **privacy policy** and the
**terms of use**, each a PDF of record plus the words the site shows. And the consent forms, which
since version 2 are tick boxes with a short introduction (D122). Every file is one version, frozen
once published: the migration (`libs/database/schema/dpa-sync.surql`, `form-sync.surql`) refuses to
migrate if a published version's file changes. Publish a new version instead.

**The real privacy policy and terms aren't kept here.** An Admin publishes them at `/admin/legal`
(api-admin): it numbers them `v<n>` and stores the PDF exactly as uploaded (the record, D123:
admins are trusted, nothing is scanned or rewritten) in the write-once legal documents bucket. Only dev's placeholders below are files.

| Path                                | What                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `dpa/<id>.md`, `dpa/<id>.pdf`       | The privacy policy (D20, D121): `dpaVersion:<id>`                       |
| `terms/<id>.md`, `terms/<id>.pdf`   | The terms of use (D121): `termsVersion:<id>`                            |
| `forms/signup/<id>.md`              | The sign-up consent form (D73, D84): `signupFormVersion:<id>`           |
| `forms/testimony/<id>.md`           | The testimony consent form (D67, D84): `testimonyFormVersion:<id>`      |
| `forms/social/<id>.md`              | The optional social sharing form (D93): `socialSharingFormVersion:<id>` |
| `forms/<kind>/<id>.statements.json` | D114: that version's boxes, as data (below)                             |

How a text reaches people:

- OpenTofu (`infra/terraform/modules/db-migration`) passes each file's words and sha256 to the
  migration, which keeps a copy in the version's row (`text`, `contentHash` / `textHash`). A
  draft follows its file; a published version is frozen.
- api-public-read serves the published versions: `GET /v1/legal/documents/{privacy|terms}` (every
  version, newest first, with its PDF's hash), each PDF at
  `GET /v1/legal/documents/{document}/versions/{id}.pdf`, `GET /v1/legal/dpa` and
  `GET /v1/legal/forms/{signup|testimony|social}`. web shows them at `/privacy` and `/terms`.
- A version kept here with a PDF: the migration attaches the PDF's sha256 once, and OpenTofu
  uploads the file to `legal/<privacy|terms>/<id>/<sha256>.pdf`. The placeholder PDFs come from
  `tools/scripts/legal-placeholder-pdfs.mjs` (`--check` proves they are unchanged).
- Every consent event names the form version shown, the statement ticked and the privacy policy
  in force (and, on sign-up, the terms in force). Its evidence hash
  (`heisreal-consent-evidence/v4` since D122, `libs/consent/src/lib/evidence.ts`) covers the form
  text's and the statements file's sha256 and each document's version and PDF sha256, so it can be
  checked against the PDFs later (older rows: v3 without the PDFs, v2 without the statements
  file, v1 without a form).

**The boxes are data, not text (D114, Joel: "a check box should be separate, outside the form and
always guaranteed by the page structure rather than the document's content").** Each form
version has `<id>.statements.json` beside its text:

```json
{ "statements": [{ "key": "age_18plus", "label": "I am 18 or over." }, …] }
```

- `key` is a consent type; `label` is exactly the words shown beside its box. The pages draw the
  boxes from this, in this order, outside the document: nothing in a form's text can add, remove
  or change a box.
- A version must list exactly its statements, each once, each with words: the sign-up form has
  `age_18plus` and `account_data`, and from version 2 `terms_of_use` (`coversTerms`); the testimony form has `special_category_religious` and (when
  the version covers publishing) `publish`; the social sharing form has `share_socials`. The
  migration refuses a version whose file is missing or doesn't (`form-sync.surql`), so no page can
  be left without a box.
- The file is frozen with its version once published. The migration copies it into the version
  with its sha256 (`statementsHash`), and consent evidence v3 covers that hash, so the ledger
  proves the words beside the box that was ticked.
- Version 1's texts still list the boxes in their words (written before D114); later versions
  needn't. The text is a document to read, linked or shown beside the boxes.

Rules for the form texts:

- "I am 18 or over" is on the sign-up form only (D93); the testimony form relies on it. The site
  is for adults only, so there is no parental-consent wording (D77).
- A social sharing version's feature columns (`shareYouTube`, ..., `allowPaidPromotion`) must
  match what its words list, and its words must name every platform and use specifically (Art 9
  consent must be specific and informed): never "any use".
- An older version keeps counting for what it covered. A new version only gates what it adds
  (D93): a new platform needs a new social sharing version that people opt into.

## What's here now

- `dpa/v1.md`: an old draft placeholder, never published. Because `dpaVersion:v1` exists, the
  first privacy policy an Admin publishes becomes version 2.
- `dpa/dev_placeholder.md`, `forms/signup/v1.md`, `forms/testimony/v1.md`,
  `forms/social/v1.md`: dev's placeholder
  wording (D75), published only in dev (data script 0005, OpenTofu's `dev_legal_placeholders`),
  and counted only there. The lawyer-checked forms become version 2: version 1 is frozen in dev.
- `dpa/dev_seed.md`: the retired walking-skeleton fixture (decision 22).
- `dpa/dev_placeholder.pdf`, `terms/dev_placeholder.md` and `.pdf`, `forms/*/v2.md` and
  `v2.statements.json`: dev's placeholder documents and version 2 forms (data script 0007): the
  new sign-up wording with its terms box (D122), short introductions, the same testimony and
  sharing boxes.
