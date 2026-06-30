# Unconfigured-credential guidance: turn a confusing 401 into a clear next step

- **Date:** 2026-06-30
- **Status:** Proposed (decision pending)
- **Affects:** the shared credential-loading contract (`src/shared/config.ts`,
  marked STABLE), the `affiliate_list_networks` meta-tool output shape
  (`src/tools/generate.ts`), the `NetworkErrorEnvelope` `hint` content
  (`src/shared/errors.ts`, `src/shared/types.ts`), and onboarding docs for the
  Claude Desktop bundle track.
- **Builds on:** `2026-06-12-host-native-distribution.md` (the `.mcpb` bundle is
  the primary non-technical track), `2026-06-13-privacy-first-telemetry.md` (the
  install-surface signal this reuses), and `2026-06-26-rob-led-delivery-system.md`
  (maintainer-led acceptance of contract changes).

## Context

A publisher installed the Claude Desktop bundle, asked "what was yesterday's
revenue on Awin?", and got a 401. The error body literally showed
`${user_config.awin_api_token}` and `${user_config.awin_publisher_id}` as the
submitted credential values. The user has no way to know, from that screen, that
the real problem is "Awin is not set up yet" or what to do about it.

This is a customer-journey and contract decision, not a feasibility one. The
mechanism is understood end to end:

1. The bundle manifest is generated with each credential mapped to a host
   placeholder, `env["AWIN_API_TOKEN"] = "${user_config.awin_api_token}"`
   (`scripts/build-mcpb.ts:136`), and every credential field is declared
   `required: false` (`scripts/build-mcpb.ts:134`). A user can therefore install
   the bundle and start asking questions without ever entering credentials.
2. When a non-required `user_config` field is left blank, Claude Desktop passes
   the **literal, unsubstituted** placeholder string `${user_config.awin_api_token}`
   as the environment-variable value.
3. The shared credential reader treats only `undefined` and whitespace as
   missing (`getCredential`, `src/shared/config.ts:108-113`). A literal
   placeholder is a non-empty string, so it passes the check.
4. The adapter sends the placeholder to Awin as a bearer token and the upstream
   returns 401. The surfaced error is `auth_error`, not `config_error`.

The project already has the right machinery for an unconfigured network:
`requireCredential` throws a `config_error` envelope carrying a setup `hint`
(`src/shared/config.ts:119-138`). The placeholder simply bypasses it. The job is
to route this state into the existing helpful path and make the guidance
actionable for the user's actual install surface.

Three things make this a decision the delivery protocol requires to be recorded
before code:

1. **It edits a STABLE shared contract.** `src/shared/config.ts` is in the
   "do not modify unless extending the contract is the only path forward" set.
   Credential-presence semantics are depended on by every adapter.
2. **It changes a public meta-tool output shape.** `affiliate_list_networks` is
   part of the external MCP contract. Adding configuration-readiness fields is
   additive public surface.
3. **It changes user-facing error guidance.** The `hint` text downstream MCP
   clients render is being made surface-aware, which is a deliberate
   customer-journey change rather than a private refactor.

## Decision

Treat an unconfigured network as a first-class, recognisable state and guide the
user to the exact fix for their install surface. Four coordinated changes:

1. **Recognise unresolved placeholders and example values as "missing."** In
   `getCredential` (`src/shared/config.ts`), a value that is an unresolved host
   placeholder matching `${user_config.*}` (the bundle case) or one of the
   documented example sentinels (`your-token-here`, `your-id-here` from
   `examples/claude-desktop-config.json`) is treated exactly like a blank value:
   missing. This reroutes the screenshot's scenario from a raw upstream 401 into
   the existing `config_error` path with no new error machinery. The check is a
   narrow, well-bounded string test; it does not attempt to validate real tokens.

2. **Make remediation hints surface-aware.** Add `setupInstructionForSurface()`
   to `src/shared/`, mirroring the established `updateInstructionForSurface()`
   precedent (`src/shared/update-check.ts:165`) and reusing the existing
   `telemetrySurface()` signal (`'mcpb' | 'desktop-bundle' | 'npm' | 'unknown'`,
   `src/shared/telemetry.ts:20`). Bundle/desktop users are told to open the
   Affiliate extension settings in Claude Desktop and fill in the named field;
   CLI/npm users are told to run `affiliate-networks-mcp setup <slug>`. The
   `config_error` hint uses this so the guidance always matches how the user
   installed.

