-- form-sync.surql: the consent forms' dpa-sync (D84). On every migration, checked read-only
-- before anything changes (once the form tables exist), then run after the data scripts and
-- dpa-sync, in one transaction. Every form version's text lives in
-- libs/legal/forms/<signup|testimony|social>/<id>.md; OpenTofu passes each file's sha256 as
-- $form_sha256 { signup: { <id>: hash }, testimony: { ... }, social: { ... } } and its words as
-- $form_text (same shape), so a version's textHash and text can't drift from its file:
--   * a draft follows its file;
--   * a published or retired version is frozen: a changed file fails the migration (publish a
--     new version instead);
--   * a version whose file is missing fails the migration: the words people agreed to stay in
--     the repo.
-- D114: every version's boxes are structured data beside its text,
-- libs/legal/forms/<kind>/<id>.statements.json ({ "statements": [{ "key", "label" }] }), passed
-- as $form_statements (decoded) and $form_statements_sha256 (the file's sha256), same shape:
--   * a missing file fails the migration, and so does one that doesn't list exactly the
--     statements the version must have (fn::form::required_statements), each with words: the
--     pages draw the boxes from it, so none can go missing silently;
--   * a draft follows its file; a published version is frozen, except that one published
--     before statements existed gets them once from its file.
-- With $sync_check = true (the runner's check before the schema step) it only validates.
LET $signup = (SELECT id, status, textHash, text, statements, statementsHash, NONE AS coversPublicPublishing,
  'signup' AS kind, 'signupFormVersion' AS tb FROM signupFormVersion);
LET $testimony = (SELECT id, status, textHash, text, statements, statementsHash, coversPublicPublishing,
  'testimony' AS kind, 'testimonyFormVersion' AS tb FROM testimonyFormVersion);
LET $social = (SELECT id, status, textHash, text, statements, statementsHash, NONE AS coversPublicPublishing,
  'social' AS kind, 'socialSharingFormVersion' AS tb FROM socialSharingFormVersion);
LET $all = array::concat(array::concat($signup, $testimony), $social);
FOR $f IN $all {
  LET $h = $form_sha256[$f.kind][record::id($f.id)];
  LET $t = $form_text[$f.kind][record::id($f.id)];
  IF $h = NONE OR $t = NONE {
    THROW <string> $f.id + ' exists, but libs/legal/forms/' + $f.kind + '/' + record::id($f.id) + '.md does not: restore the file';
  };
  IF crypto::sha256($t) != $h {
    THROW <string> $f.id + ': the text OpenTofu passed doesn’t match its sha256 (encoding?)';
  };
  IF $h != $f.textHash OR $t != $f.text {
    IF $f.status = 'draft' {
      IF $sync_check != true { UPDATE $f.id SET textHash = $h, text = $t; };
    } ELSE {
      THROW <string> $f.id + ' is published, but its file in libs/legal/forms has changed: publish a new version instead';
    };
  };
  LET $sh = $form_statements_sha256[$f.kind][record::id($f.id)];
  LET $sd = $form_statements[$f.kind][record::id($f.id)];
  IF $sh = NONE OR $sd = NONE OR $sd.statements = NONE {
    THROW <string> $f.id + ' exists, but libs/legal/forms/' + $f.kind + '/' + record::id($f.id) + '.statements.json does not: add its boxes (D114)';
  };
  -- The same rule as fn::form::required_statements and fn::form::check_statements in
  -- schema.surql, written out here because this check also runs against the previous schema.
  LET $required = {
    'signupFormVersion false': ['age_18plus', 'account_data'],
    'testimonyFormVersion false': ['special_category_religious'],
    'testimonyFormVersion true': ['special_category_religious', 'publish'],
    'socialSharingFormVersion false': ['share_socials']
  }[$f.tb + ' ' + <string> ($f.coversPublicPublishing = true)];
  LET $keys = $sd.statements.key;
  IF array::len($keys) != array::len(array::distinct($keys)) OR array::len($keys) != array::len($required)
    OR array::len(array::complement($required, $keys)) > 0 {
    THROW <string> $f.id + ': libs/legal/forms/' + $f.kind + '/' + record::id($f.id) + '.statements.json must list exactly ' + <string> $required + ', each once (D114)';
  };
  FOR $s IN $sd.statements {
    IF $s.label = NONE OR string::len(string::trim(<string> $s.label)) = 0 {
      THROW <string> $f.id + ': every statement in its statements file needs words to show beside its box (D114)';
    };
  };
  IF $sh != $f.statementsHash OR $sd.statements != $f.statements {
    IF $f.status = 'draft' OR $f.statementsHash = NONE {
      IF $sync_check != true { UPDATE $f.id SET statements = $sd.statements, statementsHash = $sh; };
    } ELSE {
      THROW <string> $f.id + ' is published, but its statements file in libs/legal/forms has changed: publish a new version instead';
    };
  };
};
