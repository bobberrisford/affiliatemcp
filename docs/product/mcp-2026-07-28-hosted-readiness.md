# Hosted readiness plan: MCP 2026-07-28

Companion execution plan to
[`docs/decisions/2026-07-29-mcp-2026-07-28-early-adoption.md`](../decisions/2026-07-29-mcp-2026-07-28-early-adoption.md)
(proposed). That record holds the decision, the risk gates, and the PR-A to
PR-D workstream brief; this document holds the concrete engineering detail for
getting the live hosted connector set up and ready, so the implementation PR
can start the moment the decision is accepted. Nothing here authorises work
the decision record does not.

## Verified current state (2026-07-29)

- **Transport:** a Node service in the root workspace
  (`src/hosted-transport/`), served from a Cloudflare Containers Worker at
  `mcp.agenticaffiliate.ai`. The image is built from the repo-root
  Dockerfile, so it bundles all of `src/`.
- **Deploy:** `.github/workflows/deploy-containers.yml` redeploys on any
  push to `main` touching `src/hosted-transport/**`, after each Publish run,
  or by manual dispatch. A PR-C merge therefore deploys itself; the flag
  below is what makes that safe.
- **Auth and custody:** bearer token verified per request against the
  `hosted/` Worker (`session-auth.ts`); vault credentials resolved per call
  (`dispatch.ts`); tier gate and meter per call. All already per-request.
- **The only protocol-level state:** the SDK session map in
  `http-server.ts` (per-session `Server`/transport pairs keyed on
  `mcp-session-id`, SSE GET streams). This is what the 2026-07-28 revision
  removes, and it is SDK plumbing, not our domain state.
- **MCP surface served today:** `tools/list`, `tools/call`, `prompts/list`,
  `prompts/get` (`mcp-server.ts`), plus the SDK's own lifecycle handling.
- **Test seam that already exists:** `tests/hosted-transport/http-server.test.ts`
  boots the real transport against an in-process fake hosted Worker
  (session, meter, vault endpoints). The conformance harness reuses this
  seam; no live tenant and no network access are needed for conformance
  runs.
- **Toolchain facts:** SDK 1.30.0 tops out at protocol `2025-11-25`; the
  official conformance suite `0.2.0-alpha.10` (2026-07-27) covers
  `Mcp-Method` routing, `server/discover`, and stateless behaviour.

## Readiness steps

### R1. Conformance baseline (PR-B, routine lane, can start now)

Goal: know exactly where the live shape stands before changing anything.

- Bump `@modelcontextprotocol/sdk` 1.29.0 to 1.30.0; run `npm run verify`.
  Expected: no behavioural change (same protocol ceiling).
- Add `@modelcontextprotocol/conformance` pinned to `0.2.0-alpha.10` as a
  dev dependency.
- Add `scripts/conformance-hosted.ts` and an `npm run conformance:hosted`
  script: boot the transport on an ephemeral port against the fake-Worker
  seam (extracted from `http-server.test.ts` into a shared test helper),
  run the suite, print a scenario-by-scenario table.
- Record the baseline (which scenarios pass on the legacy sessionful path,
  which stateless scenarios fail and why) in the PR brief. The failures are
  the specification of R3.
- Wire a CI step into the `build` job of `ci.yml` running the legacy-path
  scenarios only, so the baseline cannot silently rot.

Deliverable: a repeatable, numbers-on-the-table statement of readiness.

### R2. Stateless handler design (discovery, this document)

The design the implementation PR will follow:

- **New file `src/hosted-transport/stateless-handler.ts`.** A pure
  per-request JSON-RPC handler, no SDK `Server` instance, no transport
  object, no session map. It serves exactly: `server/discover`,
  `tools/list`, `tools/call`, `prompts/list`, `prompts/get`.
- **Routing rule in `http-server.ts`:** a request carrying an `Mcp-Method`
  header takes the stateless path; an `initialize` body or an
  `mcp-session-id` header takes the legacy path unchanged. Neither path
  imports the other.
