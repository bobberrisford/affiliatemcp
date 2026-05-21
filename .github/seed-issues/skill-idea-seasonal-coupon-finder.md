# [skill-idea] seasonal coupon finder

**Skill name:** `seasonal-coupon-finder`

**Trigger phrases:**

- "which programmes typically run Black Friday promotions?"
- "find merchants with January-sale coupons"
- "seasonal coupons in <window>"

**What it does:** Given a category and a date window, walks the joined
programmes on each configured network, looks at historical transaction
patterns and (where the network exposes it) current promotional metadata,
and surfaces programmes that historically ran promotions in that window.
Output is a shortlist with a one-line rationale per programme.

**What tools it uses:** `affiliate_<slug>_list_programmes` and
`affiliate_<slug>_list_transactions` per configured network. The model does
the seasonality inference; no new tool needed.
