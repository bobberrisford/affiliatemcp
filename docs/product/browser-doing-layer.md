# The doing layer: browser and non-API surfaces

This is the Phase 0 design for acting on network surfaces that have no public
API: the dashboard itself, emailed reports, and exported files. It is a
companion to `doing-layer.md`, which covers the consent and audit model that
this builds on. Nothing here is shipped behaviour yet.

It records three decisions already taken:

1. **Browser automation is first-class, not forbidden.** The product boundary
   is being revised (see `AGENTS.md` and `manifesto.md`). Where a network
   exposes no API for a task, the doing layer drives the dashboard the user is
   already authorised to use.
2. **Sessions, with assisted re-auth.** We store browser session state, not
   passwords. A human completes login once, including 2FA or captcha, and the
   session is reused until it expires, at which point a human is asked to
   re-authenticate.
3. **Local-first only.** This runs on the user's machine, on demand. No
   always-on service, no hosted browser fleet, no scheduler. Modest
   concurrency. The privacy posture of the project is unchanged: sessions and
   credentials never leave the user's host.

## What stays true

The revised boundary opens a mechanism, not the ethics. These still hold:

- **Authorised access only.** Automate dashboards the user can already log into.
  Never to evade access limits, defeat a security control, reach another
  tenant's data, or access anything the user is not entitled to.
- **Honest about Terms of Service.** Many networks restrict automated dashboard
  access. The docs must say so plainly per network, and the user accepts that
  risk knowingly. We do not hide it.
- **Never invent success (principle 4.1), harder here.** A browser click that
  silently does nothing must never be reported as done. Every action verifies
  its own effect and keeps evidence.
- **Consent and audit gates (see `doing-layer.md`).** Browser actions are the
  highest-risk class. Plan and apply by default; standing consent only within
  bounds; every action audited with evidence.

## Why a browser layer at all

A large part of affiliate work has no API: approving a publisher in a console
that exposes no write endpoint, pulling a report that only exists as a
dashboard export, acting on something a network only ever sends by email. The
read-only API adapters cannot reach these. The browser can, because it does
exactly what the authorised user would do by hand.

The browser is transport, not a parallel data model. A report it downloads is
normalised back into the existing typed contracts (`Transaction`,
`ProgrammePerformanceRow`, and so on). The data layer does not change; only the
acquisition method does.

## Storing the login

We store **session state**, not passwords, by default.

- **Capture once, reuse.** A human logs in through a real browser, handling
  2FA, SSO, or captcha. We capture the resulting session: cookies and
  local storage (Playwright's `storageState`). Subsequent runs replay it and
  resume authenticated.
- **Encrypted at rest, local.** Session blobs are encrypted on the user's
  machine, keyed by `(network, account)`. The master key lives in the OS
  keychain. Nothing is uploaded.
- **Assisted re-auth on expiry.** When a session dies, the run pauses and asks
  the human to log in again, then recaptures the session. We do not store
  passwords or TOTP seeds to avoid this; the trade-off is that fully unattended
  operation is out of scope, which is consistent with the local-first decision.

The honest limit: networks with aggressive session expiry, or that re-prompt
2FA often, will ask the human to re-authenticate more frequently. That is the
accepted cost of not storing credentials.

## Doing the browser consistently

Consistency is the hard problem: every dashboard's markup differs and changes
without notice. The answer mirrors the existing adapter pattern.

- **Driver: Playwright.** Persistent contexts, `storageState`, downloads,
  resilient waits, role and text selectors. This is a significant new
  dependency and a browser binary; it is justified by the decision above and
  scoped to the browser subsystem only.
- **A `BrowserAdapter` per network**, registered the way `NetworkAdapter` is.
  A shared interface: `login(ctx)`, `isLoggedIn()`, and named flows such as
  `approvePublisher` or `downloadTransactionsReport`. Each flow is a sequence
  of verified page interactions.
- **Resilient selectors, externalised.** Prefer accessibility selectors (role,
  label, visible text) over brittle CSS or XPath. Keep the selectors in a
  per-network config file so DOM drift is a data fix, not a code change.
- **Verify every action.** After each step, re-read the page and assert the
  state actually changed. Capture a before-and-after screenshot as audit
  evidence. A flow that cannot confirm its effect fails loudly; it never
  returns success on assumption.
- **A drift canary.** A health flow logs into each network and asserts known
  anchors exist. Run it before a batch, or on demand. Selector drift is found
  by the canary, not by a silently broken approval run.

## Emails and reports

Do not drive the browser when a cheaper, more stable path exists.

- **Reports by email.** Where a network emails scheduled reports, fetch and
  parse them through an email integration rather than the browser. Most stable
  option; no session to maintain.
- **Reports only in-dashboard.** The browser triggers the export, captures the
  download, and normalises it into the typed contracts.
- **Email as an action surface.** Acting on a link in a network notification is
  possible, but treat email content as untrusted input and route any resulting
  action through the same consent, verify, and audit gates.

## How this maps to the consent layer

Everything in `doing-layer.md` applies, with the risk dial turned up:

- **Action classes** extend to browser flows (`publisher.approve` may be an API
  write on one network and a browser flow on another; the class is the same, the
  transport differs).
- **Plan and apply.** A browser `plan` navigates and previews without
  submitting; `apply` performs the submit, then verifies.
- **Standing consent** can still let a trusted run skip prompts within bounds,
  but bounds matter more here. The audit record gains screenshots and any
  downloaded files as evidence.
- **Permissions from a client** now literally means a stored session acting on
  the client's behalf. That raises the bar on the audit trail and on session
  handling, and the docs must make the client aware that automation, not a
  person, may act under their login.

## Architecture, fenced off

The browser subsystem is a clearly separated module with its own dependencies
and its own honest documentation. It does not entangle the API adapters.

- `src/browser/` (or a sibling package): driver setup, session store, the
  `BrowserAdapter` registry, verification and screenshot helpers.
- `src/browser/networks/<slug>/`: per-network flows and externalised selectors.
- Session store: encrypted local vault, OS-keychain master key.
- Reuses `src/shared/` types for normalised output, and the consent and audit
  modules from the API doing layer.

## Local-first scale, honestly

We chose local-first only, so "at scale" means: batch runs from the CLI with
modest, jittered concurrency to avoid lockouts and behave like a person, not a
long-running fleet. A user with many accounts runs a batch when they choose to.
Recurring schedules, queues, and worker pools are explicitly out of scope under
this decision. If that ceiling becomes the constraint, revisit the hosting
decision deliberately rather than growing a service by accident.

## Phasing

- **Phase 0 (this note and the boundary revision).** Decide and document.
  Revise the product boundary so the repo is not self-contradictory.
- **Phase 1.** Browser foundation, no network flows: Playwright driver, the
  encrypted session store, assisted login and capture, the `BrowserAdapter`
  interface, verification and screenshot helpers, the drift canary. Default off.
- **Phase 2.** One real flow on one network end to end: assisted login, one
  verified action, evidence captured, consent and audit applied. Treated as
  `experimental` until proven against a real account.
- **Phase 3.** A second network and a second flow, proving the selector-config
  and verification model generalises before any broad abstraction.

## Open questions

- Headful or headless for assisted login. Assisted login needs a visible
  browser; batch reuse can be headless. Decide the handoff mechanics.
- How the CLI surfaces a paused "please log in again" handoff cleanly.
- Per-network ToS notes: where they live and how the user acknowledges them.
- Screenshot evidence retention and redaction in the audit log.
