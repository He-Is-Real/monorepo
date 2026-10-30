# Stripe's Buy Buttons on /donate (Joel, 2026-10-29): web gets the public values, and dev only
# ever takes a sandbox key. Mock providers.

mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      email  = "mock-account@heisreal-dev.iam.gserviceaccount.com"
      name   = "projects/heisreal-dev/serviceAccounts/mock-account@heisreal-dev.iam.gserviceaccount.com"
      member = "serviceAccount:mock-account@heisreal-dev.iam.gserviceaccount.com"
    }
  }
}
mock_provider "random" {}

variables {
  project_id               = "heisreal-dev"
  environment              = "dev"
  cluster_dns_domain       = "cluster.heisreal-dev.internal"
  ci_image_pusher_email    = "ci-image-pusher@heisreal-dev.iam.gserviceaccount.com"
  ci_snapshot_pusher_email = "ci-snapshot-pusher@heisreal-dev.iam.gserviceaccount.com"
  web_origins              = ["https://web-abc-nw.a.run.app"]
  clerk_issuer             = "https://example.clerk.accounts.dev"
  clerk_jwt_public_key     = "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n"
}

run "buttons_passed_to_web" {
  command = plan
  variables {
    web_donations = {
      stripe_publishable_key = "pk_test_abc123"
      one_off_button_id      = "buy_btn_one"
      monthly_button_id      = "buy_btn_two"
      donor_portal_url       = "https://billing.stripe.com/p/login/test_abc"
    }
  }

  assert {
    condition = {
      for e in google_cloud_run_v2_service.web.template[0].containers[0].env : e.name => e.value if startswith(e.name, "STRIPE_")
      } == {
      STRIPE_PUBLISHABLE_KEY          = "pk_test_abc123"
      STRIPE_DONATE_ONE_OFF_BUTTON_ID = "buy_btn_one"
      STRIPE_DONATE_MONTHLY_BUTTON_ID = "buy_btn_two"
      STRIPE_DONOR_PORTAL_URL         = "https://billing.stripe.com/p/login/test_abc"
    }
    error_message = "web gets the publishable key, both Buy Button IDs and the donor portal."
  }
}

run "unset_means_placeholder" {
  command = plan

  assert {
    condition = alltrue([for e in google_cloud_run_v2_service.web.template[0].containers[0].env :
    e.value == "" if startswith(e.name, "STRIPE_")])
    error_message = "Without web_donations, every STRIPE_ setting is empty (web shows its placeholder)."
  }
}

run "dev_refuses_a_live_key" {
  command = plan
  variables {
    web_donations = { stripe_publishable_key = "pk_live_abc123" }
  }
  expect_failures = [var.web_donations]
}

run "refuses_a_secret_key" {
  command = plan
  variables {
    web_donations = { stripe_publishable_key = "sk_test_abc123" }
  }
  expect_failures = [var.web_donations]
}
