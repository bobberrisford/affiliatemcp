# DEPLOY.md — affiliate-mcp release runbook

How to ship the **desktop setup app** and the **licence-issuer Worker**. This is
the human runbook (Rob). Every credential you must supply and every step that is
still a TODO is called out. Paths are quoted because the repo lives at
`"/Users/robertberrisford/affiate mcp"` (there is a space).

---

## 1. Overview

Three artefacts ship, with different trust postures:

| Artefact | What | Licence | Status |
|---|---|---|---|
| **MCP server / CLI** | `affiliate-networks-mcp` on npm — Claude Desktop spawns it over stdio | MIT, free | Unchanged; not part of this release |
| **Desktop `.dmg`** | The local-first, launch-and-quit **setup app** (Electron). Writes credentials + the Claude Desktop config, then quits. It does **not** run the MCP server | MIT | New |
| **Issuer Worker** | Cloudflare Worker: sells the desktop app (£39 one-off) and issues signed, offline-verifiable licence keys | MIT | New |

**Trust posture.** Local-first, no telemetry. The desktop app holds no affiliate
credentials beyond what it writes to the user's own machine. The only outbound
calls it makes are:

- to the issuer URL (`AFFILIATE_MCP_ISSUER_URL`) when the user clicks **Buy**, and
- OS deep-links / `open` (e.g. the `affiliate-mcp://activate?key=…` hand-back, and
  restarting Claude Desktop).

The issuer Worker holds **purchase records (KV) + the Ed25519 signing private key
(secret) only** — never any affiliate credentials. Stripe is the source of truth;
KV mirrors purchases for resend.

---

## 2. Licence keypair handling (do this FIRST)

The public key embedded in the app today
(`LICENCE_PUBLIC_KEY_SPKI_B64` in `"src/shared/config.ts"`, currently
`MCowBQYDK2VwAyEAJGmqSI8zTKHXsqIBH0jpUfL9+FP+/WJxZpODnviRWAI=`) is a **DEV key**.
It must be replaced with a production key **before the first public release**.

> **Why before release:** the public key is compiled into every shipped binary and
> is therefore part of the trust chain. Rotating it after release invalidates every
> licence already issued against the old key — buyers would have to be re-issued.
> Generate the production pair before the first `.dmg` goes out.

Steps:

1. Generate a fresh Ed25519 pair (writes to the gitignored `"licence-keys/"`):
   ```sh
   tsx scripts/generate-licence-keypair.ts --write
   ```
   It prints the **public** key (SPKI DER, base64) and the **private** key (PKCS8
   PEM and PKCS8 DER base64), and writes:
   - `licence-keys/dev-public-key.spki.b64`
   - `licence-keys/dev-signing-key.pem`
   - `licence-keys/dev-signing-key.pkcs8.b64`

2. Replace `LICENCE_PUBLIC_KEY_SPKI_B64` in `"src/shared/config.ts"` with the new
   **PUBLIC** key (the SPKI DER base64 string). Then rebuild the app (section 3).

3. Store the new **PRIVATE** key (the PKCS8 DER base64 form) as the Worker secret
   `LICENCE_SIGNING_KEY` (section 6).

**The private key must NEVER be committed.** `/licence-keys/` is gitignored and only
ever holds key material on your machine; the production private key lives solely in
the Worker secret store. Licences signed with the old (dev) private key will not
verify against the new public key — only issue production keys after the swap.

---

## 3. Building the desktop `.dmg`

```sh
# 1) Build the bundled MCP server (root) — produces dist/
npm run build

# 2) Build the desktop app
cd desktop
npm install
npm run dist        # = prebuild:core (npm --prefix .. run build) + electron-builder --mac dmg
```

