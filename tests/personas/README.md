# Persona-testing harness

A reusable regression gate that drives the real generated tool surface
(`generateAllTools()` → `ToolDefinition.handle`) as each target persona would,
against a mocked `globalThis.fetch` backed by `tests/fixtures/<slug>/`. It is
the workflow-layer half of the persona-testing plan; the hosted connect +
billing layer is tested separately (see the plan and the hosted branch).

## Personas

- **agency-account-manager** — advertiser-side reporting (brand resolution,
  advisory strategy, per-publisher performance).
- **publisher** — cross-network earnings, including partial failure.
- **semi-technical-operator** — first-run discovery, diagnostic, and auth check.

## Run it

```
npm test                         # includes the persona gate (vitest glob)
npm run persona:report           # human-readable transcript of every scenario
npm run persona:report -- <id>   # one scenario
```

## Add a scenario

1. Write `scenarios/<persona>/<id>.scenario.ts` exporting a `PersonaScenario`
   (see `harness/types.ts`). Express a skill journey as its documented
   underlying tool-call sequence (a `SkillStep`), per the skill's `SKILL.md`.
2. Reuse fixtures under `tests/fixtures/<slug>/`; never add real credentials.
   A network without a fixture needs a scrubbed fixture added first.
3. Register it in `scenarios/index.ts`.

## What this gate proves — and what it does not

It proves the **data and envelopes** a persona relies on are correct:

- envelope correctness (Principle 4.1): failures name the network and
  operation, carry the verbatim upstream body, and are never a generic "an
  error occurred";
- no invented data: an empty or failed figure is surfaced, never zero-filled;
- honest limitation surfacing: `not_implemented` / API gaps propagate;
- journey completeness: the mandated tool sequence ran (e.g. both comparison
  windows were fetched, the plan was read before the verdict);
- UK spelling in server-authored tool descriptions.

It does **not** prove the final rendered report reads well. There is no model
in the loop, so prose quality, framing, and tone are out of scope here — the
harness validates the inputs a skill composes, not the composition itself.

Tiers (`entitlementTier`) are descriptive only at this layer: they are enforced
by the hosted service, not the local core. The hosted persona harness reuses
these scenarios through the transport to assert the tier gate.
