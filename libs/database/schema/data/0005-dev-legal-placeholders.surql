-- data/0005-dev-legal-placeholders.surql (runs once; recorded in _migration by the runner, in
-- the same transaction). D75: dev's published placeholder privacy document and the first
-- version of each of the three consent forms, so dev's fixture people can give real consent and D48 can be
-- off. Only with $dev_legal_placeholders = true (OpenTofu's dev_legal_placeholders, set only in
-- live/dev/cluster); elsewhere it records itself as applied and writes nothing. The database
-- refuses the placeholder unless the settings row (written by the schema step, just before)
-- says dev with the switch on, and counts it, and the forms linking it, only while it does.
-- Version 1 of each form exists only here, linked to the placeholder: the lawyer-checked words
-- become version 2 (published v1 is frozen in dev). texts and hashes: dpa-sync, form-sync.
IF $dev_legal_placeholders = true {
  CREATE dpaVersion:dev_placeholder CONTENT {
    kind: 'standard', status: 'published', materiality: 'material', devPlaceholder: true,
    documentPath: 'libs/legal/dpa/dev_placeholder.md', contentHash: $dpa_sha256.dev_placeholder,
    text: $dpa_text.dev_placeholder, changeSummary: 'Dev-only placeholder (D75)',
    effectiveFrom: time::now()
  };
  CREATE signupFormVersion:v1 CONTENT {
    status: 'published', textRef: 'libs/legal/forms/signup/v1.md',
    textHash: $form_sha256.signup.v1, text: $form_text.signup.v1,
    dpaVersion: dpaVersion:dev_placeholder
  };
  CREATE testimonyFormVersion:v1 CONTENT {
    status: 'published', textRef: 'libs/legal/forms/testimony/v1.md',
    textHash: $form_sha256.testimony.v1, text: $form_text.testimony.v1,
    dpaVersion: dpaVersion:dev_placeholder,
    requiresAcceptanceForNewSubmissions: false, coversPublicPublishing: true,
    draftRetentionMonths: 6
  };
  -- Every platform and use its words name (libs/legal/forms/social/v1.md).
  CREATE socialSharingFormVersion:v1 CONTENT {
    status: 'published', textRef: 'libs/legal/forms/social/v1.md',
    textHash: $form_sha256.social.v1, text: $form_text.social.v1,
    dpaVersion: dpaVersion:dev_placeholder,
    shareYouTube: true, shareInstagram: true, shareTikTok: true, shareFacebook: true,
    allowEditingAndClipping: true, allowChurchAndPartnerMedia: true,
    allowPrintAndEvents: true, allowPaidPromotion: true
  };
};
