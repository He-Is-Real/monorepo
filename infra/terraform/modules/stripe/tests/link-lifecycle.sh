#!/usr/bin/env bash
# What Stripe can't change in place, and what the Dashboard changes behind OpenTofu's back
# (Codex, #122), planned with the real stripe provider against a written state: offline, since
# `plan -refresh=false` never calls Stripe (the key is a dummy). Run by test-modules.sh.
#   1. nothing changed: the one-off Payment Link stays (its Buy Button keeps working);
#   2. a new one-off amount (a new price) replaces the link (a link's price can't change in place);
#   3. a link, price or product deactivated in the Dashboard plans `active = true` again.
#
#   infra/terraform/modules/stripe/tests/link-lifecycle.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
module="$(dirname "$here")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/main.tf" << EOF
terraform {
  required_providers {
    stripe = { source = "stripe/stripe" }
  }
}
provider "stripe" { api_key = "rk_test_offline" }
variable "preset" { default = 1000 }
module "stripe" {
  source      = "$module"
  environment = "dev"
  key_mode    = "test"
  site_url    = "https://web.example"
  one_off     = { minimum = 100, preset = var.preset }
}
EOF
cp "$module/../../live/dev/stripe/.terraform.lock.hcl" "$work/"
tofu -chdir="$work" init -input=false > /dev/null

# The state after an apply of the defaults: the product, both prices and the one-off link,
# with `active` as given (true, or false = deactivated in the Dashboard).
state() { # state <link active> <price active> <product active>
  python3 - "$@" << 'EOF'
import json, sys
link, price, product = (a == "true" for a in sys.argv[1:4])
meta = {"managed_by": "opentofu", "environment": "dev"}
def res(t, n, v, a, prov='provider["registry.opentofu.org/stripe/stripe"]'):
    return {"module": "module.stripe", "mode": "managed", "type": t, "name": n, "provider": prov,
            "instances": [{"schema_version": v, "attributes": a, "sensitive_attributes": []}]}
print(json.dumps({"version": 4, "terraform_version": "1.13.2", "serial": 1,
  "lineage": "00000000-0000-0000-0000-000000000000", "outputs": {}, "resources": [
  res("terraform_data", "key_mode", 0, {"id": "x", "input": None, "output": None, "triggers_replace": None},
      'provider["terraform.io/builtin/terraform"]'),
  res("stripe_product", "donation", 2, {"id": "prod_1", "name": "Donation to He Is Real",
      "active": product, "metadata": meta}),
  res("stripe_price", "one_off", 2, {"id": "price_1", "product": "prod_1", "currency": "gbp",
      "nickname": "One-off, donor chooses the amount", "active": price, "metadata": meta,
      "custom_unit_amount": [{"enabled": True, "minimum": 100, "preset": 1000, "maximum": None}]}),
  res("stripe_price", "monthly", 2, {"id": "price_2", "product": "prod_1", "currency": "gbp",
      "unit_amount": 100, "nickname": "Monthly, £1 a unit", "active": True, "metadata": meta,
      "recurring": [{"interval": "month", "interval_count": None, "meter": None,
                     "trial_period_days": None, "usage_type": None}]}),
  res("stripe_payment_link", "one_off", 0, {"id": "plink_1", "url": "https://buy.stripe.com/test_1",
      "active": link, "metadata": meta, "submit_type": "donate", "billing_address_collection": "auto",
      "line_items": [{"price": "price_1", "quantity": None, "id": "li_1",
                      "adjustable_quantity": None, "price_data": None}],
      "after_completion": {"type": "hosted_confirmation", "redirect": None, "hosted_confirmation": {
          "custom_message": "Thank you for your gift to He Is Real Today. Stripe will email your receipt."}}}),
]}))
EOF
}

# The planned actions for one address, e.g. "update" or "create,delete".
actions() { # actions <address> <plan json>
  jq -r --arg a "module.stripe.$1" '.resource_changes[] | select(.address == $a) | .change.actions | join(",")' <<< "$2"
}
plan() { # plan <tofu plan args...>: the plan as JSON
  tofu -chdir="$work" plan -refresh=false -input=false -lock=false -out=p.bin "$@" > /dev/null
  tofu -chdir="$work" show -json p.bin
}

failures=0
expect() { # expect <description> <want> <got>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else
    echo "FAIL $1: want '$2', got '$3'"
    failures=$((failures + 1))
  fi
}

state true true true > "$work/terraform.tfstate"
json="$(plan)"
expect "unchanged: the one-off link stays" no-op "$(actions stripe_payment_link.one_off "$json")"

json="$(plan -var preset=2000)"
expect "new amount: a new one-off price" create,delete "$(actions stripe_price.one_off "$json")"
expect "new amount: a new one-off link, made before the old one goes" create,delete \
  "$(actions stripe_payment_link.one_off "$json")"

state false false false > "$work/terraform.tfstate"
json="$(plan)"
for address in stripe_payment_link.one_off stripe_price.one_off stripe_product.donation; do
  expect "deactivated in the Dashboard: $address is turned back on" update "$(actions "$address" "$json")"
  expect "...to active = true" true \
    "$(jq -r --arg a "module.stripe.$address" '.resource_changes[] | select(.address == $a) | .change.after.active' <<< "$json")"
done

[ "$failures" -eq 0 ] || exit 1
