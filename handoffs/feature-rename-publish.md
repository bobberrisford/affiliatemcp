# feature/rename-publish

Branch off `main` at `79b48b9`. Renames the brand-visible npm package /
CLI binary to `affiliate-networks-mcp` because `affiliate-mcp` was taken
on the npm registry (HLOS, `affiliate-mcp@0.0.1`, unrelated project).
Internal identifiers — config directory, env vars, project short-name,
logger names, handoff docs — stay as `affiliate-mcp`.

## What I did

### `package.json`
- `name`: `affiliate-mcp` → `affiliate-networks-mcp`
- `bin`: key renamed to `affiliate-networks-mcp` (target unchanged at `dist/index.js`)
- `version`: already `0.1.0`, left as-is

### CLI surface (`src/index.ts`, `src/cli/setup.ts`)
- First-run banner header + the "Run `affiliate-mcp setup`" pointer
- `printHelp()` usage strings (server / setup / test / doctor / validate / --help)
- `validate <slug>` usage line
- Fatal error prefix
- Wizard closing pointer "Test with `affiliate-networks-mcp test`."
- Two "Credentials saved anyway, re-run …" fallback lines

### Runtime hints emitted to users
- `src/shared/config.ts` — missing-credential `hint`
- `src/networks/awin/adapter.ts`, `src/networks/cj/adapter.ts`,
  `src/networks/impact/adapter.ts`, `src/networks/ebay/adapter.ts`,
  `src/networks/ebay/auth.ts`, `src/networks/rakuten/adapter.ts`,
  `src/networks/rakuten/auth.ts` — every `Run \`affiliate-mcp setup …\``
  hint string

### Documentation (user-typed commands only)
- `README.md` — Quick-start (both `npx` commands + sample JSON `args`)
- `AGENTS.md` — CLI entry-point bullets
- `CONTRIBUTING.md` — reproduce-failure `npx` example
- `WANTED.md` — walkthrough-video reference
- `docs/networks/{awin,cj,ebay,impact,rakuten}.md` — every
  `npx affiliate-mcp …` and `affiliate-mcp test|doctor|setup <slug>` ref
- `docs/network-claim-process.md` — promotion criterion
- `docs/findings/{ebay,rakuten}.md` — two CLI mentions
- `docs/launch/CHECKLIST.md`
- `docs/launch/demo-scripts/{01,02}-*.md` — terminal commands in demo
  scripts (note: title cards / narration left at project short-name)
- `docs/launch/submissions/{glama,mcp-registry,smithery}.md` —
  installation snippets (`npm install -g`, `npx`, bare `affiliate-mcp setup`)
  and the JSON config blocks (key now `"affiliate"`, args now
  `["affiliate-networks-mcp"]`, matching `examples/claude-desktop-config.json`)
- `examples/claude-desktop-config.json` + `.md` — `args` array, prose,
  and "the recommended flow" block. The MCP-server key in the JSON
  config is `"affiliate"` everywhere (already the canonical example).
- `src/skills/{affiliate-earnings-report,affiliate-network-status,
  affiliate-network-setup-help}/SKILL.md` + their `examples/*.md` —
  every CLI command the skills recommend to the user
- `.claude/skills/contribute/SKILL.md` — three CLI mentions
- `templates/new-network/README.md` — the "Verifying" code block
- `.github/ISSUE_TEMPLATE/network-broken.yml` — doctor instruction

### Tests
- `tests/governance/readme.test.ts` — regex updated from
  `npx\s+affiliate-mcp` to `npx\s+affiliate-networks-mcp` so the
  quick-start subcommand check still binds to the right invocation
- `tests/skills/skills-exist.test.ts` — `affiliate-mcp setup` →
  `affiliate-networks-mcp setup` to match the renamed SKILL.md content
- **NEW** `tests/governance/package.test.ts` — six assertions:
  - `package.json#name` is `affiliate-networks-mcp`
  - `package.json#bin` has `affiliate-networks-mcp` as a key
  - `package.json#bin` does NOT have `affiliate-mcp` as a key
  - README contains no `\bnpx affiliate-mcp\b`
  - README contains no `\bnpm install -g affiliate-mcp\b`
  - every `examples/*.json` `mcpServers.*.args[0]` (when `command === "npx"`)
    is `affiliate-networks-mcp`

### Deliberately NOT renamed
- `~/.affiliate-mcp/` config directory and every doc/source reference
  to it (implementation detail)
