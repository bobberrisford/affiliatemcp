# Deployment plan: the affiliate-mcp site

> Companion to [`website-plan.md`](./website-plan.md) and
> [`website-copy.md`](./website-copy.md). Decisions locked: **host on GitHub
> Pages**, **ship the current self-contained static HTML as-is** (no build
> step). The deployable pages live in [`site/`](../../site) and use the
> canonical apex domain **`agenticaffiliate.ai`**.
>
> **Status:** the in-repo work is complete. The remaining go-live steps are to
> configure DNS at the `.ai` registrar, set the custom domain under Settings
> to Pages, deploy from `main`, and verify the live host.

## 1. What we're deploying

Nine self-contained public HTML pages — `index.html`, `get-started.html`,
`what-you-can-ask.html`, `networks.html`, `adopt.html`, `mission.html`,
`privacy.html`, `contribute.html`, and `faq.html` — plus `404.html`. Each page
inlines its own CSS, nav/footer, and data, so there is **no build**. Fonts are
self-hosted under `site/fonts/`.

Internal links are **relative** (`networks.html`, `index.html#how`). Canonical,
Open Graph, sitemap, and robots URLs use `https://agenticaffiliate.ai/`.

## 2. Approach: GitHub Pages via Actions

GitHub Pages is the right host: free, lives in this repo, and deploys from a
workflow that sits next to the existing `ci.yml`/`publish.yml`. Because the site
is static, the "build" is just packaging a folder and uploading it.

The Pages workflow uploads the top-level `site/` directory. The artifact root
becomes the site root.

## 3. The deploy workflow

Add `.github/workflows/deploy-pages.yml`:

```yaml
name: Deploy site to GitHub Pages

on:
  push:
    branches: [main]
    paths:
      - 'site/**'
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
          path: site
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

The repository currently uses the default
`https://bobberrisford.github.io/affiliatemcp/` URL. The intended canonical URL
after the manual custom-domain setup is `https://agenticaffiliate.ai/`.

## 5. Go-live sequence

1. Configure the apex-domain DNS records and verify domain ownership (§6).
2. Set `agenticaffiliate.ai` under **Settings → Pages → Custom domain**.
3. Merge the site branch to `main`; deployment triggers from `main`.
4. Watch the Action run, then open the `page_url` it prints.
5. Enable **Enforce HTTPS** when GitHub makes it available.
6. Verify (§9), then announce.

## 6. URL / custom domain

The selected domain is the apex `agenticaffiliate.ai`. Configure `A`/`AAAA`,
`ALIAS`, or `ANAME` records supported by the registrar, verify the domain, and
set it under **Settings → Pages**.

This repository publishes through a custom GitHub Actions workflow. GitHub
ignores a `CNAME` file in the deployed artifact for this publishing mode; the
custom domain must be configured through repository settings or the Pages API.
Enable **Enforce HTTPS** once the certificate provisions.

## 7. Fonts and third-party requests

Bricolage Grotesque, Space Grotesk, and JetBrains Mono are self-hosted under
`site/fonts/`. The public pages do not load fonts from the Google Fonts CDN.

## 8. Pre-launch polish checklist

These aren't blockers but should land before a public link:

- [ ] **Favicon + touch icon** — wire up `../design-system/assets/mark.svg` as
      the favicon on every page (`<link rel="icon" href="...mark.svg">`).
- [x] **Meta + Open Graph tags** — title, description, `og:title`,
      `og:description`, `og:image` (a social card — the design system's social
      kit has one), `twitter:card`. Drives how links unfurl on LinkedIn/Slack/X.
- [x] **Self-host fonts** (§7).
- [x] **`404.html`** — a branded not-found page (GitHub Pages serves it
      automatically).
- [x] **`robots.txt` + `sitemap.xml`** — small, helps indexing.
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

## 11. Recorded decisions

1. **URL**: ~~github.io subpath to start, or go straight to a custom domain?~~
   Resolved: custom apex domain `agenticaffiliate.ai`.
2. **Layout**: ~~keep serving from `docs/product/mockups/`, or promote to
   `site/` before launch?~~ Resolved: promoted to top-level `site/`.
3. **Fonts**: ~~self-host before launch (recommended), or accept the Google CDN
   request for v1?~~ Resolved: fonts are self-hosted under `site/fonts/`.
4. **Scope at launch**: resolved: ship all nine public pages, including
   `privacy`, `contribute`, and `faq`.
