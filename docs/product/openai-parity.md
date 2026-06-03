# OpenAI parity plan

This project should bring affiliate data to the AI workspace the user already
uses, without changing the local-first, bring-your-own-keys stance. OpenAI
parity needs more than one milestone because Codex and ChatGPT use different
MCP surfaces.

## Codex

Codex is the first supported OpenAI surface. This milestone uses local stdio
MCP, the same transport the server already exposes:

```bash
npx affiliate-networks-mcp install --codex
```

The installer writes `~/.codex/config.toml` so Codex can start the existing MCP
server with:

```bash
npx -y affiliate-networks-mcp
```

No new server transport is needed for Codex. No affiliate credentials leave the
user's machine.

## ChatGPT

ChatGPT connector support is planned separately. ChatGPT requires a reachable
HTTPS MCP endpoint, so it should not be bundled into the Codex stdio milestone.
That follow-up needs explicit decisions on exposure, authentication, consent,
auditability, and failure modes.

## Possible ChatGPT approaches

Future work should evaluate these options rather than implement them here:

- `serve --chatgpt` using local HTTP MCP, a Cloudflare quick tunnel, and a
  bearer token, as discussed in issue #25.
- OpenAI Secure MCP Tunnel as an alternative worth evaluating before choosing a
  tunnel strategy.
- A named Cloudflare tunnel as a possible v2 when stable URLs matter.

Any ChatGPT path must preserve the project's local-first defaults and make the
network boundary clear to the user.

## Deep Research and Company Knowledge

Deep Research and Company Knowledge should remain separate future work. They
likely need a different `search` and `fetch` tool shape optimised for retrieval,
not the current affiliate operation tools. Mixing those surfaces into the
current tool contract would make the first OpenAI milestone too broad and would
blur the difference between operational affiliate data and research retrieval.