- `AFFILIATE_MCP_CONFIG_DIR`, `AFFILIATE_MCP_LOG_LEVEL`,
  `AFFILIATE_MCP_NETWORK_TABLE_*` env vars and HTML markers
- `affiliate-mcp` as the project short-name in prose
  (e.g. "Setting up affiliate-mcp with Awin", "affiliate-mcp v0.1",
  "the affiliate-mcp project") in README, AGENTS, CONTRIBUTING,
  CODE_OF_CONDUCT, launch submissions, demo scripts, findings docs,
  network docs, scripts, REPORT.md, build-status.md, .github/seed-issues
- `tmpDir` prefixes and `contribute-to-affiliate-mcp` skill name
- Internal variable / logger names
- `handoffs/` (historical artefacts)

## What's tested

```
npm run typecheck   # passes
npm run lint        # 0 errors, 7 warnings (all pre-existing
                    # `no-non-null-assertion` warnings in test files)
npm test            # 365/365 passing across 36 test files
                    # (was 359 — added 6 in tests/governance/package.test.ts)
npm run build       # passes
node dist/index.js --help   # prints help with new binary name
```

The brand-visible vs internal distinction is encoded by the new
governance test: any future PR that re-introduces `npx affiliate-mcp`
into the README or `affiliate-mcp` into the bin map fails CI.

## What's unfinished

**Publish.** `npm publish --access public` failed with `ENEEDAUTH`:

```
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to
  https://registry.npmjs.org/
npm error need auth You need to authorize this machine using `npm adduser`
```

No `~/.npmrc` and `npm whoami` also returns `ENEEDAUTH`. As instructed,
I stopped rather than trying to coerce credentials. The packaged tarball
was successfully built before the auth check — `affiliate-networks-mcp-0.1.0.tgz`,
190.5 kB, 166 files, shasum `33279d9e6c041f020133273561e9e0fd41d3151d`.

**Action required from the user / orchestrator from a machine with npm
publish rights for the Atolls account:**

```
cd <repo>
git checkout feature/rename-publish    # or wherever it lands after merge
npm login                              # or: NPM_TOKEN=<token> npm publish ...
npm publish --access public
npm view affiliate-networks-mcp        # verify
```

## What surprised me

1. **The branch already existed.** When I started, `feature/rename-publish`
   was already checked out with `package.json`, `README.md`,
   `examples/claude-desktop-config.{json,md}`, `src/cli/setup.ts`, and
   `src/index.ts` already partially modified (uncommitted, on top of
   `79b48b9`). I incorporated those existing changes into my first
   commit rather than discarding and starting over — net effect is the
   same. If that prior session was a different agent, the work product
   is now consolidated under db6e529.

2. **Submission docs had divergent JSON shapes.** Each of
   `docs/launch/submissions/{glama,mcp-registry,smithery}.md` had its
   own minimal Claude Desktop config example with a
   `"affiliate-mcp": { … "args": ["affiliate-mcp"] }` shape — which
   disagreed with the canonical `examples/claude-desktop-config.json`
   (key `"affiliate"`, args `["affiliate-mcp"]`). I converged all three
   onto the canonical shape (`"affiliate"` / `["affiliate-networks-mcp"]`).
   Worth flagging because if there's an external reason the submission
   docs deliberately used a different key, that's now lost — but it
   read like drift, not intent.

3. **`tests/skills/skills-exist.test.ts:133` had a regex match against
   `/affiliate-mcp setup/` that would silently break the moment the
   SKILL.md got renamed.** That test now matches
   `/affiliate-networks-mcp setup/`. Worth noting because the new
   governance test would have caught the README regression but not this
   one — adding the package-name assertion to the skill governance file
   would close that gap if a future contributor reverts a SKILL.md.

## Recommended next steps

1. **Publish from a machine with npm credentials.** Command above.
2. After publish lands, the orchestrator may want to add a `publishConfig`
   block or a CI publish workflow so the next bump doesn't need a manual
   `npm login` round-trip.
3. Consider whether `bug.yml`'s "affiliate-mcp version" placeholder
   should also become "affiliate-networks-mcp" — I left it as
   project-short-name (consistent with the v0.1 framing in CHECKLIST and
   submissions) but it's borderline.
4. Branch head: `40bcc24`. Two commits on top of `79b48b9` — orchestrator
   can fast-forward into `main` without conflict.
