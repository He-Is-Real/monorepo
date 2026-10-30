-- dpa-sync.surql: on every migration, checked read-only before anything changes, then run
-- after the data scripts in one transaction (D20). Every DPA version's text lives in
-- libs/legal/dpa/<id>.md. OpenTofu passes each file's sha256 as $dpa_sha256 { <id>: hash } and
-- its words as $dpa_text { <id>: text }, so the stored contentHash and text (D84: kept beside the
-- ledger, served by api-public-read) can't drift from the file:
--   * a draft follows its file;
--   * a published version is frozen: a changed file fails the migration (publish a new version);
--     one published before the text was copied keeps text NONE;
--   * a seeded version, draft or published, whose file is missing fails the migration: the text
--     consent was (or will be) given against must stay in the repo. Only a version that isn't
--     seeded yet may lack a file.
--   * D121: a privacy policy version an admin published (source 'admin') has no file: its words
--     and PDF are in its row and the bucket, kept for ever. It is skipped. A repo version's PDF
--     of record, libs/legal/dpa/<id>.pdf, is frozen with it once set ($dpa_pdf: { <id>:
--     { pdfSha256, pdfSize } }): a version whose PDF file is missing or changed fails the
--     migration.
-- With $sync_check = true (the runner's check before the schema step) it only validates: the
-- previous schema may not define `text` yet, so it writes nothing.
-- 3.2.4: FOR over a subquery fails ("Cannot execute statement using value"); over a LET works.
LET $versions = (SELECT id, status, contentHash, text, pdfSha256, pdfSize FROM dpaVersion WHERE source != 'admin');
FOR $d IN $versions {
  LET $h = $dpa_sha256[record::id($d.id)];
  LET $t = $dpa_text[record::id($d.id)];
  IF $h = NONE {
    THROW <string> $d.id + ' exists, but libs/legal/dpa/' + record::id($d.id) + '.md does not: restore the file';
  };
  IF $t != NONE AND crypto::sha256($t) != $h {
    THROW <string> $d.id + ': the text OpenTofu passed doesn’t match its sha256 (encoding?)';
  };
  IF $h != $d.contentHash OR ($d.status = 'draft' AND $t != NONE AND $t != $d.text) {
    IF $d.status = 'draft' {
      IF $sync_check != true { UPDATE $d.id SET contentHash = $h, text = $t; };
    } ELSE {
      THROW <string> $d.id + ' is published, but its file in libs/legal/dpa has changed: publish a new version instead';
    };
  };
  IF $d.pdfSha256 != NONE {
    LET $pdf = $dpa_pdf[record::id($d.id)];
    IF $pdf = NONE OR $pdf.pdfSha256 != $d.pdfSha256 OR $pdf.pdfSize != $d.pdfSize {
      THROW <string> $d.id + ': its PDF of record, libs/legal/dpa/' + record::id($d.id) + '.pdf, is missing or has changed: restore it';
    };
  };
};
