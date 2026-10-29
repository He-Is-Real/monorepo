# All public: Stripe IDs and URLs donors open anyway.

output "product_id" {
  value = stripe_product.donation.id
}

output "payment_links" {
  description = "Make one Buy Button from each in the Stripe Dashboard (README, \"Stripe\")."
  value = {
    one_off = { id = stripe_payment_link.one_off.id, url = stripe_payment_link.one_off.url }
    monthly = { id = stripe_payment_link.monthly.id, url = stripe_payment_link.monthly.url }
  }
}

output "donor_portal_url" {
  description = "Stripe's donor portal login page (by email): web links to it from /donate."
  value       = stripe_billing_portal_configuration.donors.login_page.url
}
