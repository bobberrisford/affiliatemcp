# Deployment plan: the affiliate-mcp site

> Companion to [`website-plan.md`](./website-plan.md) and
> [`website-copy.md`](./website-copy.md). Decisions locked: **host on GitHub
> Pages**, **ship the current self-contained static HTML as-is** (no build
> step). The pages live in [`mockups/`](./mockups/).
>
> **Status (shipped):** the site has been promoted to the top-level
> [`site/`](../../site) directory (option B below) and points at the custom
> apex domain **`agenticaffiliate.ai`**. All absolute URLs, `robots.txt`,
> `sitemap.xml`, and a `site/CNAME` reflect that domain; the deploy workflow
> reads from `site/`. The remaining manual steps are DNS records at the `.ai`
> registrar and setting the custom domain under Settings to Pages (see §6).
> The path-based prose below still references `docs/product/mockups/`; read it
> as `site/`.

## 1. What we're deploying

Six self-contained HTML pages — `index.html`, `get-started.html`,
`what-you-can-ask.html`, `networks.html`, `adopt.html`, `mission.html` — plus
the design-system reference in [`../design-system/`](../design-system). Each
page inlines its own CSS, nav/footer, and data, so there is **no build and no
inter-file dependency** at runtime. The only external request is to the Google
Fonts CDN (see §7).

All internal links are **relative** (`networks.html`, `index.html#how`), so the
site works unchanged whether it's served from a github.io subpath or a custom
domain. Nothing needs rewriting for the base path.

## 2. Approach: GitHub Pages via Actions

GitHub Pages is the right host: free, lives in this repo, and deploys from a
workflow that sits next to the existing `ci.yml`/`publish.yml`. Because the site
is static, the "build" is just packaging a folder and uploading it.

Two source-layout options:

- **A — deploy the folder as-is (lowest effort, recommended for now).** Point
  the Pages workflow at `docs/product/mockups/` and upload it as the artifact.
  The artifact root becomes the site root.
- **B — promote to a top-level `site/` directory (tidier for a real launch).**
  `git mv docs/product/mockups site`, so the deployable site isn't sitting under
  a path called "mockups." Purely cosmetic; the workflow path changes to
  `./site`. Recommended before any public announcement.

This plan uses option A in the workflow below; switch the `path:` to `./site` if
you take option B.

## 3. The deploy workflow

Add `.github/workflows/deploy-pages.yml`:

```yaml
name: Deploy site to GitHub Pages

on:
  push:
    branches: [main]
    paths:
      - 'docs/product/mockups/**'        # use 'site/**' if you took option B
      - '.github/workflows/deploy-pages.yml'
  workflow_dispatch:                      # allow manual runs

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs/product/mockups      # the site root (or ./site)
      - id: deployment
        uses: actions/deploy-pages@v4
```

No Node, no install, no build — it just uploads the static folder.

## 4. One-time repo setup (manual, in GitHub UI)

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   (Not "Deploy from a branch" — we use the workflow above.)
2. Confirm the repo allows Actions to deploy Pages (default for public repos).
3. First run: merge the workflow to `main`, or trigger it via
   **Actions → Deploy site to GitHub Pages → Run workflow**.

Default URL: `https://bobberrisford.github.io/affiliatemcp/`.

## 5. Go-live sequence

1. **Pick the final URL** (§6) — subpath vs custom domain.
2. **(Optional) promote `mockups/` → `site/`** (option B) and update the
   workflow `path:`.
3. **Add the deploy workflow** and the pre-launch polish items (§8).
4. **Enable Pages** with the Actions source (§4).
5. **Merge the feature branch to `main`.** The current work is on
   `claude/website-onboarding-plan-OdrIq`; deployment triggers from `main`.
6. **Watch the Action run**, then open the `page_url` it prints.
7. **Verify** (§9), then announce.

## 6. URL / custom domain (decision needed)

- **github.io subpath** — `bobberrisford.github.io/affiliatemcp/`. Zero extra
  setup. Fine for a first launch.
