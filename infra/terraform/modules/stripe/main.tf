# Donations through Stripe's own pages (Joel, 2026-10-29: Stripe's embeddable Buy Buttons,
# option A). What Stripe's API can make is here; the two Buy Buttons themselves are made once
# in the Stripe Dashboard from these Payment Links (no API), and only their public IDs reach the
# site (live/dev/gcp). Stripe hosts every payment page: no card data, and no donor data, reaches
# our services.
#
#   one-off  "customer chooses price" in GBP, from £1, starting at £10; the button says Donate.
#   monthly  £1 a month, and the donor chooses how many (1–999): 10 = £10 a month. Stripe can't
#            let donors type a monthly amount (pay-what-you-want has no recurring prices).
#   portal   Stripe's donor portal (a login page by email): change the monthly amount, update
#            the card, see receipts, or stop the gift at the end of the month already paid.
#            Changing the amount needs the portal's `products`, which OpenTofu can't set for
#            now (see subscription_update below).
#
# Nothing here is secret: IDs and public URLs only, so the state holds no secrets.

locals {
  currency = "gbp"
  pounds   = var.monthly.unit_amount / 100
  metadata = { managed_by = "opentofu", environment = var.environment }
}

# Refuse to plan with the wrong kind of key: dev never touches live mode, and a live
# environment never runs on a sandbox key. Only the key's mode is checked, never printed.
resource "terraform_data" "key_mode" {
  lifecycle {
    precondition {
      condition     = var.key_mode == (var.live ? "live" : "test")
      error_message = var.live ? "This environment takes real money but the Stripe key isn't a live key (sk_live_/rk_live_)." : "This environment is sandbox-only but the Stripe key isn't a test key (sk_test_/rk_test_). Refusing to plan."
    }
  }
}

resource "stripe_product" "donation" {
  name     = var.product_name
  active   = true # pinned: one archived in the Dashboard plans as drift
  metadata = local.metadata

  depends_on = [terraform_data.key_mode]
}

resource "stripe_price" "one_off" {
  product  = stripe_product.donation.id
  currency = local.currency
  nickname = "One-off, donor chooses the amount"
  active   = true
  metadata = local.metadata

  custom_unit_amount {
    enabled = true
    minimum = var.one_off.minimum
    preset  = var.one_off.preset
  }

  # Prices are immutable: an amount change makes a new price, and the old one is archived after.
  lifecycle {
    create_before_destroy = true
  }
}

resource "stripe_price" "monthly" {
  product     = stripe_product.donation.id
  currency    = local.currency
  unit_amount = var.monthly.unit_amount
  nickname    = "Monthly, £${local.pounds} a unit"
  active      = true
  metadata    = local.metadata

  recurring {
    interval = "month"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# A link's price can't be changed in place (Stripe can't swap a link's line items, and the
# provider would only update it), so a new price means a new link: replace_triggered_by. The new
# link exists before the old one is deactivated, but a new link means new Buy Buttons in the
# Dashboard (README, "Stripe": "Changing an amount"). `active` is pinned so a link deactivated in
# the Dashboard plans as drift.
resource "stripe_payment_link" "one_off" {
  line_items = [{
    price    = stripe_price.one_off.id
    quantity = 1
  }]
  submit_type                = "donate"
  billing_address_collection = "auto"
  active                     = true
  metadata                   = local.metadata

  lifecycle {
    create_before_destroy = true
    replace_triggered_by  = [stripe_price.one_off.id]
  }

  after_completion = {
    type = "hosted_confirmation"
    hosted_confirmation = {
      custom_message = "Thank you for your gift to He Is Real Today. Stripe will email your receipt."
    }
  }
}

resource "stripe_payment_link" "monthly" {
  line_items = [{
    price    = stripe_price.monthly.id
    quantity = var.monthly.quantity
    adjustable_quantity = {
      enabled = true
      minimum = 1
      maximum = var.monthly.max_quantity
    }
  }]
  billing_address_collection = "auto"
  active                     = true
  metadata                   = local.metadata

  lifecycle {
    create_before_destroy = true
    replace_triggered_by  = [stripe_price.monthly.id]
  }

  # Stripe shows a quantity, so say what it means beside the pay button.
  custom_text = {
    submit = {
      message = "Each one is £${local.pounds} a month: choose how many £${local.pounds}s you'd like to give each month (10 = £${10 * local.pounds} a month). You can change or stop it at any time from the link on our donate page."
    }
  }

  after_completion = {
    type = "hosted_confirmation"
    hosted_confirmation = {
      custom_message = "Thank you for giving to He Is Real Today every month. Stripe will email your receipts."
    }
  }
}

resource "stripe_billing_portal_configuration" "donors" {
  name               = "Donors"
  active             = true
  default_return_url = "${var.site_url}/donate"
  metadata           = local.metadata

  business_profile = {
    headline           = "He Is Real Today: your monthly gift"
    privacy_policy_url = "${var.site_url}/privacy"
  }

  login_page = {
    enabled = true
  }

  features = {
    # No `products`: the stripe provider 0.3.0 never asks Stripe to include that field, so
    # Stripe's answer always lacks it and every apply that sets it fails ("inconsistent result",
    # stripe/terraform-provider-stripe#53 and #54). Dev keeps its stored products (1-999) from
    # the first apply. A portal created without them (a new environment, or a replacement)
    # probably only allows cancel, card and receipts, not changing the amount: Stripe applies
    # default_allowed_updates to the items listed in `products`. Put it back once a release
    # fixes the provider; needed before Go live (README, "Stripe").
    subscription_update = {
      enabled                 = true
      default_allowed_updates = ["quantity"]
      proration_behavior      = "none"
    }
    subscription_cancel = {
      enabled = true
      mode    = "at_period_end"
    }
    payment_method_update = {
      enabled = true
    }
    invoice_history = {
      enabled = true
    }
  }
}
