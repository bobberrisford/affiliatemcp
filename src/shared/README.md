# `src/shared/`

Load-bearing primitives every network adapter speaks. These files are
stable by design — adapters depend on them and changing the contract
breaks every adapter at once. Open an issue before modifying.

- `types.ts` — the `NetworkAdapter` interface, the seven operation
  signatures, `NetworkMeta` (with `side` and `credentialScope`), and
  the `NetworkErrorEnvelope` shape every failure surfaces through.
- `errors.ts` — `buildErrorEnvelope` and friends. Principle 4.1 lives
  here: errors name the network and operation and carry the verbatim
  upstream body, never invent success.
- `resilience.ts` — the `withResilience` wrapper (timeout + retry +
  circuit breaker). Every outbound HTTP call goes through it.
- `config.ts` — credential loader. Reads `~/.affiliate-mcp/.env` (or
  `AFFILIATE_MCP_CONFIG_DIR`) and surfaces missing values as
  `config_error` envelopes.
- `brands.ts` / `brand-resolver.ts` — the `~/.affiliate-mcp/brands.json`
  registry and the resolver that translates a publisher-facing
  `brand` nickname to a `networkBrandId` before calling an advertiser
  adapter.
- `registry.ts` — adapter registry; each adapter calls `registerAdapter`
  on import.
- `diagnostic.ts` — `validateNetwork(slug)`, the verification engine
  the `doctor` and `test` CLIs use.
- `logging.ts` — pino logger; stderr-only because stdout is the MCP
  transport.
