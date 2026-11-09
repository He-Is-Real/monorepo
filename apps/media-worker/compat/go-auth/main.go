// A stand-in for Dapr's sidecar (daprd 1.19.1), for dapr-rotation.compat-spec.ts only: the same
// Google client library at the same version (cloud.google.com/go/auth v0.18.2), loading
// GOOGLE_APPLICATION_CREDENTIALS once at start-up as daprd does, then fetching a fresh token for
// every line on stdin and printing it. LOCAL ONLY, never in CI.
package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"time"

	"cloud.google.com/go/auth/credentials"
)

func main() {
	creds, err := credentials.DetectDefault(&credentials.DetectOptions{
		Scopes: []string{"https://www.googleapis.com/auth/cloud-platform"},
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "credentials:", err)
		os.Exit(1)
	}
	ctx := context.Background()
	var expiry time.Time
	lines := bufio.NewScanner(os.Stdin)
	for lines.Scan() {
		// The fake token service's tokens last a second: wait it out, so this is a real refresh
		// (as each hourly one is in daprd), not the cached token.
		time.Sleep(time.Until(expiry) + 50*time.Millisecond)
		token, err := creds.Token(ctx)
		if err != nil {
			fmt.Println("error:", err)
			continue
		}
		expiry = token.Expiry
		fmt.Println(token.Value)
	}
}
