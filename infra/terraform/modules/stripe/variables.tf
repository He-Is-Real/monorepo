variable "environment" {
  description = "dev, prod, ... (Stripe metadata only)."
  type        = string
}

variable "key_mode" {
  description = "The mode of the API key the provider runs with: \"test\" (sk_test_/rk_test_, a sandbox) or \"live\". Ephemeral: the root derives it from the key it reads from Secret Manager, and only the mode, never the key, reaches this module."
  type        = string
  ephemeral   = true
}

variable "live" {
  description = "Whether this environment takes real money. false (dev): only a test-mode key is accepted. true is for production, after Joel switches it on (README, \"Going live\")."
  type        = bool
  default     = false
}

variable "product_name" {
  description = "What donors see on Stripe's payment page and receipt."
  type        = string
  default     = "Donation to He Is Real"
}

variable "one_off" {
  description = "One-off gifts: the donor types any amount from minimum, starting at preset. Minor units (pence)."
  type = object({
    minimum = number
    preset  = number
  })
  default = { minimum = 100, preset = 1000 }

  validation {
    condition     = var.one_off.minimum >= 100 && var.one_off.preset >= var.one_off.minimum
    error_message = "The minimum must be at least £1 (100), Stripe's lowest GBP charge, and the preset at least the minimum."
  }
}

variable "monthly" {
  description = "Monthly gifts: a price of unit_amount a month, and the donor chooses how many (1 to max_quantity), starting at quantity. unit_amount in minor units (pence)."
  type = object({
    unit_amount  = number
    quantity     = number
    max_quantity = number
  })
  default = { unit_amount = 100, quantity = 10, max_quantity = 999 }

  validation {
    condition = (
      var.monthly.unit_amount >= 100 && var.monthly.unit_amount % 100 == 0 &&
      var.monthly.quantity >= 1 && var.monthly.quantity <= var.monthly.max_quantity &&
      var.monthly.max_quantity <= 999999
    )
    error_message = "unit_amount must be whole pounds of at least £1 (100, 200, …; the payment page words count pounds), and quantity between 1 and max_quantity (at most 999999, Stripe's limit)."
  }
}

variable "site_url" {
  description = "The site's public origin (https, no path): Stripe's donor portal links back to /donate and shows /privacy."
  type        = string

  validation {
    condition     = can(regex("^https://[a-z0-9.-]+$", var.site_url))
    error_message = "site_url must be an https origin without a path or trailing slash."
  }
}