- **Shared pipeline, not duplicated logic.** The stateless path runs the
  identical per-request sequence the legacy `tools/call` handler runs
  today: bearer verification (`session-auth.ts`) → rate limit
  (`rate-limiter.ts`) → tier gate (`tier-gate.ts`) → vault credential
  overlay (`dispatch.ts`) → adapter dispatch → audit line (`audit.ts`).
  Where that sequence currently lives inline in `mcp-server.ts`'s handler,
  extract it into a shared function both handlers call; behaviour-preserving
  extraction only.
- **Feature flag:** `HOSTED_STATELESS_2026` read in `env.ts`, default off.
  Off means the routing rule is inert and a stateless-shaped request falls
  through to the legacy path's existing refusal (the 400 "no valid session
  ID" answer), exactly as today. The flag is set in `containers/wrangler.toml`
  env, so flipping it is a config deploy, and rollback is unsetting it.
- **Explicit non-goals:** no SSE resumability on the stateless path (the
  revision removed it), no sampling, no Tasks or MCP Apps extensions, no
  change to `src/shared/`, no change to the stdio server, no change to the
  legacy path's wire behaviour.

### R3. Implement and prove (PR-C, active-risk lane, gated on acceptance)

- Implement R2. Unit tests beside the handler
  (`tests/hosted-transport/stateless-handler.test.ts`) covering routing,
  each method, auth failures, tier refusals, and the audit line.
- `npm run conformance:hosted` runs the 2026-07-28 stateless scenarios with
  the flag on and must be green; the legacy scenario set must be unchanged.
- CI: the conformance step from R1 gains a second, flag-on run.
- Review per the decision record: independent agent review, green CI, Rob's
  deliberate merge.

### R4. Roll out

1. PR-C merges with the flag absent from production config: the deploy that
   `deploy-containers.yml` triggers ships dormant code. Verify the live
   legacy smoke (`hosted-live-auth.yml`, Tier 1/2/3 checks) stays green.
2. Set `HOSTED_STATELESS_2026` in the containers Worker config and recycle
   the instance (manual `workflow_dispatch`, the existing break-glass
   path). Re-run the live smoke plus a one-off conformance run pointed at
   `mcp.agenticaffiliate.ai` with the seeded test tenant's token
   (2026-07-18 seeded-tenant record; test-mode data only).
3. Rollback at any point is unsetting the flag and recycling. The legacy
   path never depended on the new code.

### R5. Say it honestly (PR-D, routine)

- README client table and a `docs/findings/` entry: exactly which
  scenarios pass, against suite version `0.2.0-alpha.10` (or newer if
  re-pinned), on what date, and what is deliberately not implemented
  (extensions).
- Marketing drafts (the "among the first" claim) prepared under campaign
  mode, grounded in the passing run, approved by Rob before anything is
  queued.

## Sequencing and constraints

- R1 is routine-lane and decision-complete; it can start as soon as the
  decision-record PR merges, on its own branch (one PR, one thing; it must
  not share the docs PR).
- R2 is complete with this document.
- R3 starts only when the decision record's status line reads Accepted.
- R4 step 2 and R5 happen only after R3 is merged and deployed dormant.
- Standing watch: check `@modelcontextprotocol/sdk` and
  `@modelcontextprotocol/conformance` releases weekly. If the SDK ships
  2026-07-28 support before R3 merges, R3 switches to the SDK
  implementation (same acceptance proof, less owned code). If the
  conformance suite re-releases, re-pin and re-run before relying on any
  prior green.

## What Rob decides

1. Accept or reject the early-adoption decision record (the gate for R3).
2. Flip the production flag (R4 step 2) after seeing the dormant deploy and
   the green conformance run.
3. Approve the public claim wording (R5).

Everything else is agent-executable within the lanes above.
