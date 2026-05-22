# <NETWORK_NAME> adapter

> Template setup doc. Copy to `docs/networks/<slug>.md` and replace
> `<NETWORK_NAME>` throughout. Fill every section before submitting a PR.
> Reference: `docs/networks/awin.md`.

## Prerequisites

- A publisher account on <NETWORK_NAME> (signup link).
- API access granted. Some networks require manual approval — state the
  typical wait time here if so.
- Region / locale notes if the network's API is regional (Rakuten US vs JP).

## Credentials needed

- `TEMPLATE_NETWORK_API_TOKEN` — verbatim dashboard path to find it.

For each env var your `network.json` declares, give the user the literal
button names they will see on the dashboard. No paraphrasing.

## Setup steps

1. Sign in at https://example.com.
2. Navigate to Account → API.
3. Copy your API token into the wizard prompt.

If your network gates a credential behind manual approval, name that step
explicitly with the expected turnaround.

## Common failures

List the failures users actually hit, with what they see, how to confirm, and
how to recover. Three real failures beats a generic list.

1. **Approval pending** — what the user sees, how to confirm, expected wait.
2. **Wrong region** — what the symptoms look like, how to switch.
3. **Token scope too narrow** — which scope is required, where to widen it.

## Known limitations

Mirror `known_limitations` in `network.json` here in prose. Be specific:
"Click-level data not exposed via the public API" is fine; "some limitations"
is not.

## Verifying

```
affiliate-networks-mcp test <slug>
```

The CLI runs the live diagnostic — same engine as
`npm run validate:network -- <slug>`. The diagnostic engine's pass is the
verification contract.
