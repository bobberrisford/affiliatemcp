# <NETWORK_NAME> adapter

> Template setup doc. Replace `<NETWORK_NAME>` and fill every section before submitting a PR.

## Prerequisites

- A publisher account on <NETWORK_NAME> (signup link).
- API access granted (some networks require approval — note the typical wait time here).

## Credentials needed

- `TEMPLATE_NETWORK_API_TOKEN` — where to find it (screenshot path).

## Setup steps

1. Sign in at https://example.com.
2. Navigate to Account → API.
3. Copy your API token into the wizard prompt.

## Common failures

1. **Approval pending** — what the user sees, how to confirm, expected wait.
2. **Wrong region** — what the symptoms look like, how to switch.
3. **Token scope too narrow** — which scope is required, where to widen it.

## Known limitations

- (List the operations the adapter does NOT support and why.)

## Verifying

```
affiliate-mcp validate <slug>
```
