# Donations

Who: Visitor, Signed-in person (anyone who donates).
Data: none; Stripe holds every donation.
Next id: REQ-DON-009

## Donate page

- **REQ-DON-001** The Donate page offers "One-off" or "Monthly" and shows Stripe's own button for the choice. [D116]
- **REQ-DON-002** Stripe's page takes the payment, so the site never handles card details. [D116]
- **REQ-DON-003** A one-off donor chooses the amount, from £1, starting at £10. [D116]
- **REQ-DON-004** A monthly donor chooses how many £1s a month, from 1 to 999, starting at 10. [D116]
- **REQ-DON-005** Monthly donors change or stop their gift through Stripe's donor portal. [D116]
- **REQ-DON-006** Dev uses Stripe's test mode only. [D116]
- **REQ-DON-007** Nothing about donors is stored in the database. [D116]
- **REQ-DON-008** Once the charity is registered, donations offer Gift Aid. (planned) [UNTRACED]
