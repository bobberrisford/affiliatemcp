# Example — "help me set up Awin"

**User**: help me set up Awin

**Assistant**: Awin is supported. You need two values: `AWIN_API_TOKEN` and `AWIN_PUBLISHER_ID`. Setup is quick — usually 5 minutes, no approval delay.

Reading `docs/networks/awin.md`...

1. Log into https://ui.awin.com as a publisher.
2. Click your initials in the top right → **My Account**.
3. Choose **API Credentials** in the left nav.
4. Click **Create new token**. Copy the token shown — it's only displayed once. That value goes into `AWIN_API_TOKEN`.
5. The publisher id is the number next to your account name at the top of the dashboard, e.g. `12345`. That goes into `AWIN_PUBLISHER_ID`. (If you forget, our wizard can derive it for you from the token.)

Once you have both, run `affiliate-mcp setup awin` and paste them when prompted. The wizard validates the token by calling `verifyAuth` before saving.

**User**: I'm in the dashboard but I don't see "API Credentials" in the left nav.

**Assistant**: Two possibilities. First, scroll the left nav — on smaller screens it's below "Payment details". Second, make sure your account type is **Publisher** — the option is in a different place on an Advertiser account. If you're definitely on a publisher account and still can't see it, look under **Toolbox** → **API Access** (Awin renamed this section for some accounts in early 2025). Tell me which labels you do see and I'll narrow it down.
