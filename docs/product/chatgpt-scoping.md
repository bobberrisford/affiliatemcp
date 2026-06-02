# ChatGPT support — execution plan (2026-06-02)

> Status: design doc, pre-implementation. Supersedes the first-pass
> scoping note from the same date.

## Verdict

**Go.** Ship a `serve --chatgpt` subcommand that boots the existing
MCP server in streamable-HTTP mode on `127.0.0.1` and pairs it with a
`cloudflared` quick tunnel. Bearer-token auth. The user pastes the
URL + token into ChatGPT's *Settings → Connectors → Add MCP server*
and asks questions. Credentials never leave the user's machine; only
tool-call traffic transits Cloudflare's TLS edge.

Scope: ~1,200 LOC, ~23 engineering hours — comparable to the
cowork-mirror flow that already shipped.

## Why this beats the alternatives

| Option | Verdict | Why |
|---|---|---|
| **Cloudflare quick tunnel + local server (chosen)** | Ship it | Preserves local-first stance. No account, no signup. Tunnel is auth-gated by our bearer token. One command. |
| User deploys a Worker to their own Cloudflare account | Reject | Forces every non-technical user to make a Cloudflare account, mint an API token, learn what a Worker is. ~20 min install before they've asked a question. Credentials end up in a place they can't `rm -rf`. |
| Hosted SaaS we run | Reject | Breaks every load-bearing README claim: "your data, your machine", "no account", "no telemetry". Creates GDPR / SOC2 scope. Different product. |
| Print instructions only | Reject | Doesn't actually install anything. Cosmetic. |

The cost we accept: the user's laptop must be awake for ChatGPT to
call. Same constraint Claude Desktop already has.

## 1. End-to-end user flow

1. `npx affiliate-networks-mcp setup` — unchanged, configures
   credentials in `~/.affiliate-mcp/.env`.
2. `npx affiliate-networks-mcp install` — new menu item *"Connect to
   ChatGPT (Plus / Pro / Business / Enterprise)"*.
3. CLI checks for `cloudflared`; if missing, downloads the static
   binary (~25 MB) into `~/.affiliate-mcp/bin/cloudflared`.
4. CLI starts the HTTP MCP server on a random localhost port, mints a
   32-byte URL-safe bearer token, writes it to
   `~/.affiliate-mcp/.env` as `AFFILIATE_MCP_HTTP_TOKEN=…`, spawns
   `cloudflared tunnel --url http://127.0.0.1:<port>`, captures the
   `https://<random>.trycloudflare.com` URL from stderr.
5. CLI prints:

       ChatGPT server is live.
         URL:    https://amber-otter-1234.trycloudflare.com/mcp
         Token:  affmcp_8f...c1
       In ChatGPT: Settings → Connectors → Add custom connector → MCP server.
       Keep this terminal open. Ctrl-C to stop.

6. User opens ChatGPT, goes to **Settings → Connectors → Advanced →
   Developer mode → Add custom connector**, picks **MCP Server**,
   pastes the URL, picks **Bearer token** auth, pastes the token,
   names it *"Affiliate"*, saves.
7. User asks *"What did I earn on Awin last month?"*. ChatGPT calls
   `tools/list`, then `affiliate_awin_get_earnings_summary`. Answer
   appears.

**Worst step, honestly:** step 6. ChatGPT's custom-connector setup is
buried two settings menus deep, requires turning on developer mode,
and the UI has historically moved between releases. We can't shortcut
it — there's no equivalent of `claude_desktop_config.json` we can
write to from outside.

## 2. Required code changes

| File | New / Edit | Size |
|---|---|---|
| `src/server.ts` | Edit — refactor `startServer()` to accept a transport; extract tool wiring into a shared builder. | ~50 LOC, 1 hr |
| `src/server-http.ts` | **New** — boot `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`, wrap in a `node:http` server, enforce `Authorization: Bearer <token>` on every request. | ~150 LOC, 3 hr |
| `src/cli/serve.ts` | **New** — `serve` subcommand. Reads/mints token, spawns server + tunnel, prints URL, handles SIGINT to kill both cleanly. | ~200 LOC, 4 hr |
| `src/cli/install/tunnel.ts` | **New** — download/locate `cloudflared`, spawn it, scrape URL from stderr, restart on exit. Modelled on `github-backend.ts`'s pluggable shape for testability. | ~250 LOC, 6 hr |
| `src/cli/install/chatgpt-instructions.ts` | **New** — printable step-by-step text for the ChatGPT UI flow. | ~80 LOC, 1 hr |
| `src/cli/install.ts` | Edit — add `chatgpt` to `InstallTarget`, add menu option, dispatch to the serve flow with a "do you want this to keep running?" confirm. | ~60 LOC, 2 hr |
| `src/index.ts` | Edit — wire `serve` subcommand and `--chatgpt` flag parsing. | ~30 LOC, 0.5 hr |
| `src/shared/config.ts` | Edit — `AFFILIATE_MCP_HTTP_TOKEN` getter + token rotation helper. | ~20 LOC, 0.5 hr |
| `tests/cli/serve.test.ts` + `tests/server-http.test.ts` | **New** — unit tests with injected tunnel + fetch. | ~300 LOC, 4 hr |
| `README.md` | Edit — ChatGPT section, lifecycle caveats. | ~80 LOC, 1 hr |
| `docs/product/manifesto.md` | Edit — note that the HTTPS surface is opt-in, auth-gated, traffic-only (no hosted state). | ~10 LOC, 0.25 hr |

**Total: ~1,200 LOC, ~23 engineering hours.**

## 3. Auth model