- `npm run dist` rebuilds the core first, then runs electron-builder.
- **Artefact:** `"desktop/dist/affiliate-mcp-<version>-<arch>.dmg"` — e.g.
  `"desktop/dist/affiliate-mcp-0.1.0-arm64.dmg"` (version from `desktop/package.json`;
  arch is the build host's, arm64 on Apple Silicon).
- The build bundles, as `extraResources` under `Contents/Resources/`:
  - the built MCP server `dist/` → `Contents/Resources/dist/`
  - `design-system/` → `Contents/Resources/design-system/`
- **Bundled-runtime Claude config.** The packaged app does not ship a second Node
  binary. When the user clicks **Connect**, the app writes a `claude_desktop_config.json`
  entry that runs the app's **own Electron binary in Node mode**:
  ```json
  {
    "mcpServers": {
      "affiliate": {
        "command": "/Applications/affiliate-mcp.app/Contents/MacOS/affiliate-mcp",
        "args": ["/Applications/affiliate-mcp.app/Contents/Resources/dist/index.js"],
        "env": { "ELECTRON_RUN_AS_NODE": "1" }
      }
    }
  }
  ```
  `main.js` injects `ELECTRON_RUN_AS_NODE: "1"` so the Electron binary behaves as a
  plain Node runtime — no system Node, no `npx` round-trip. (In dev the app falls
  back to `npx affiliate-networks-mcp`.)
- **With no signing creds set, `npm run dist` produces an UNSIGNED, un-notarised
  `.dmg`** and the notarise hook logs a skip (no crash). Fine for local testing;
  not shippable. See section 4.

---

## 4. Signing + notarising (macOS)

electron-builder does the signing; `"desktop/build/notarize.js"` (the `afterSign`
hook) does the notarisation. Both are gated purely on environment variables.

**Signing** (read by electron-builder):

| Env var | Purpose |
|---|---|
| `CSC_LINK` | Path or base64 of the `.p12` signing certificate |
| `CSC_KEY_PASSWORD` | Password for that `.p12` |

With neither set, electron-builder skips signing and emits an unsigned app.

**Notarisation** (read by `notarize.js`):

| Env var | Purpose |
|---|---|
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account |
| `APPLE_TEAM_ID` | Developer Team ID |

`notarize.js` only runs on `darwin`. If **any** of the three notarisation vars is
missing it logs a warning and returns without notarising (the `.dmg` is still
produced, just un-notarised). All three present → it notarises
`<app>.app` via `@electron/notarize`.

The hardened runtime is on (`build.mac.hardenedRuntime: true`) with
`"desktop/build/entitlements.mac.plist"` granting `allow-jit`,
`allow-unsigned-executable-memory`, `disable-library-validation`, and
`allow-dyld-environment-variables` (the last is required because we set
`ELECTRON_RUN_AS_NODE` on the spawned server process).

**Prerequisites / open question:**
- **D10** — the Apple Developer licence must be in hand before a signed/notarised
  build is possible.
- **Open:** signing identity is currently personal vs org. Migrate to the org
  signing identity **before launch** so the published app isn't tied to a personal
  account.

---

## 5. Distribution

- Ship the signed, notarised `.dmg` as a **direct download on GitHub Releases**
  (D5 / D7).
- **Not** the Mac App Store — the app is incompatible with the MAS sandbox (it
  writes outside the container, spawns its own binary as the MCP server, and
  restarts Claude via `osascript`/`open`).
- **Out of scope for this release (Phase 2):** Homebrew Cask, a Windows build, and
  `electron-updater` auto-updates. Releases are manual `.dmg` downloads for now.

---

## 6. Deploying the issuer Worker

```sh
cd issuer
npm install
```

1. **Create the KV namespace** and paste the ids into `"issuer/wrangler.toml"`
   (`[[kv_namespaces]]` → `LICENCES`, replacing `REPLACE_WITH_KV_NAMESPACE_ID` and
   `REPLACE_WITH_PREVIEW_KV_NAMESPACE_ID`):
   ```sh
   npx wrangler kv namespace create LICENCES
   npx wrangler kv namespace create LICENCES --preview
   ```

2. **Set the secrets** (`npx wrangler secret put <NAME>`):
   - `STRIPE_SECRET_KEY` — `sk_live_…` (or `sk_test_…`)
   - `STRIPE_WEBHOOK_SECRET` — `whsec_…` from the registered webhook (see step 5)
   - `LICENCE_SIGNING_KEY` — the production Ed25519 **private** key, PKCS8 DER, base64
     (from section 2)
   - `RESEND_API_KEY` — `re_…` (if omitted, emails are logged, not sent)

3. **Set the vars** — in `"issuer/wrangler.toml"` `[vars]` or the dashboard:
   - `LICENCE_FROM_EMAIL` — a verified Resend sender (e.g. `licences@yourdomain`)
   - `SUCCESS_URL` — base success URL; the Worker appends
     `?session_id={CHECKOUT_SESSION_ID}`
   - `CANCEL_URL` — cancel URL
   - `STRIPE_PRICE_ID` *(optional)* — a pre-created Price id; if unset the Worker
     uses inline `price_data` (£39 GBP)
   - `EXTRA_CORS_ORIGINS` *(optional)* — comma-separated extra allowed origins

4. **Deploy:**
   ```sh
   npx wrangler deploy
   ```

5. **Register the Stripe webhook** (Stripe dashboard → Developers → Webhooks):
   - Endpoint URL: `https://<your-worker>/webhook`
   - Event: `checkout.session.completed`
   - Copy the endpoint's signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`
     (re-run `npx wrangler secret put STRIPE_WEBHOOK_SECRET` and `npx wrangler deploy`).

6. **Enable Stripe Tax** in the Stripe dashboard — `/checkout` creates sessions with
   `automatic_tax: { enabled: true }` and `billing_address_collection: 'required'`.

7. **Resend** — verify the sending domain and create the API key used in step 2.

Endpoints once live: `POST /checkout`, `POST /webhook`, `GET /success`,
`POST|GET /resend`, `GET /` and `GET /health`.

---

## 7. Wiring the app to the Worker

The app's **Buy** button (`licence:buy` in `"desktop/main.js"`) reads
`AFFILIATE_MCP_ISSUER_URL`, POSTs `{}` to `<issuer>/checkout`, and opens the returned
Stripe URL.

- Set `AFFILIATE_MCP_ISSUER_URL` to the **deployed Worker base URL** (no trailing
  slash needed — the app strips it).
- **Until it is set, the in-app Buy button reports "Checkout is not configured yet
  (issuer URL unset)." and opens nothing** — there is no placeholder URL by design.

---

## 8. Secrets / credentials checklist

| Name | Where it's set | What it's for |
|---|---|---|
| `LICENCE_PUBLIC_KEY_SPKI_B64` | source: `"src/shared/config.ts"` | Public key embedded in the app to verify licences (swap to prod key, then rebuild) |
| `LICENCE_SIGNING_KEY` | `wrangler secret` | Ed25519 **private** key (PKCS8 DER b64) the Worker signs licences with |
| `STRIPE_SECRET_KEY` | `wrangler secret` | Worker → Stripe API (create Checkout Session, retrieve session) |
| `STRIPE_WEBHOOK_SECRET` | `wrangler secret` | Verify Stripe webhook signatures |
| `RESEND_API_KEY` | `wrangler secret` | Email the licence (omit → emails logged) |
| `LICENCE_FROM_EMAIL` | `wrangler var` / dashboard | Verified Resend sender address |
| `SUCCESS_URL` | `wrangler var` / dashboard | Checkout success redirect base |
| `CANCEL_URL` | `wrangler var` / dashboard | Checkout cancel redirect |
| `STRIPE_PRICE_ID` *(optional)* | `wrangler var` / dashboard | Pre-created Price; unset → inline £39 |
| `EXTRA_CORS_ORIGINS` *(optional)* | `wrangler var` / dashboard | Extra allowed CORS origins |
| `CSC_LINK` | env (release machine) | Path/base64 of the `.p12` signing cert |
| `CSC_KEY_PASSWORD` | env (release machine) | Password for the `.p12` |
| `APPLE_ID` | env (release machine) | Apple Developer account email (notarisation) |
| `APPLE_APP_SPECIFIC_PASSWORD` | env (release machine) | App-specific password (notarisation) |
| `APPLE_TEAM_ID` | env (release machine) | Developer Team ID (notarisation) |
| `AFFILIATE_MCP_ISSUER_URL` | env (app runtime) | Worker base URL the Buy button POSTs to |
| KV `LICENCES` id / preview_id | `"issuer/wrangler.toml"` | Purchase-record store |

---

## 9. Verification before shipping

```sh
# Root: full gate (typecheck + lint + tests + build) — must be green
npm run verify

# Root: design-system adherence lint on the renderer
npm run lint:design

# Issuer: tests + a no-deploy dry run
cd issuer
npm test
npx wrangler deploy --dry-run
```

- `npm run lint:design` runs `npx oxlint@latest`. **Caveat:** in a sandboxed
  environment oxlint can't download its binary — run it where oxlint can install
  (it ends with `|| true`, so a sandbox failure won't fail the script, but it also
  won't actually lint).
- **Manual licence interop smoke:**
  1. Sign a token with the **dev** key:
     ```sh
     npx tsx issuer/scripts/sign-licence.ts   # or: cd issuer && npm run sign-sample
     ```
  2. Paste the printed token into the app's **Activate** screen and confirm it
     verifies. (For a production end-to-end check, sign with the production private
     key against an app built with the matching production public key.)
