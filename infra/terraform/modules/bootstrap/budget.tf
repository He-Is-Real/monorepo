# Monthly budget for this project. Alert emails go to the billing account's
# admins and users at each threshold. Alerts only: nothing is stopped
# automatically, and billing is never unlinked.

resource "google_billing_budget" "monthly" {
  provider = google.billing

  billing_account = var.billing_account
  display_name    = "${var.project_id} monthly"

  budget_filter {
    projects               = ["projects/${google_project.this.number}"]
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      # No currency_code: uses the billing account's currency.
      units = tostring(var.budget_amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = toset(concat(var.budget_alert_fractions, [1.0]))
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  depends_on = [google_project_service.this]
}