ChatGPT supports two auth modes for custom MCP connectors: **OAuth
2.1** and **HTTP bearer token**. OAuth requires us to stand up an
`/authorize` + `/token` endpoint with PKCE — not viable on a
`trycloudflare.com` URL that rotates.

So: **bearer token**. The CLI mints a 32-byte URL-safe random token
on first run, stores it in `~/.affiliate-mcp/.env` (0600), and the
HTTP server rejects any request without `Authorization: Bearer
<token>` with a 401. The user pastes the token once into ChatGPT's
connector setup. Token is stable across restarts;
`npx affiliate-networks-mcp rotate-token` invalidates the old one and
prints a new one.

Same trust model as any other "paste an API key" connector ChatGPT
supports.

## 4. Lifecycle and ops

| Event | What breaks | Recovery |
|---|---|---|
| Laptop sleeps | ChatGPT requests stall, then 502 | Wake laptop. We document this. |
| `cloudflared` quick-tunnel URL rotates (on restart) | New URL → ChatGPT shows *"connector unavailable"*. **This is the worst part of the UX.** | CLI prints the new URL; user re-edits the connector in ChatGPT. v2 fix: named tunnel (requires Cloudflare account) keeps URL stable. |
| `cloudflared` crashes | Same as URL rotation | CLI auto-restarts the tunnel; if URL changed, prints a banner. |
| MCP server crashes | 502 on next call | CLI restarts it under same port; tunnel survives. |
| Credentials rotated in `.env` | Server already loaded old values | Ctrl-C, re-run `serve`. Stretch: `SIGHUP → reload config`. |
| User closes the terminal | Everything dies | Document. v2: `serve --daemon` writes a launchd/systemd unit. |

## 5. What breaks about the local-first stance

**Nothing fundamental — one nuance to disclose honestly.**

Credentials still live only on the user's machine. Affiliate-network
API traffic still originates from the user's laptop. We don't host
anything, we don't see any data, no account is created with us.

The nuance: ChatGPT's request to call a tool, and the JSON response,
transit `trycloudflare.com` (Cloudflare's edge). It's TLS end-to-end,
but Cloudflare is technically a hop. We disclose this in the README:

> *Tool calls travel ChatGPT → Cloudflare tunnel → your laptop.
> Affiliate credentials never leave your machine; only the answer to
> the question crosses the wire.*

True and honest. The user opted in by running `--chatgpt` and
pasting the URL into ChatGPT themselves.

## 6. UX comparison vs. Claude install

| Step | Claude Desktop | ChatGPT |
|---|---|---|
| Install MCP | `npx … install` writes JSON, done | `npx … install --chatgpt` boots a tunnel |
| Connect in app | Restart Claude, ask question | Settings → Connectors → Advanced → Developer mode → Add → MCP → paste URL → paste token → Save → new chat |
| First-time elapsed | ~2 minutes | **~8–12 minutes** the first time, ~3 minutes on subsequent re-tunnels |
| Ongoing | Quiet | Reboot → tunnel URL changes → paste new URL. **Warn explicitly in install output.** |

We will not match the Claude install. We can get the install itself
to one command, but the ChatGPT-side configuration is six clicks no
matter what we do.

## 7. Smallest credible MVP

**Ship this and stop:**

- `serve --chatgpt` subcommand that boots HTTP transport +
  `cloudflared` quick tunnel.
- Bearer-token auth, token stored in `~/.affiliate-mcp/.env`.
- CLI prints URL + token + the exact ChatGPT click-path.
- README section with screenshots of the ChatGPT settings flow.
- Auto-restart tunnel on crash; reprint new URL if rotated.

**Punt to v2:**

- Named Cloudflare tunnel (stable URL) — requires user's Cloudflare
  account, optional upgrade path.
- Daemon mode / launchd / systemd integration.
- OAuth 2.1 flow (only if ChatGPT starts requiring it).
- Inlining `cloudflared` as a bundled dependency vs. download-on-demand.
- ChatGPT *deep research* connector contract (different tool shape —
  `search` + `fetch` only).

## 8. Recommendation: Go

Ship the MVP. Local-first stance survives intact. The work fits
inside the complexity envelope already accepted for cowork-mirror.
The README and manifesto already advertise ChatGPT as a target — we
just need to deliver on what we're already promising.

**The single thing to be honest about upfront**, in install output
and README: the tunnel URL changes when you restart your laptop, and
you have to repaste it into ChatGPT. Hiding that surprise damages
trust. Naming it is fine — and it's the obvious lead-in to *"want a
stable URL? Bring a Cloudflare account, run `serve --chatgpt
--named-tunnel`"* in v2.

## Relevant files for the implementer

- `src/server.ts` — refactor to accept transport
- `src/index.ts` — subcommand wiring
- `src/cli/install.ts` — menu integration
- `src/cli/install/cowork-mirror.ts` — template for the new tunnel
  module (pluggable backend, dry-run, prompter, output sink)
- `src/cli/install/github-backend.ts` — template for the
  pluggable-binary pattern
- `src/shared/config.ts` — where the bearer token gets persisted
- `README.md` — ChatGPT section to write
- `docs/product/manifesto.md` — one-line addition on the
  auth-gated HTTPS surface

## Sources

- [Developer mode and MCP apps in ChatGPT — OpenAI](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta)
- [Connect from ChatGPT — Apps SDK | OpenAI Developers](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
- [Building MCP servers for ChatGPT Apps and API integrations](https://developers.openai.com/api/docs/mcp)
- [Apps in ChatGPT — OpenAI](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt)
- [Cloudflare quick tunnels — `trycloudflare.com`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
