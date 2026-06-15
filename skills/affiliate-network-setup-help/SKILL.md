---
name: affiliate-network-setup-help
description: |
  Use this skill when the user is trying to set up a specific affiliate network and needs help finding credentials, navigating the dashboard, or understanding the setup steps.
  Trigger on: "help me set up Awin", "how do I get a CJ API token", "setup help", "I'm stuck on Impact setup".
---

# Operating instructions

You are walking a publisher through credential acquisition for one named affiliate network. This is a conversational skill — expect follow-ups. Be patient and precise.

## Supported networks

This server ships adapters for many affiliate networks. `affiliate_list_networks` is the authoritative list of adapters registered in this server — call it rather than relying on a fixed set. It does not prove that the user has configured credentials. This skill carries detailed, hand-written setup walkthroughs for the four launch networks (`awin`, `cj`, `impact`, `rakuten`); every other registered network is set up the same way through its `docs/networks/<slug>.md` guide and the adapter's `setupSteps()` (Step 2 and Step 3 below). If the user names a network `affiliate_list_networks` does not return, say the server has no registered adapter for it and stop.

## Step 1 — identify the network

The user usually names it. If they describe it indirectly ("the one I use for Amazon"), map it to a network slug and confirm against `affiliate_list_networks` rather than assuming. If they hesitate between two networks, ask which dashboard they currently log into. When credential state matters, use `affiliate_run_diagnostic` or recommend `affiliate-networks-mcp doctor <slug>` rather than inferring it from `affiliate_list_networks`.

## Step 2 — read the setup doc

The canonical source per network is `docs/networks/<slug>.md` in this repo (e.g. `docs/networks/awin.md`, `docs/networks/cj.md`, etc.). These docs walk through:

- Where to sign up (if relevant).
- Where in the dashboard the credential lives (exact menu path and UI labels).
- How long approval typically takes.
- Which environment variables this server expects (e.g. `AWIN_API_TOKEN`, `AWIN_PUBLISHER_ID`).

**Read the file, then quote the relevant section back.** Do not paraphrase UI labels — the dashboard's wording is the user's anchor.

## Step 3 — fallback if the doc is missing

If `docs/networks/<slug>.md` does not exist (this can happen in early dev), fall back to the adapter's own `setupSteps()`. The information is the same shape — `field`, `label`, `description`, `example` — and is the authoritative list of what the wizard collects. You can surface this by suggesting the user run `affiliate-networks-mcp setup` and walking through what each prompt will ask for, based on the adapter's setup steps. Hand-written quick references for the four launch networks follow; for any other network, read its `setupSteps()` (or `docs/networks/<slug>.md`) directly rather than guessing:

- **Awin** (`AWIN_API_TOKEN`, `AWIN_PUBLISHER_ID`): token from https://ui.awin.com/awin/publisher/profile/api; publisher id derived after auth.
- **CJ Affiliate** (`CJ_API_TOKEN`, `CJ_COMPANY_ID`): personal access token from https://developers.cj.com/account/personal-access-tokens; company id from the dashboard footer or via the developer portal.
- **Impact** (`IMPACT_ACCOUNT_SID`, `IMPACT_AUTH_TOKEN`): both from https://app.impact.com → Settings → API → API Credentials.
- **Rakuten Advertising** (`RAKUTEN_CLIENT_ID`, `RAKUTEN_CLIENT_SECRET`, `RAKUTEN_SID`): OAuth2 client created via https://developers.rakutenadvertising.com → My Apps; SID from the publisher dashboard. **Note: Rakuten requires manual approval, typically 5 working days.**

Use the fallback only when the doc is missing. Do not duplicate effort.

## Step 4 — handle follow-ups

The user will ask things like:

- "Where is that menu?" — name the exact UI path. If the doc lists it, quote it verbatim.
- "I don't see the option." — ask which account type they have (publisher vs advertiser). Publisher credentials live under the publisher dashboard; advertiser-side adapters use the advertiser dashboard. The exact path is in the network's setup doc.
- "It says I'm not approved yet." — confirm approval timelines: Awin/CJ/Impact are usually instant for the API surface; Rakuten requires manual review.
- "Where do I paste these?" — they get persisted into `.env` (or whatever `affiliate-networks-mcp setup` writes to). Suggest running `affiliate-networks-mcp setup` and pasting them when prompted — the wizard validates each before persisting.

## Step 5 — offer to launch the wizard

Once the user says "I have the credentials" — recommend running `affiliate-networks-mcp setup` (or `affiliate-networks-mcp setup <slug>` to target one network). Tell them:

- It validates each credential before saving by calling the adapter's `verifyAuth`.
- It will refuse to overwrite an existing `.env` unless `--force` is passed.
- After setup, `affiliate-networks-mcp doctor` runs the full capabilities diagnostic, which is the same thing the `affiliate_run_diagnostic` MCP tool produces.

## Constraints

- UK spelling.
- Reference exact env var names (capitalised, underscored — `AWIN_API_TOKEN`, not "the Awin token").
- Reference exact CLI commands (`affiliate-networks-mcp setup`, `affiliate-networks-mcp doctor <slug>`, `affiliate-networks-mcp test <slug>`).
- Do not invent dashboard UI elements. If the doc doesn't say where something lives and you don't remember, ask the user what they see.
- Do not solve the problem for them — guide. The credentials must come from their dashboard, not yours.
