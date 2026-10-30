# Donations (Joel, 2026-10-29, option A): what donors can give, and that a sandbox environment
# never runs on a live key (or the other way round). Mock provider: no Stripe access.

mock_provider "stripe" {
  mock_resource "stripe_product" {
    defaults = { id = "prod_mock" }
  }
  mock_resource "stripe_price" {
    defaults = { id = "price_mock" }
  }
}

variables {
  environment = "dev"
  key_mode    = "test"
  site_url    = "https://web-abc-nw.a.run.app"
}

run "sandbox_donations" {
  command = plan

  assert {
    condition = (
      stripe_price.one_off.currency == "gbp" &&
      stripe_price.one_off.custom_unit_amount[0].enabled &&
      stripe_price.one_off.custom_unit_amount[0].minimum == 100 &&
      stripe_price.one_off.custom_unit_amount[0].preset == 1000 &&
      length(stripe_price.one_off.recurring) == 0
    )
    error_message = "One-off gifts are in GBP, any amount from £1, starting at £10."
  }

  assert {
    condition     = stripe_payment_link.one_off.submit_type == "donate"
    error_message = "The one-off page's button says Donate."
  }

  assert {
    condition = (
      stripe_price.monthly.currency == "gbp" &&
      stripe_price.monthly.unit_amount == 100 &&
      stripe_price.monthly.recurring[0].interval == "month"
    )
    error_message = "Monthly gifts are £1 a month a unit, in GBP."
  }

  assert {
    condition = (
      stripe_payment_link.monthly.line_items[0].adjustable_quantity.enabled &&
      stripe_payment_link.monthly.line_items[0].adjustable_quantity.minimum == 1 &&
      stripe_payment_link.monthly.line_items[0].adjustable_quantity.maximum == 999
    )
    error_message = "Monthly donors choose from 1 to 999 £1s a month."
  }

  assert {
    condition = (
      stripe_billing_portal_configuration.donors.login_page.enabled &&
      stripe_billing_portal_configuration.donors.features.subscription_cancel.enabled &&
      stripe_billing_portal_configuration.donors.features.subscription_cancel.mode == "at_period_end" &&
      stripe_billing_portal_configuration.donors.features.subscription_update.products[0].adjustable_quantity.maximum == 999
    )
    error_message = "Monthly donors can change their gift (1 to 999) or stop it (at the end of the month paid) from Stripe's portal."
  }
}

run "sandbox_refuses_a_live_key" {
  command = plan
  variables {
    key_mode = "live"
  }
  expect_failures = [terraform_data.key_mode]
}

run "live_refuses_a_test_key" {
  command = plan
  variables {
    live = true
  }
  expect_failures = [terraform_data.key_mode]
}

run "one_off_minimum_is_at_least_one_pound" {
  command = plan
  variables {
    one_off = { minimum = 50, preset = 1000 }
  }
  expect_failures = [var.one_off]
}
