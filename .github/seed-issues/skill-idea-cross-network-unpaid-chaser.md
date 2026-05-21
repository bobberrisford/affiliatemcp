# [skill-idea] cross-network unpaid-sale chaser

**Skill name:** `cross-network-unpaid-chaser`

**Trigger phrases:**

- "what payments are overdue across all my networks?"
- "show me transactions stuck in pending past the lock date"
- "which sales haven't been paid yet?"

**What it does:** For every configured network, calls `list_transactions`
filtered to `status: pending` and aggregates the results into a single list
sorted by age. Flags transactions older than each network's documented lock
date as overdue. Output is a follow-up list (network, programme, transaction
id, age in days, amount, currency).

**What tools it uses:** `affiliate_list_networks`, `affiliate_<slug>_list_transactions`
for each configured network, optionally `affiliate_<slug>_get_programme` to
attach merchant names where the transaction record carries only an id.
