# Clerk's RS256 public key for DEFINE ACCESS clerk (D27 B), pinned because GKE has no internet
# egress to fetch the JWKS. Public, so it lives here (never a private key). Empty = the
# migration removes the clerk access, so no person sessions.
# The dev instance ("He Is Real", ins_3JuNEu4vvFrDyToUWDi2LGgPbOZ, issuer
# https://superb-mink-8967.clerk.accounts.dev), from `clerk api /jwks` converted to PEM
# (infra/clerk/README.md). api-user and api-admin pin the same key (CLERK_JWT_PUBLIC_KEY).
# A rotated Clerk key breaks every person session until this is updated and migrated.
clerk_jwt_public_key = <<-EOT
  -----BEGIN PUBLIC KEY-----
  MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs+x7KKkwQ13rwv9WnIzp
  QQOyb61U6Bp9BeHNRI0fV6U6cz+/fz8SVyDsy6GQEkrAzGXABCQe3amlC4HbhZml
  I4GulA1TeXMQGgMNhzhIrUk2n7pVh8gvg28z3iIJLO3syX2LaDI9w1ToSelMHbsd
  8UhwJEKFOsGTbCY0yY0SnF+WIy+hyds7yqs/r4gjB2Aw21eaKTjO7UTFsoTNXV6m
  fNR0QUNBFTDXDhc/ipv1jVkUxXmr84jsvx7AK0q9aho4JUMXwDJoqwwmEpaNbSVe
  jxl6R9xytUgIEPeBfy2/WWN+OtJJxBUQp/xw6gBPsJ79wjaQKTu0Emrlq/vwEd/w
  4QIDAQAB
  -----END PUBLIC KEY-----
EOT
