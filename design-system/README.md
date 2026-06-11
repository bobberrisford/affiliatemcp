# affiliate-mcp — design system (repo source of truth)

This directory is the **canonical** design system for affiliate-mcp surfaces
(the desktop app, the marketing site, docs mockups). It is the implemented,
bug-fixed export from Claude Design — every other copy in the repo should be
considered downstream of this one.

> Punk-rock, open-source. Riso Blue `#2B2BFF` + hot pink on ink & white.
> No green. No off-white. Two accents per composition, max. Hard corners,
> solid offset shadows, mono labels, no emoji. UK spelling.

## Files

| File | What it is |
|---|---|
| `colors_and_type.css` | **Import first.** All colour / type / spacing / motif tokens + signature utilities (`.hl`, `.chip`, `.stamp`, `.card-hard`, `.halftone`, links). |
| `components.css` | **Import second.** Canonical components: `.btn*`, `.card`, `.term`, `.data-table`, `.status`/`.dot-*`. Surfaces consume these — they do not re-define them. |
| `assets/mark.svg` | Brand mark — white terminal prompt on a riso-blue tile. |
| `assets/mark-glyph.svg` | Mark in `currentColor` for any background. |
| `adherence.oxlintrc.json` | Lint rules that keep code on-brand: no raw hex, no raw px, only the three brand fonts, import components from the entry point. |
| `manifest.json` | Token + card manifest from the design tool (reference). |

## How to consume

In any HTML surface:

```html
<link rel="stylesheet" href="<path>/design-system/colors_and_type.css" />
<link rel="stylesheet" href="<path>/design-system/components.css" />
<body class="amcp"> … </body>
```

Then use the tokens and component classes — never raw values:

- Colour → `var(--blue)`, `var(--ink)`, `var(--magenta)`, status `var(--pos|pending|neg)`.
- Spacing → `var(--s-1..--s-10)`; rules → `var(--rule|--rule-heavy)`.
- Type → `.h1/.h2/.h3`, `.mega`, `.label`, `.mono`; families via `var(--font-display|sans|mono)`.
- Buttons → `.btn .btn-primary | .btn-dark | .btn-ghost`.
- Surfaces → `.card`, `.term`, `.data-table`, `.chip`, `.stamp`, `.status`.

## Adherence lint

`adherence.oxlintrc.json` flags off-system values (raw hex/px, non-brand fonts).
Run it over a surface:

```
npm run lint:design
```

(see root `package.json`). Warnings, not errors — they catch drift in review.

## Fonts

Loaded from Google Fonts CDN in `colors_and_type.css` (all open-licensed, to
match the project's ethos). For an **offline** desktop build, self-host the
three families (`marketing/fonts/` already has woff2 files) and swap the
`@import` for `@font-face` — tracked as a desktop hardening task.
