---
name: partner-application-queue
description: |
  Use this skill when an agency operator wants the list of partner applications waiting on a decision for a brand: who has applied to the programme and is sitting in the pending queue. The output is a read-only queue; the approve or decline happens in the network dashboard.
  Trigger on: "Which partner applications are pending on Acme?", "Acme's application queue", "Who's waiting for approval on [brand]?", "Show me pending partners for Acme".
---

# Operating instructions

You are listing the partners in one brand's application queue: relationships
that are pending a decision, so the account manager knows what is waiting on
them. This is the pending slice of the roster; for the full roster split and the
dormant-partner worklist, use `partner-roster-audit`.

## Step 1 — resolve the brand

If the user did not name a brand, ask which one. Do not guess.

Call `affiliate_resolve_brand`. If the user named a network, pass `{ network: "<slug>" }` to filter; otherwise call with no arguments and filter the result to the brand the user named.

The response is an array of `{ brand, network, networkBrandId }`. Reduce it to the bindings whose `brand` matches the user's brand. If none remain, tell the user the brand is not registered, suggest `affiliate_resolve_brand` with no args to see what is, and stop.

## Step 2 — check status support per network

Call `affiliate_run_diagnostic` for the brand's bound networks and retain the
operation matrix. Call `affiliate_list_networks` once and retain each binding's
metadata, including `knownLimitations` and any per-operation claim-status
overrides. Partner application status is the load-bearing field here, and its
coverage varies by adapter. Use the diagnostic operation support plus the
metadata to decide:

- whether the network supports `listMediaPartners` / `list_media_partners` at
  all (without it there is no queue to read — report the gap and continue);
- whether a `pending` status genuinely means "application awaiting a decision"
  on this network, or whether the adapter only reports a coarser status. If the
  network cannot distinguish a pending application, say so for that binding
  rather than presenting an empty or inferred queue as fact.
- whether the relevant operation is `partial` or `experimental`; surface that
  caveat in the coverage notes instead of presenting the queue as fully proven.

## Step 3 — read the queue per binding

For each `(brand, network)` binding, call the roster tool and filter to the
pending status. Tool names follow `affiliate_<network>_list_media_partners`:

- Awin advertiser: `affiliate_awin-advertiser_list_media_partners({ brand })`

Pass `brand` exactly as it came back from `affiliate_resolve_brand`. Each call
returns `MediaPartner[]` with `id`, `name`, and `status`. Keep only the
partners whose `status` is `pending`. Keep each binding's queue separate;
partner ids are network-specific.

If a call fails, surface the verbatim error (network, operation, message,
httpStatus). Do not treat a failure as an empty queue. Continue with the
remaining bindings and flag the gap.

## Step 4 — present the queue

Output in this order, per network binding:

1. **Brand and network**.
2. **Pending applications**: each partner by name and id, in the order the
   network returned them. If the adapter exposes nothing beyond name, id, and
   status, present exactly that and no more.
3. **Empty queue**: if a binding genuinely returns no pending partners, say
   "no applications pending" for that binding. Distinguish this from a binding
   where the queue could not be read.
4. **Coverage notes**: any binding where pending status is inferred or
   unsupported, stated plainly.
5. **Failures (if any)**: per-network verbatim error from the envelope.

End with a one-line reminder: this is a read-only queue. Approving or declining
an application happens in the network dashboard, not through this skill.

Matter-of-fact tone, UK spelling, no hype.

## Constraints

- Read-only. This skill lists the queue; it never approves or declines an
  application. Do not imply a write is available.
- Never invent applications or pad the queue. An unreadable queue is
  "unavailable on this network", not zero pending.
- Partner status coverage varies by adapter. Where `pending` cannot be
  distinguished, report that limitation instead of guessing the queue.
- Keep each network's queue separate; do not merge partner ids across networks.
