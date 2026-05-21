# [skill-idea] programme categorisation auditor

**Skill name:** `programme-categorisation-auditor`

**Trigger phrases:**

- "are any of my programmes mis-categorised?"
- "audit programme categories"
- "find programmes whose category doesn't match their site"

**What it does:** Lists joined programmes across every configured network,
inspects each programme's declared category and its merchant URL, and flags
ones where the category looks inconsistent with what the merchant actually
sells. Output is a per-network list of suspect programmes with a short
rationale.

**What tools it uses:** `affiliate_<slug>_list_programmes` per configured
network, with the model doing the inconsistency check on the category /
merchant-URL pair. No new MCP tool is required.
