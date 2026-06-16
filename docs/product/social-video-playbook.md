# Social video playbook (LinkedIn first)

> Status: working draft. Owner: Rob. Companion to
> [`website-copy.md`](./website-copy.md) and the design system under
> [`/design-system`](../../design-system/).
> Voice: plain and concrete, same as the website. UK English ("programme").
> Jargon (MCP, adapter, stdio) stays off the screen and out of captions.

## Why this exists

Our recent LinkedIn videos are screen recordings of the desktop website. The
desktop site is a wide (16:9) landscape layout, and LinkedIn's feed shows video
in a tall portrait frame. So the player crops both sides off, and the most
important parts of the frame fall outside the visible area.

In the last post you can watch this happen:

- The hero headline "**y**our ai runs your **a**ffiliate business" loses its
  first letters on the left edge.
- The "Claude extension" and "Desktop app" buttons, the "OPEN SOURCE" chip, and
  the GitHub URL all run off the right edge.
- The desktop text was sized for a laptop screen, so once it is shrunk into the
  feed it is too small to read on a phone.
- Autoplay is muted, so the spoken or musical track carries nothing. Whatever
  the viewer needs has to be readable on screen with the sound off.

None of this is a content problem. It is a format problem, and a fixed format
fixes it every time. This document is that fixed format.

## The one rule

**Never post a raw desktop screen recording.** A 16:9 capture of the laptop site
will always be cropped and always be too small. Every video is built to the
canvas spec below, or it does not go out.

## Canvas spec

| Setting | Value | Why |
| --- | --- | --- |
| Aspect ratio | **4:5 portrait** (1080 x 1350) | Tallest frame LinkedIn shows in-feed without cropping. Wins the most vertical space on a phone. |
| Fallback ratio | 1:1 square (1080 x 1080) | Use only if a tool cannot export 4:5. Never go wider than square. |
| Frame rate | 30 fps | Plenty for screen content and motion. |
| Length | 20 to 45 seconds | Long enough for one idea, short enough to finish. |
| Max file size | Under 200 MB | Comfortable inside LinkedIn's limit; uploads reliably. |
| Format | MP4, H.264 | Most compatible. |

### Safe area

LinkedIn lays its own buttons over the video. Keep content out of the way:

- **Top 8%**: leave clear. The poster name and "…" menu sit here.
- **Bottom 15%**: leave clear. The like/comment bar and the caption sit here.
- **Right 12%**: leave clear. The mute toggle and side actions sit here (this is
  exactly where our buttons got clipped).
- All text and all calls to action live inside the central safe box. Background
  colour and texture can run to the edges; **meaning cannot**.

### Type sizes (built for a phone, not a laptop)

Design at 1080 x 1350 and check it at the size of a thumbnail. If you cannot
read it on your own phone held at arm's length, it is too small.

- Headline: Bricolage Grotesque, 800 weight, large enough to fill most of the
  frame width. Two or three words per line, no more.
- Body / captions: Space Grotesk, 500 weight.
- Status chips and labels ("OPEN SOURCE", "Available now"): JetBrains Mono.

### Brand frame

Pull straight from the design system so every post looks like us:

- Background: ink `#0B0B0C` on dark beats, paper `#FFFFFF` on light beats. Pick
  one and hold it; do not alternate every second.
- Primary accent: riso blue `#2B2BFF`. Secondary / "down" / alert: hot pink
  `#FF2E88`. No green.
- Logo: `design-system/assets/mark.svg`, bottom-left, inside the safe box, on
  every end card.
- Aesthetic is the website's: photocopy / riso / gig-poster, heavy ink, two
  electric accents. Anti-dashboard.

## Captions are not optional

Most of the feed plays muted. Two things, always:

1. **Burned-in captions** for any spoken word, sitting above the bottom 15% safe
   line so LinkedIn's own caption bar does not collide with them.
2. **The point is on screen as text**, not only spoken. If the sound being off
   means the video says nothing, rebuild it.

Also upload the SRT file in LinkedIn's caption field for accessibility, in
addition to the burned-in text.

