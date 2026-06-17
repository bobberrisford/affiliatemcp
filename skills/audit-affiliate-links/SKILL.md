---
name: audit-affiliate-links
description: |
  Use this skill when the user wants to verify that the affiliate links on their site, in a draft, or in a sitemap are still pointing at active programmes.
  Trigger on: "audit my affiliate links", "check my links still work", "find broken affiliate links", "verify my links track properly".
---

# Operating instructions

You are auditing a publisher's affiliate links. The job has three steps: identify, verify, report.

## Step 1 — gather the links

Accept any of:

- A pasted list of URLs.
- A pasted markdown / HTML document — extract every `<a href>` or `[text](url)`.
- A sitemap URL or path — read it and extract `<loc>` entries.

Filter the extracted URLs down to *affiliate* links. These are well-known host patterns this skill can classify by host on sight:

- `awin1.com`, `awin.com`, `*.awin1.com` — Awin.
- `*.dpbolvw.net`, `*.kqzyfj.com`, `*.tkqlhce.com`, `anrdoezrs.net`, `*.cj.com`, `*.cjlinks.com` — CJ Affiliate.
- `*.impact.com`, `goto.target.com`-style branded vanity hosts that resolve to Impact — Impact (note: many Impact links use brand-vanity hosts, so if you cannot tell, ask the user).
- `click.linksynergy.com`, `*.linksynergy.com`, `*.rakutenmarketing.com` — Rakuten Advertising.

This list is not the set of networks the server supports. The server supports many more networks, and you can read the full set by calling `affiliate_list_networks`. A link that does not match a pattern above is therefore not necessarily a non-affiliate link.

So do not discard an unmatched link. Sort the extracted URLs into three groups:

1. Matches a host pattern above: classify it to that network and carry it into Step 2.
2. Looks like an affiliate or redirect link (for example a tracking subdomain, a `deeplink`/`murl`/`u`/`url` redirect parameter, or a host you do not recognise but that is clearly not the user's own site): carry it into Step 2 and attempt the id-based lookup, or ask the user which network it belongs to. Use `affiliate_list_networks` to offer concrete options.
3. Plainly not an affiliate link (the user's own pages, social links, plain destination URLs): set aside and exclude from the audit.

Only list a link under "could not classify — please confirm" once you have tried Step 2 and still cannot place it.

## Step 2 — extract the programme identifier

Each network encodes the programme id (or advertiser id) in the URL differently. The reliable approach: do not hand-parse. Instead, call `affiliate_list_networks` first to confirm which networks have registered adapters; this does not prove that credentials are configured. Then, for each candidate URL:

1. Match the URL to a network by host. If the host did not match a known pattern in Step 1, use the redirect parameters or the network the user confirmed to pick the candidate adapter from `affiliate_list_networks`; if you still cannot tell, ask rather than guess.
2. Parse the obvious query parameters (`m`, `mid`, `awinmid`, `id`, `merchantid`) — these usually carry the programme id.
3. Call `affiliate_<slug>_get_programme` with that id.
4. If the call fails or returns `status: 'declined' | 'suspended'`, mark the link as **broken**.
5. If the call returns `status: 'joined'`, mark the link as **OK**.
6. If the call returns `status: 'pending' | 'available'`, mark the link as **inactive** with a one-line explanation.

If you cannot extract a programme id confidently, mark the link **unknown** and explain why.

## Step 3 — present results

Output a table:

| Link | Network | Programme | Status | Recommendation |

Recommendations should be matter-of-fact: "Programme is no longer joined; remove or replace with a competing merchant" / "Programme is active; no action" / "Programme id not parseable; verify manually".

## Stretch — regenerate links

When a link is **broken** *and* the network supports link generation, offer to regenerate it. To do this:

1. Confirm with the user that they want to regenerate (don't surprise them).
2. Ask for the destination URL if you do not already have it from the original link.
3. Find an equivalent active programme they have joined — call `affiliate_<slug>_list_programmes` with `status: 'joined'` and a `search` term derived from the broken merchant's domain or name.
4. Once a replacement programme id is confirmed, call `affiliate_<slug>_generate_tracking_link` with `programmeId` and `destinationUrl`.
5. Return the new tracking URL.

Not every network exposes programmatic link generation. If `affiliate_<slug>_generate_tracking_link` returns a `NotImplementedError` or an upstream error, surface it verbatim and fall back to telling the user to regenerate the link in the network dashboard.

## Constraints

- UK spelling throughout.
- Do not invent programme statuses. If `affiliate_<slug>_get_programme` errors, surface the verbatim error from the envelope.
- Do not call `affiliate_<slug>_list_programmes` with no filters across every link — it's wasteful. Look up by id.
- If the user pasted dozens of links, batch the audit and summarise; don't print 200 rows of OK lines.
