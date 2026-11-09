module github.com/He-Is-Real/monorepo/apps/media-worker/compat/go-auth

go 1.24.0

// The version inside daprd 1.19.1 (`go version -m ~/.dapr/bin/daprd`); move with mise.toml's dapr.
require cloud.google.com/go/auth v0.18.2

require (
	cloud.google.com/go/compute/metadata v0.9.0 // indirect
	github.com/googleapis/enterprise-certificate-proxy v0.3.11 // indirect
	github.com/googleapis/gax-go/v2 v2.17.0 // indirect
	golang.org/x/sys v0.40.0 // indirect
)