## The repeatable structure (six beats)

Every post follows the same beats. Only the middle changes week to week.

1. **Hook (0 to 2s).** One on-screen line that names the pain. Example: "Still
   logging into six dashboards?" Big type, dark frame, no logo yet.
2. **Problem (2 to 6s).** One concrete version of the grind. Example: "Pending
   commissions, stuck, across every network."
3. **The ask (6 to 18s).** Show the real thing: a plain-English question typed
   into Claude or Codex and the answer coming back. **Record this at a portrait
   or square viewport, or zoom-crop tight on the chat panel** so it is readable
   in 4:5. Do not show the whole desktop window.
4. **The result (18 to 30s).** The useful output. A number, a list of stuck
   transactions, a dead-link count. One clear takeaway.
5. **CTA (30 to 38s).** One action, inside the safe box, never at the edge:
   "Free and open source. Link in the comments." Keep links out of the frozen
   right edge.
6. **End card (38 to 45s).** Ink frame, riso-blue mark, one line: "Agentic
   affiliate." Hold for two seconds so it is the thumbnail-able last frame.

## How to get a readable product shot

The website is the asset we keep cropping. Two ways to use it without the crop:

- **Record a narrow viewport.** In the browser, set the window to a portrait or
  square shape (or use device-emulation at ~1080 x 1350) before recording, so
  the captured layout already fits the canvas. The site is responsive, so the
  mobile layout stacks and reads well in portrait.
- **Or rebuild the beat as a designed frame.** For the hero line, do not film the
  desktop hero. Recreate it as a 1080 x 1350 frame using the design-system
  colours and fonts, with the headline sized for the canvas. This is what keeps
  the headline from losing its first letters.

Never shrink a wide desktop capture to "make it fit". That is the exact move that
produced the cropped post.

## Caption and posting copy

Keep the on-LinkedIn text in the same plain voice as the site.

- **First line is the hook**, because LinkedIn truncates after ~140 characters
  before "…more". Front-load the point.
- 3 to 5 short lines, line breaks between them, no wall of text.
- **Put the link in the first comment, not the post body.** LinkedIn suppresses
  reach on posts with outbound links in the body; a comment link avoids that.
- 3 to 5 hashtags, lower-case, specific: `#affiliatemarketing #affiliate
  #automation #opensource #claude`.

Reusable caption template:

```
[Hook line: the pain, in plain words]

[One line: what the video shows]
[One line: the result]

Free and open source. Link in the first comment.

#affiliatemarketing #affiliate #automation #opensource
```

## Pre-flight checklist (run before every post)

- [ ] Exported at 4:5 (1080 x 1350), or 1:1 if 4:5 is impossible. Never wider.
- [ ] Watched on a phone, in the LinkedIn preview, sound off.
- [ ] No headline letter, button, chip, or URL touches any edge.
- [ ] Nothing important sits in the top 8%, bottom 15%, or right 12%.
- [ ] The whole point lands with the sound off.
- [ ] Captions burned in and the SRT uploaded.
- [ ] One CTA only, inside the safe box.
- [ ] End card holds the mark and one line for two seconds.
- [ ] Link is in the first comment, not the body.
- [ ] First caption line works on its own before "…more".

## Cadence and pillars

Consistency beats volume. One post a week, same format, rotating pillar:

1. **A real question answered** ("What did I earn across all networks last
   month?") with the readable chat shot.
2. **A thing dashboards don't surface** (transactions stuck pending, reversal
   spikes, dead links).
3. **Pick your side** (one for publishers, one for brands and agencies),
   straight from the website's two-audience split.
4. **Trust** (data stays on your machine, no telemetry, open source).

Same six beats, same canvas, same brand frame every time. The only variable is
which pillar fills beats 2 to 4.

## What this does not cover

- Paid promotion, boosting, or audience targeting.
- Other platforms. The 4:5 canvas and burned-in captions carry over to
  Instagram and TikTok, but their hook timing and caption rules differ and are
  out of scope here.
- Video editing tooling. The spec is tool-agnostic on purpose.
