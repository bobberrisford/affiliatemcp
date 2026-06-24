---
name: partner-application-queue
description: |
  Use this skill when an agency operator wants the list of partner applications waiting on a decision for a brand: who has applied to the programme and is sitting in the pending queue. The output is a read-only queue; the approve or decline happens in the network dashboard. How the queue is read depends on the network. Some advertiser networks expose application status through the API. Awin does not: its advertiser API returns only joined publishers with no application status, so Awin's pending queue is read from the operator's own authenticated Awin session (new UI, app.awin.com) through Claude-in-Chrome, read-only. Awin Classic (ui.awin.com) accounts have no equivalent and are detected and stopped.
  Trigger on: "Which partner applications are pending on Acme?", "Acme's application queue", "Who's waiting for approval on [brand]?", "Show me pending partners for Acme".
---

# Operating instructions

You are listing the partners in one brand's application queue: relationships
that are pending a decision, so the account manager knows what is waiting on
them. This is the pending slice of the roster; for the full roster split and the
dormant-partner worklist, use `partner-roster-audit`.

This skill is read-only. It lists the queue; it never approves or declines an
application. To actually work through Awin's pending publishers and approve or
decline them under a single human confirmation, use
`awin-application-auto-approval`.

How the queue is read depends on the network:

- **Most advertiser networks** that support `list_media_partners` report an
  application status the adapter can map to `pending`, so the queue is read
  through the API.
- **Awin advertiser** does not. Its advertiser API endpoint
  (`GET /advertisers/{id}/publishers/`, behind
  `affiliate_awin-advertiser_list_media_partners`) returns only publishers that
  have already joined the programme and carries no application-status or
  relationship field. The adapter's status mapping therefore returns `unknown`
  for every row and a pending application never appears. Awin's pending queue
  lives only in the new Awin UI ("Pending partners" on the partnerships page),
  so it is read in the browser, read-only. Do not present the API roster as a
  pending queue.

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
metadata to decide, per binding:

- **Awin advertiser**: treat the API as unable to report the pending queue, for
  the reason above. The pending queue is read in the browser in Step 3, not
  through `list_media_partners`. Do not filter the API roster to `pending` and
  present the result as the queue: every row maps to `unknown`, so an API filter
  would always return empty and misrepresent an unreadable queue as zero
  pending.
- **Every other network**: decide from the diagnostic and metadata whether the
  network supports `list_media_partners` at all (without it there is no queue to
  read, so report the gap and continue); whether a `pending` status genuinely
  means "application awaiting a decision" on this network, or whether the adapter
  only reports a coarser status (if it cannot distinguish a pending application,
  say so for that binding rather than presenting an empty or inferred queue as
  fact); and whether the relevant operation is `partial` or `experimental`, in
  which case surface that caveat in the coverage notes.

## Step 3 — read the queue per binding

Keep each binding's queue separate; partner ids are network-specific. If a read
fails, surface the verbatim error (network, operation, message, httpStatus). Do
not treat a failure as an empty queue. Continue with the remaining bindings and
flag the gap.

### 3a — Awin advertiser (browser, new UI only, read-only)

Take the brand's `networkBrandId` for `awin-advertiser` from the Step 1 result.
This is the Awin advertiser accountId (the advertiserId).

Navigate (Claude-in-Chrome) to
`https://app.awin.com/en/awin/advertiser/{advertiserId}/partnerships/all`, using
`mcp__Claude_in_Chrome__navigate` with that advertiserId. Dismiss the "Welcome to
your new Awin" modal if it is present. Handle the cookie banner
privacy-preservingly: choose Reject or decline non-essential cookies, not Accept
all.

Then check the final URL. If it has redirected to `ui.awin.com` (Awin Classic),
STOP the Awin path and record for that binding: "this account is on Awin Classic;
its pending application queue is not readable here." Awin Classic has no
equivalent partnerships page. Do not attempt a Classic flow.

On the new UI, read the "Pending partners" section using
`mcp__Claude_in_Chrome__read_page`, `mcp__Claude_in_Chrome__get_page_text`, or
`mcp__Claude_in_Chrome__find`. For each pending applicant, capture what the page
shows: name, publisher id, website, primary promotional type, primary sector,
and the Pending status. This is the Awin queue. Read only; do not click any
approve, decline, or other control on the page.

### 3b — other advertiser networks (API)

For each non-Awin `(brand, network)` binding that Step 2 confirmed can report a
pending application, call the roster tool and filter to the pending status. Tool
names follow `affiliate_<network>_list_media_partners`. Pass `brand` exactly as
it came back from `affiliate_resolve_brand`. Each call returns `MediaPartner[]`
with `id`, `name`, and `status`. Keep only the partners whose `status` is
`pending`.

For a binding where Step 2 found that `pending` cannot be distinguished, do not
run an API filter and present it as the queue. Report it in the coverage notes
as a binding whose pending queue is not API-readable.

## Step 4 — present the queue

Output in this order, per network binding:

1. **Brand and network**, and how the queue was read (API, or browser read of
   the new Awin UI).
2. **Pending applications**: each partner by name and id, in the order they were
   returned. For Awin, present only what the partnerships page showed. If a
   source exposes nothing beyond name, id, and status, present exactly that and
   no more.
3. **Empty queue**: if a binding genuinely returns no pending partners (an API
   roster with no pending rows, or an Awin partnerships page with no "Pending
   partners"), say "no applications pending" for that binding. Distinguish this
   from a binding where the queue could not be read.
4. **Coverage notes**: any binding where the pending queue is not readable,
   stated plainly. This includes Awin Classic accounts, any network whose
   adapter cannot distinguish a pending application, and any network missing
   `list_media_partners` entirely.
5. **Failures (if any)**: per-network verbatim error from the envelope, or the
   browser read failure for Awin.

End with a one-line reminder: this is a read-only queue. Approving or declining
an application happens in the network dashboard, not through this skill; for
Awin specifically, `awin-application-auto-approval` carries out the decisions
under a single human confirmation.

Matter-of-fact tone, UK spelling, no hype.

## Constraints

- Read-only. This skill lists the queue; it never approves or declines an
  application. For Awin the queue read is a browser navigation that touches no
  approve, decline, or other control. Do not imply a write is available.
- Awin's pending queue is not API-readable. The Awin advertiser API returns only
  joined publishers with no application status, so never filter
  `affiliate_awin-advertiser_list_media_partners` to `pending` and present the
  result as the queue. Read the queue from the new-UI partnerships page instead.
- Awin Classic (ui.awin.com) accounts have no partnerships page; detect the
  redirect and report the queue as unreadable for that binding rather than
  guessing.
- Never invent applications or pad the queue. An unreadable queue is
  "unavailable on this network", not zero pending.
- Partner status coverage varies by adapter. Where `pending` cannot be
  distinguished, report that limitation instead of guessing the queue.
- Keep each network's queue separate; do not merge partner ids across networks.
</content>
</invoke>
