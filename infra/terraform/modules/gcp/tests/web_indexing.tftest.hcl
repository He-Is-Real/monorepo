# web's SITE_URL and the indexing fence (M1 step 6b-2, #65 review). Canonical URLs and the
# sitemap come from SITE_URL, so only an https DNS origin is accepted (what web's siteUrl()
# accepts too). Indexing is an explicit opt-in that dev can never turn on. Mock providers.

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

run "site_url_refuses_an_invalid_ipv4" {
  command = plan
  variables {
    web_site_url = "https://999.999.999.999"
  }
  expect_failures = [var.web_site_url]
}

run "site_url_refuses_a_short_numeric_host" {
  command = plan
  variables {
    web_site_url = "https://1.2.3"
  }
  expect_failures = [var.web_site_url]
}

run "site_url_refuses_a_numeric_tld" {
  command = plan
  variables {
    web_site_url = "https://example.123"
  }
  expect_failures = [var.web_site_url]
}

run "site_url_refuses_a_bad_label" {
  command = plan
  variables {
    web_site_url = "https://-bad-.example.com"
  }
  expect_failures = [var.web_site_url]
}

run "site_url_refuses_an_underscore" {
  command = plan
  variables {
    web_site_url = "https://exa_mple.com"
  }
  expect_failures = [var.web_site_url]
}

run "site_url_refuses_a_port" {
  command = plan
  variables {
    web_site_url = "https://www.heisreal.today:8443"
  }
  expect_failures = [var.web_site_url]
}

run "site_url_refuses_a_trailing_dot" {
  command = plan
  variables {
    web_site_url = "https://www.heisreal.today."
  }
  expect_failures = [var.web_site_url]
}

run "site_url_refuses_an_ip" {
  command = plan
  variables {
    web_site_url = "https://203.0.113.10"
  }
  expect_failures = [var.web_site_url]
}

run "noindex_by_default" {
  command = plan
  variables {
    web_site_url = "https://web-jbxp6odnsa-nw.a.run.app"
  }

  assert {
    condition = one([for e in google_cloud_run_v2_service.web.template[0].containers[0].env :
    e.value if e.name == "INDEXING"]) == "deny"
    error_message = "Without web_indexing, web gets INDEXING=deny (noindex)."
  }
  assert {
    condition = one([for e in google_cloud_run_v2_service.web.template[0].containers[0].env :
    e.value if e.name == "ROBOTS_NOINDEX"]) == "true"
    error_message = "Images built before #65 read ROBOTS_NOINDEX: it stays true while indexing is off."
  }
}

run "indexing_refused_in_dev" {
  command = plan
  variables {
    web_indexing = true
    web_site_url = "https://web-jbxp6odnsa-nw.a.run.app"
  }
  expect_failures = [var.web_indexing]
}

run "indexing_needs_a_site_url" {
  command = plan
  variables {
    project_id   = "heisreal-prod"
    environment  = "prod"
    web_indexing = true
  }
  expect_failures = [var.web_indexing]
}

run "indexing_allowed_outside_dev" {
  command = plan
  variables {
    project_id   = "heisreal-prod"
    environment  = "prod"
    web_indexing = true
    web_site_url = "https://www.heisreal.today"
  }

  assert {
    condition = one([for e in google_cloud_run_v2_service.web.template[0].containers[0].env :
    e.value if e.name == "INDEXING"]) == "allow"
    error_message = "With web_indexing outside dev, web gets INDEXING=allow."
  }
  assert {
    condition = one([for e in google_cloud_run_v2_service.web.template[0].containers[0].env :
    e.value if e.name == "ROBOTS_NOINDEX"]) == "false"
    error_message = "ROBOTS_NOINDEX follows web_indexing for older images."
  }
}
