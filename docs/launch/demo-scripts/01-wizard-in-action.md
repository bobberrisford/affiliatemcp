# Demo 01 — the wizard in action

**Target duration**: 90 seconds.
**Output**: an MP4 / WebM / GIF showing the install-and-configure flow
end to end. Voiceover ~120 words per minute (≈180 words for 90s).

## Setup before recording

- Terminal at 120×32, large legible font (Menlo / Fira Code 16pt).
- Empty `$HOME/.affiliate-mcp/` (delete if it exists).
- A real Awin publisher account in another tab/window (do not show the
  Awin dashboard on camera; just have it ready to copy the token).
- The token already on the clipboard. Do not record the token-acquisition
  step here; that is what the per-network setup doc is for.
- Shell prompt simplified (`PS1='$ '`).
- `npm cache verify` recently run so the first `npx` invocation does
  not stall on first-time downloads.
- Screen recorder primed; mouse/keyboard inputs visible if the recorder
  supports it.

## Shot list

| # | T (s) | Action | On-screen text / terminal command |
|---|------:|--------|-----------------------------------|
| 1 | 0–4   | Title card: "affiliate-mcp — setup wizard". Plain text, no logo. | "affiliate-mcp — setup wizard" |
| 2 | 4–10  | Clean terminal. Type the install command. | `npx affiliate-networks-mcp setup` |
| 3 | 10–18 | npx fetches the package. Wait for the wizard banner ("affiliate-mcp setup wizard — pick a network"). | (terminal output) |
| 4 | 18–24 | Wizard lists the five networks. Highlight Awin with arrow key, press Enter. | `> Awin` |
| 5 | 24–35 | Wizard prompts for `AWIN_API_TOKEN`. Paste the token (do not type it on camera; the value should be off-screen on the clipboard). | `AWIN_API_TOKEN: ●●●●●●●●` |
| 6 | 35–45 | **Cut to highlight**: the validation line ("Validating against Awin /publishers... ok, publisher id 12345"). Zoom 1.3×. | `✓ Validated. Derived AWIN_PUBLISHER_ID=12345 (press Enter to accept)` |
| 7 | 45–50 | Press Enter to accept the derived publisher ID. | (Enter) |
| 8 | 50–58 | Wizard writes the env file. Show the path + mode confirmation line. | `Wrote ~/.affiliate-mcp/.env (mode 0600).` |
| 9 | 58–68 | Run `ls -l ~/.affiliate-mcp/.env`. **Cut to highlight**: the `-rw-------` mode. Zoom 1.5×. | `-rw------- 1 user user 84 ... .env` |
| 10 | 68–82 | Run `affiliate-networks-mcp test awin`. Watch each operation tick green. | `✓ listProgrammes  ✓ getProgramme  …` |
| 11 | 82–88 | Final frame: the green summary line. | `5 of 7 operations supported (Awin does not expose listClicks).` |
| 12 | 88–90 | End card: repo URL + "Bring your own keys. No telemetry." | (text card) |

## Voiceover (≈180 words)

> `affiliate-mcp` is a Model Context Protocol server for affiliate
> networks. It runs locally on your machine. There is no hosted
> service and no telemetry.
>
> One command starts the setup wizard.
>
> The wizard lists the five bundled networks: Awin, CJ Affiliate, eBay
> Partner Network, Impact, and Rakuten Advertising. We'll configure
> Awin.
>
> The wizard asks for your Awin API token. As soon as you paste it, the
> wizard calls Awin's `/publishers` endpoint to validate the token. If
> the call succeeds, the wizard reads your publisher ID from the
> response and offers it as the default value for the next step. You
> press Enter to accept it. No second copy-and-paste.
>
> The wizard writes the configuration to a file under your home
> directory. The file is mode `0600` — readable only by you.
>
> `affiliate-networks-mcp test awin` runs the diagnostic against your real
> account. Each supported operation is exercised with the minimum
> viable query. `listClicks` is reported as unsupported, with the
> reason from Awin's documentation.
>
> Five networks, thirty-five tools, two meta tools. Bring your own
> keys.

## Cuts to highlight

- Frame 35–45: the credential-validation moment. The viewer must see
  "validating... ok" so the live-validation property is visible. Zoom
  the terminal 1.3× and hold for a full beat after the green tick
  appears.
- Frame 58–68: the file-mode confirmation. The `-rw-------` characters
  must be legible. This is the "no telemetry, your secret stays on
  your box" beat.
- Frame 68–82: the per-operation tick list. The viewer reads
  individual operation names — `listProgrammes`, `getProgramme`,
  `listTransactions`, `getEarningsSummary`, `listClicks`,
  `generateTrackingLink`, `verifyAuth`. Hold each tick for a third of
  a second.

## What to NOT show

- The literal token characters. The terminal masks them, but make sure
  the paste source (clipboard manager) does not display a preview
  on-screen.
- The Awin dashboard. The token acquisition is in the setup doc; this
  video is about the wizard, not Awin's UI.
- Any prior `~/.affiliate-mcp/.env`. Delete it before recording.

## Post-production notes

- No music. The terminal beep is fine for emphasis (one beep when the
  validation tick appears, optional).
- Subtitles burn-in for the voiceover.
- End card: repository URL, the line "MIT licensed. No telemetry. Your
  credentials stay on your machine.", and the version number from
  `package.json` (currently `0.1.0`).
