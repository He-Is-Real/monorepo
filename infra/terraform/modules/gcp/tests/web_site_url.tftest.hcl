# web's SITE_URL (M1 step 6b-2): canonical URLs and the sitemap come from it, so only an
# https origin is accepted. Mock providers: no Google access.

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
}

run "site_url_passed_to_web" {
  command = plan
  variables {
    web_site_url = "https://web-jbxp6odnsa-nw.a.run.app"
  }

  assert {
    condition = one([for e in google_cloud_run_v2_service.web.template[0].containers[0].env :
    e.value if e.name == "SITE_URL"]) == "https://web-jbxp6odnsa-nw.a.run.app"
    error_message = "web gets SITE_URL from web_site_url."
  }
}

run "site_url_refuses_a_path" {
  command = plan
  variables {
    web_site_url = "https://www.heisreal.today/about"
  }
  expect_failures = [var.web_site_url]
}

run "site_url_refuses_http" {
  command = plan
  variables {
    web_site_url = "http://www.heisreal.today"
  }
  expect_failures = [var.web_site_url]
}
