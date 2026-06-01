# AI-native affiliate data

This repo should make affiliate network APIs usable from the AI tools where
affiliate professionals already work. The product is not a dashboard clone. It
is a clean, local-first data and action layer that lets an assistant answer
questions, generate briefs, inspect edge cases, and prepare safe next actions
using the network access a user is already allowed to use. The preferred path is
a network's public API; where none exists, the layer can drive the user's own
authenticated dashboard session.

## Users

- **Publisher affiliate professionals** who need to inspect programmes, offers,
  tracking links, transactions, pending commissions, reversals, and performance
  without hopping between dashboards.
- **Advertiser or brand affiliate professionals** who run programmes and want
  AI-native access to partner, campaign, validation, and offer workflows. This
  is roadmap for Awin in this PR; publisher APIs come first.
- **Developers and data teams** building internal tools, reporting workflows,
  reconciliation jobs, or agent-native affiliate operations on top of public
  affiliate network APIs.
- **Affiliate network employees or implementation partners** exploring how
  their own data and API surfaces should appear in AI clients.

## Product principle

AI-native affiliate data means three things:

1. **The model gets safe typed tools, not raw screens.** MCP tools should map to
   a typed contract with typed inputs, explicit auth requirements, raw network
   data preserved, and clear error envelopes, whether an operation is backed by a
   documented API or a browser-driven session.
2. **The user gets workflows, not endpoint trivia.** MCP prompts should encode
   common affiliate journeys: performance briefs, offer discovery, link
   generation, transaction investigation, and programme opportunity scans.
3. **The repo keeps network truth visible.** Every supported endpoint should
   have inventory status, fixture tests, live validation notes, and known gaps.

MCP fits this shape because servers expose model-callable tools, application
selected resources, and user-invoked prompts as separate concepts. The MCP docs
describe tools as schema-defined operations and prompts as reusable templates
for workflows: https://modelcontextprotocol.io/docs/learn/server-concepts.

## Why Awin first

Awin is the reference implementation because its publisher API has enough
surface area to exercise the architecture: account discovery, programme
metadata, commission groups, transactions, transaction-by-ID lookup, aggregated
reports, offers, Link Builder, and gated product/proof-of-purchase surfaces.
It also has real product nuance:

- `GET /accounts?type=publisher` derives `AWIN_PUBLISHER_ID`.
- Transactions have a 31-day date-window cap and status normalisation quirks.
- Link Builder has both deterministic URL construction and official API
  generation paths.
- Product Feeds and Proof of Purchase are public but require separate
  credentials or activation, so safe stubs are part of the product contract.

Once Awin is excellent, other networks should copy the shape: endpoint
inventory first, network-specific tools second, journeys third, abstractions
last.

## Repository shape

- `src/networks/awin/adapter.ts` remains the facade for the canonical seven
  publisher operations.
- `src/networks/awin/endpoints/` contains endpoint-focused Awin modules for
  accounts, programmes, transactions, reports, links, offers, and gated
  surfaces.
- `src/networks/awin/tools.ts` registers Awin-specific MCP tools that expose
  public Awin APIs beyond the canonical cross-network set.
- `src/prompts/generate.ts` registers MCP prompts for affiliate workflows.
- `docs/networks/awin/api-inventory.md` records endpoint-by-endpoint support,
  live-test status, and gaps.

The rule is intentionally conservative: do not create cross-network
abstractions until at least Awin and one other network prove the same concept
is genuinely shared.

## Roadmap

1. **Local stdio MCP server.** Keep the current local server simple and easy to
   inspect. Users bring their own API keys and credentials stay on their host.
2. **Awin reference quality.** Exhaustively cover Awin publisher public APIs
   with docs, fixtures, read-only live validation, and prompts.
3. **Skills and prompt packs.** Package common workflows so Claude, Codex,
   Cursor, and similar clients can guide users through real affiliate tasks
   without memorising tool names. MCP's deployment guidance frames skills as
   portable instruction sets for tool patterns and auth decisions:
   https://modelcontextprotocol.io/docs/develop/build-with-agent-skills.
4. **MCPB packaging.** When local installation friction matters, package the
   server and runtime as an MCP bundle.
5. **Remote Streamable HTTP.** For teams that want managed auth, centralised
   deployment, audit logs, or OAuth redirect handling, add a remote MCP server
   path. Keep local-first as the privacy-preserving baseline.
6. **Resources and apps.** Add resources for static API inventories and, later,
   richer UI widgets for offer pickers, performance tables, and link builders
   if plain tool results are not ergonomic enough.
