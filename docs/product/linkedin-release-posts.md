# Posting releases to LinkedIn

Goal: when a new `affiliate-mcp` version ships, the LinkedIn post should
look polished and actually get reach — not vanish into the feed.

## Why the obvious approach underperforms

The default move is to paste the GitHub release URL into a post. That's
the weakest option for two reasons:

1. **LinkedIn demotes posts with an external link in the body.** The feed
   ranking favours content that keeps people on-platform, so a link in the
   post text suppresses impressions.
2. **The link preview isn't release-specific.** A pasted GitHub release URL
   only ever surfaces the repository's generic social-preview image, so
   every release looks identical and there's nothing to stop the scroll.

## What works instead

Two complementary levers:

### 1. A native "release card" image (the big win)

A natively-uploaded image ranks far better than a link preview, and a
**release-specific** card gives people a reason to stop. The card carries,
in priority order:

- an **audience hook** — the value prop ("Chat to your affiliate data with
  Claude"), not just a changelog;
- the **version** being announced;
- **2–4 headline changes**;
- the **network-coverage** figure (publisher + brand side), a concrete and
  growing number;
- a **new-network spotlight** when the release adds adapters.

Generate it with:

```sh
npm run generate:release-card -- \
  --version v0.3.0 \
  --change "Added the Rakuten advertiser adapter" \
  --change "Faster transaction pagination across all networks" \
  --new-network "Rakuten (brand side)"
```

Or feed it the GitHub auto-generated release notes and let it pull the
headlines (PR/author noise is stripped automatically):

```sh
npm run generate:release-card -- --version v0.3.0 --notes release-notes.md
```

Outputs (in `docs/images/`):

- `release-card.png` — 1200×627 (LinkedIn's optimal 1.91:1 single-image
  ratio), rasterised at 2× for crispness.
- `release-card.svg` — the same card as vector, in case you want to tweak
  it or re-render at another size.
- `release-post.txt` — ready-to-paste post copy.

The card is composed as an SVG and rasterised with `@resvg/resvg-js` (a
dev dependency) — **no browser needed**, so this runs anywhere `npm
install` runs, including headless CI and Claude Code on the web. The
network count is read live from the `network.json` manifests, so it never
drifts from reality. These files are regenerated per release and are not
committed.

### 2. Posting convention

The generated `release-post.txt` already follows the engagement playbook:

- **Hook on the first line** (it's what shows above the "…more" fold).
- **No link in the body.** The release URL goes in the **first comment** —
  the copy ends with a reminder and the URL appended after a `---` divider
  for you to paste separately.
- A short value-prop line + a few hashtags.

Workflow: upload `release-card.png` as a native image, paste the post body,
publish, then drop the release URL as the first comment.

### 3. One-time: set the repo social-preview image

So that *any* time someone shares a release link it looks branded rather
than generic, set a Social preview image once in
**GitHub → repo Settings → General → Social preview**. You can reuse a
versionless render of the card for this (1280×640 is GitHub's recommended
size). This is a manual, one-off step.