3. **Expose configuration readiness on `affiliate_list_networks`.** Add additive
   per-network fields so the assistant can answer "which networks are ready, and
   what do I do for the ones that are not?" without first triggering a failed API
   call: `configured` (boolean), `missingCredentials` (the env-var names absent
   or unresolved, derived from each adapter's `setupSteps()` and `getCredential`),
   and `setupAction` (the surface-aware instruction). No existing field changes
   and no live network call is added to the listing path.

4. **Document the state.** A short troubleshooting doc for "I asked a question
   and got a 401 / credentials not configured", plus notes in `mcpb/README.md`
   and `docs/networks/awin.md` that leaving bundle fields blank produces this
   state and how to fix it without a terminal.

The boundary, stated as a rule: the server never sends an unresolved placeholder
or documented example value to an upstream API as if it were a real credential,
and an unconfigured network always surfaces as `config_error` with a
surface-correct next step, never as an opaque `auth_error`.

### Out of scope

- The "Could not attach to MCP server affiliate" banner in the same screenshot
  is a connection-level failure, distinct from credentials, and is not addressed
  here. It warrants its own investigation.
- No change to the bundle manifest's `required: false` choice. Making fields
  required is a separate Desktop-UX decision with its own trade-offs (it would
  block install-then-configure-later); this record deliberately fixes the
  runtime behaviour rather than the manifest contract.
- No credential validation beyond presence and the placeholder/sentinel test. We
  do not probe upstream to decide "configured."

## Rejected alternatives

- **Do nothing; rely on the model to explain the 401.** In the screenshot Claude
  did eventually reason its way to "credentials are not configured", but only
  after a failed round-trip, and the user was still left without a concrete next
  action. Inconsistent and journey-hostile.
- **Fix only the placeholder check (Phase 1) and stop.** This removes the
  confusing 401 but still leaves generic, surface-blind guidance and no way for
  the assistant to proactively report readiness. Acceptable as a minimal hotfix
  if the wider record is rejected, but it under-serves the stated outcome.
- **Make the bundle credential fields `required: true`.** Forces configuration at
  install time, but breaks the legitimate install-now-configure-later flow and
  the multi-network bundle where a user configures only the networks they use.
  Rejected in favour of a graceful runtime state.
- **Add a brand-new `affiliate_setup_status` meta-tool.** Rejected for now:
  `affiliate_list_networks` is the natural home for readiness, and adding a tool
  expands the public surface more than needed. Revisit only if the listing tool
  proves the wrong seam.
- **Detect placeholders inside each adapter.** Rejected: this is provider-neutral
  behaviour and belongs in the shared credential reader, not duplicated across 86
  adapters.

## Consequences and implementation follow-ups

Keep all dependent implementation in draft until this record is accepted.

- **PR 0 (this record):** the decision and the workstream brief below.
  Docs-only.
- **PR 1, foundation + first consumer:** the `getCredential` placeholder/sentinel
  recognition plus `setupInstructionForSurface()` and the surface-aware
  `config_error` hint, with focused unit tests and an Awin integration test
  asserting `config_error` (not `auth_error`) when the placeholder is set. This
  touches the STABLE shared contract, so it takes an independent agent review
  plus green CI as the backstop, then Rob's deliberate acceptance. Do not request
  `@offmann`.
- **PR 2, public-surface slice:** the additive `configured` /
  `missingCredentials` / `setupAction` fields on `affiliate_list_networks`, with
  tool-output tests covering configured and unconfigured states. Depends on PR 1
  for the shared presence/placeholder helper.
- **PR 3, docs:** troubleshooting doc plus `mcpb/README.md` and
  `docs/networks/awin.md` notes. Docs-only; can land in the routine lane once the
  behaviour in PR 1 and PR 2 is merged so docs and behaviour never disagree.

### Workstream brief

- **User outcome:** a user whose network is not yet configured (especially a
  Desktop-bundle user who left fields blank) gets a clear, surface-correct "set
  up <network> here" message instead of a confusing 401, and the assistant can
  proactively tell them which networks are ready.
- **Primary cohorts:** publishers and semi-technical operators on the Claude
  Desktop bundle track; secondarily CLI users.
- **Dependency graph:** PR 0 (decision) -> PR 1 (shared foundation + hint
  consumer) -> PR 2 (meta-tool readiness, depends on PR 1's helper) -> PR 3
  (docs, depends on PR 1+PR 2 behaviour).
- **Owning domains:** shared credential/config contract (PR 1), MCP tool
  generation (PR 2), onboarding docs (PR 3). Disjoint enough that PR 2 and PR 3
  can occupy the two routine lanes once PR 1 lands; PR 1 is the single
  active-risk PR.
- **Risk gates:** PR 1 is risk-based (STABLE shared contract + user-facing error
  text) and needs independent review + green CI + Rob's acceptance. PR 2 is a
  public-contract change but additive and decision-complete once this record is
  accepted. PR 3 is routine docs.
- **Acceptance proof per PR:** PR 1, unit test that `getCredential` returns
  `undefined` for `${user_config.awin_api_token}` and for the example sentinels,
  plus an adapter test that `listProgrammes()` rejects with a `config_error`
  envelope carrying a surface-aware hint; `npm test` + `npm run typecheck`. PR 2,
  call `affiliate_list_networks` with and without Awin creds via `npm run dev`
  and confirm the `configured` flag flips and `missingCredentials` is accurate;
  tool-output tests. PR 3, `git diff --name-only` shows docs only.
- **Stop conditions:** if Rob rejects the shared-contract change, fall back to
  the minimal hotfix (PR 1 placeholder recognition only, generic hint) and drop
  PR 2. If the placeholder pattern proves host-version-specific, narrow the test
  and document the exact Desktop versions covered rather than broadening it.

## Open questions for the maintainer

- **Example sentinels:** treat the documented `your-token-here` / `your-id-here`
  examples as missing too (recommended, since copy-paste-without-editing is a
  real failure mode), or only the `${user_config.*}` host placeholders?
- **Readiness home:** confirm `affiliate_list_networks` is the right surface for
  configuration readiness, versus a dedicated `affiliate_setup_status` tool.
- **Manifest fields:** leave bundle credential fields `required: false` as this
  record assumes, or revisit requiredness as a separate Desktop-UX decision?