- **Custom domain** (e.g. `affiliate-mcp.dev` or a subdomain) — add a `CNAME`
  file to the site folder containing the domain, set the DNS record
  (`CNAME` → `bobberrisford.github.io`, or `A`/`AAAA` records for an apex
  domain per GitHub's docs), and set the domain under **Settings → Pages**.
  Enable **Enforce HTTPS** once the certificate provisions.

Recommendation: launch on the subpath, move to a custom domain when ready —
no code changes either way because links are relative.

## 7. Fonts & the no-telemetry ethos (flag)

The pages load Bricolage Grotesque / Space Grotesk / JetBrains Mono from the
**Google Fonts CDN**. That means visitors' browsers make a request to Google.
For a project whose whole pitch is *"no telemetry, your data stays yours,"*
that's a small but real inconsistency, and it's worth closing before launch:

- **Self-host the fonts** — download the WOFF2 files, drop them in
  `site/fonts/`, and replace the `@import` with local `@font-face` rules. No
  third-party request, faster first paint, and it matches the brand promise.

Low effort, recommended. (The design-system README already flags fonts as a
swap-in point.)

## 8. Pre-launch polish checklist

These aren't blockers but should land before a public link:

- [ ] **Favicon + touch icon** — wire up `../design-system/assets/mark.svg` as
      the favicon on every page (`<link rel="icon" href="...mark.svg">`).
- [ ] **Meta + Open Graph tags** — title, description, `og:title`,
      `og:description`, `og:image` (a social card — the design system's social
      kit has one), `twitter:card`. Drives how links unfurl on LinkedIn/Slack/X.
- [ ] **Self-host fonts** (§7).
- [ ] **`404.html`** — a branded not-found page (GitHub Pages serves it
      automatically).
- [ ] **`robots.txt` + `sitemap.xml`** — small, helps indexing.
- [ ] **Real links** — replace any remaining placeholder `#` hrefs; confirm the
      GitHub, manifesto, and `adopt-a-network` issue links resolve.
- [ ] **Accessibility pass** — heading order, image alt text, AA contrast,
      keyboard-reachable search/filter/tabs.
- [ ] **Mobile pass** — check the hero, ladder, network grid, and adopt finder
      at phone widths.

## 9. Post-deploy verification

- Every nav link and footer link resolves (no 404s) on the live host.
- Interactive bits work in production: hero publisher/brand toggle, install
  tabs + copy buttons, networks search/filter, adopt finder + claim links.
- Fonts render (the punk display face, not a fallback).
- Lighthouse: performance, accessibility, best-practices, SEO.
- Looks right on a real phone.

## 10. Operating it after launch

- **Updates**: edit a page, push to `main`, the workflow redeploys in ~1 min.
- **Rollback**: revert the commit (or re-run the workflow on an earlier SHA);
  Pages serves the last successful artifact until the new one deploys.
- **PR previews**: GitHub Pages doesn't do per-PR preview URLs. If those become
  valuable, that's the main reason to consider Cloudflare Pages / Netlify
  later — noted, not needed now.
- **Network data drift**: the network list is hand-maintained in each page for
  the static build. When it matters, generate it from the same source the
  README auto-generates from (see `website-plan.md` §8) as part of a future
  build step — the cleanest trigger to revisit the Astro option.

## 11. Open decisions for the owner

1. **URL**: ~~github.io subpath to start, or go straight to a custom domain?~~
   Resolved: custom apex domain `agenticaffiliate.ai`.
2. **Layout**: ~~keep serving from `docs/product/mockups/`, or promote to
   `site/` before launch?~~ Resolved: promoted to top-level `site/`.
3. **Fonts**: ~~self-host before launch (recommended), or accept the Google CDN
   request for v1?~~ Resolved: fonts are self-hosted under `site/fonts/`.
4. **Scope at launch**: ship the six pages now, or hold for
   `privacy` / `contribute` / `faq` first? (`privacy`, `contribute`, and `faq`
   pages now exist in `site/`.)
