-- data/0007-dev-legal-documents.surql (runs once; recorded in _migration by the runner, in the
-- same transaction). D121, D122, D125 (Joel, 2026-10-30): the two legal documents, Markdown the
-- site renders, and the consent moments' boxes, in dev. Only with $dev_legal_placeholders = true
-- (OpenTofu's dev_legal_placeholders, set only in live/dev/cluster); elsewhere it records itself
-- as applied and writes nothing, and the first versions are published from /admin/legal.
--   * Privacy policy: dev's placeholder privacy document (dpaVersion:dev_placeholder, 0005) is
--     version 1. It gets its number here, the one change dpa_immutable allows a published
--     version, and only the migration may make it (a fresh database numbered it when 0005 made
--     it). Every consent in dev already names it; nothing in the ledger moves. Version 2 is the
--     words /privacy showed before D125, cookie table and all (libs/legal/dpa/dev_policy.md).
--   * Terms of use: dev's placeholder version 1 (libs/legal/terms/dev_placeholder.md), counted
--     only in dev (D75).
--   * Version 2 of the three consent forms: a short introduction instead of a document, the
--     boxes from their statements data (with the testimony boxes' steps), and on the sign-up
--     form Joel's new wording and the box "I agree to the terms of use" (coversTerms). Under
--     D93's rules: a new sign-up version is accepted at the next sign-in (D84); the testimony
--     and social sharing versions require nothing (same boxes, same words beside them).
IF $dev_legal_placeholders = true {
  UPDATE dpaVersion:dev_placeholder SET number = NONE WHERE number = NONE;
  CREATE dpaVersion:dev_policy CONTENT {
    kind: 'standard', status: 'published', materiality: 'minor', devPlaceholder: true,
    documentPath: 'libs/legal/dpa/dev_policy.md', contentHash: $dpa_sha256.dev_policy,
    text: $dpa_text.dev_policy, changeSummary: 'Dev-only placeholder: the site’s privacy page (D75, D125)',
    effectiveFrom: time::now()
  };
  CREATE termsVersion:dev_placeholder CONTENT {
    text: $terms_text.dev_placeholder, contentHash: crypto::sha256($terms_text.dev_placeholder),
    devPlaceholder: true
  };
  CREATE signupFormVersion:v2 CONTENT {
    status: 'published', textRef: 'libs/legal/forms/signup/v2.md',
    textHash: $form_sha256.signup.v2, text: $form_text.signup.v2,
    statements: $form_statements.signup.v2.statements,
    statementsHash: $form_statements_sha256.signup.v2,
    dpaVersion: dpaVersion:dev_policy, coversTerms: true
  };
  CREATE testimonyFormVersion:v2 CONTENT {
    status: 'published', textRef: 'libs/legal/forms/testimony/v2.md',
    textHash: $form_sha256.testimony.v2, text: $form_text.testimony.v2,
    statements: $form_statements.testimony.v2.statements,
    statementsHash: $form_statements_sha256.testimony.v2,
    dpaVersion: dpaVersion:dev_policy,
    requiresAcceptanceForNewSubmissions: false, coversPublicPublishing: true,
    draftRetentionMonths: 6
  };
  -- Every platform and use its words name (libs/legal/forms/social/v2.md), as v1.
  CREATE socialSharingFormVersion:v2 CONTENT {
    status: 'published', textRef: 'libs/legal/forms/social/v2.md',
    textHash: $form_sha256.social.v2, text: $form_text.social.v2,
    statements: $form_statements.social.v2.statements,
    statementsHash: $form_statements_sha256.social.v2,
    dpaVersion: dpaVersion:dev_policy,
    shareYouTube: true, shareInstagram: true, shareTikTok: true, shareFacebook: true,
    allowEditingAndClipping: true, allowChurchAndPartnerMedia: true,
    allowPrintAndEvents: true, allowPaidPromotion: true
  };
};
