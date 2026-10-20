-- data/0002-seed-legacy-dpa.surql (runs once). D22: the consent the prototype's Squarespace form
-- collected (Sharing Principles + T&Cs + social-media use), recorded as a published, immutable
-- legacy version. $legacy_sha256 = filesha256("libs/legal/dpa/legacy-squarespace.md").
-- HELD BACK until that file exists (the T&Cs text is still needed, D22): Terraform passes
-- legacy_sha256 = null, and the runner stops before any script that uses a null parameter.
CREATE dpaVersion:`legacy-squarespace` CONTENT {
  kind: 'legacy', status: 'published', materiality: 'material',
  documentPath: 'libs/legal/dpa/legacy-squarespace.md', contentHash: $legacy_sha256,
  changeSummary: 'Consent given through the prototype Squarespace form (website, social media, newsletters, printed materials)',
  effectiveFrom: d'2024-01-01'   -- set to the prototype launch date
};

-- data/0003-legacy-testimonies.surql (M1, task 1.9; runs as the migrator) — one block per testimony:
--   CREATE user:⟨legacyId⟩;                                  -- no clerkUserId, no PII
--   FOR $t IN ['special_category_religious', 'publish', 'share_socials', 'age_18plus'] {
--     CREATE consent CONTENT { subject: user:⟨legacyId⟩, type: $t, event: 'granted',
--       dpaVersion: dpaVersion:`legacy-squarespace`, mechanism: 'legacy_import',
--       evidenceHash: $legacy_sha256, legacyGivenAt: ⟨original submission date⟩ };
--   };
--   CREATE story … ; CREATE publicStory … ;                  -- approved as in the prototype
