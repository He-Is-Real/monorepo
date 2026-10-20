# Clerk's RS256 public key for DEFINE ACCESS clerk (D27 B), pinned because GKE has no internet
# egress to fetch the JWKS. Public, so it lives here (never a private key). Empty until Clerk is
# set up (task 0.5): the migration then removes the clerk access, so no person sessions.
# From the Clerk dashboard (API keys -> "JWKS Public Key", PEM), e.g.:
#   clerk_jwt_public_key = <<-EOT
#     -----BEGIN PUBLIC KEY-----
#     ...
#     -----END PUBLIC KEY-----
#   EOT
clerk_jwt_public_key = ""
