/**
 * Static registry for the H5 guided connect flow
 * (`docs/product/hosted-mvp-workstream.md`, slice H5): the four networks the
 * hosted MVP offers, the credential fields each one needs, where a user finds
 * each value in that network's own dashboard, and an honest least-privilege
 * note per the custody record's clause 3
 * (`docs/decisions/2026-07-12-hosted-credential-custody.md`: "Where a network
 * offers scoped or read-only API keys, the connect flow instructs the user to
 * create one").
 *
 * Sourced from this repo's own setup docs and auth code, not re-derived from
 * scratch:
 *   - Field names and shapes: `src/networks/<slug>/network.json` (`env_vars`).
 *   - "Where to find it" copy: `docs/networks/<slug>.md` (the CLI setup
 *     walkthrough), condensed for a browser form rather than a terminal
 *     wizard.
 *   - Least-privilege note: none of the four setup docs describes a scoped or
 *     read-only key/token option for these networks — Awin, CJ, and Impact
 *     each document a single long-lived credential with full account access,
 *     and Rakuten's OAuth2 client-credentials pair is likewise undifferentiated
 *     by scope. That absence is stated plainly below rather than assumed:
 *     this file does not claim a scoped option exists where the docs are
 *     silent, and does not claim one does NOT exist on the network's side —
 *     only that this repo has not recorded one.
 *
 * "Four production networks" here is the workstream's shorthand for "the four
 * networks H5 offers hosted", not a claim that every one of them carries
 * `claim_status: "production"` in its own `network.json`. Only Awin does;
 * CJ, Impact, and Rakuten are `"partial"` (see each `network.json` and
 * `REPORT.md`). The connect flow surfaces that distinction rather than
 * papering over it — see `claimStatus` below and its use in
 * `src/routes/connect.ts`.
 *
 * OAuth note: none of the four adapters implements an interactive
 * browser-redirect OAuth flow. Rakuten's "oauth2" `auth_model` is
 * client-credentials (a client id + secret pair exchanged for a token
 * server-side, per `src/networks/rakuten/auth.ts`), entered by paste exactly
 * like the other three networks' credentials. So every network in this
 * registry is "guided paste-once", not "OAuth where supported" in the
 * browser-redirect sense the workstream brief's phrasing might suggest.
 */

export type ConnectNetworkSlug = 'awin' | 'cj' | 'impact' | 'rakuten';

export interface ConnectCredentialField {
  /** Exact env var name from `src/networks/<slug>/network.json` `env_vars`. */
  key: string;
  label: string;
  /** `password` masks the input; `text` does not (used for non-secret ids). */
  inputType: 'text' | 'password';
  /** Where in the network's own dashboard this value lives, condensed from `docs/networks/<slug>.md`. */
  whereToFind: string;
  placeholder?: string;
}

export interface ConnectNetwork {
  slug: ConnectNetworkSlug;
  name: string;
  /** This network's own `claim_status` from `network.json` — surfaced honestly, not smoothed over. */
  claimStatus: 'production' | 'partial' | 'experimental' | 'unsupported';
  docsUrl: string;
  /** Local CLI setup walkthrough this registry's copy was condensed from. */
  setupDocPath: string;
  fields: ConnectCredentialField[];
  /** Honest least-privilege note per the custody record's clause 3. */
  leastPrivilegeNote: string;
  /** The field whose last four characters are safe to show back to the user as a masked confirmation (never the full value). */
  maskedConfirmationField: string;
}

export const CONNECT_NETWORKS: readonly ConnectNetwork[] = [
  {
    slug: 'awin',
    name: 'Awin',
    claimStatus: 'production',
    docsUrl: 'https://help.awin.com/apidocs/introduction-1',
    setupDocPath: 'docs/networks/awin.md',
    fields: [
      {
        key: 'AWIN_API_TOKEN',
        label: 'API token',
        inputType: 'password',
        whereToFind:
          'Sign in at ui.awin.com. Open your account menu (top right) then Account, ' +
          'then the API credentials tab (sometimes labelled API access). Click ' +
          'Generate new token. Awin shows the value once; copy it immediately.',
      },
      {
        key: 'AWIN_PUBLISHER_ID',
        label: 'Publisher ID',
        inputType: 'text',
        whereToFind:
          'Your numeric publisher ID, shown at the top of the Account page and in ' +
          'most dashboard page URLs.',
        placeholder: '123456',
      },
    ],
    leastPrivilegeNote:
      "This repo's docs do not record a scoped or read-only token option for Awin: " +
      'the API credentials screen issues one long-lived token with the same access ' +
      'your dashboard login has. There is no lesser-privileged alternative documented ' +
      'here today. Generate a token specifically for this connection so it can be ' +
      'revoked on its own without affecting anything else using your account.',
    maskedConfirmationField: 'AWIN_API_TOKEN',
  },
  {
    slug: 'cj',
    name: 'CJ Affiliate',
    claimStatus: 'partial',
    docsUrl: 'https://developers.cj.com/',
    setupDocPath: 'docs/networks/cj.md',
    fields: [
      {
        key: 'CJ_API_TOKEN',
        label: 'Personal Access Token',
        inputType: 'password',
        whereToFind:
          'Sign in at members.cj.com. Open the account-avatar menu (top right) then ' +
          'Account, then the Personal Access Tokens tab (sometimes under a Developer ' +
          'sub-menu). Click Create Token (or Generate New Token). CJ shows the value once.',
      },
      {
        key: 'CJ_COMPANY_ID',
        label: 'Company ID',
        inputType: 'text',
        whereToFind:
          'Your numeric publisher Company ID, shown at the top of the Account page and ' +
          'in most dashboard page URLs.',
        placeholder: '1234567',
      },
    ],
    leastPrivilegeNote:
      "This repo's docs do not record a scoped or read-only Personal Access Token " +
      'option for CJ: the token issued from Account -> Personal Access Tokens carries ' +
      'the same access your dashboard login has. There is no lesser-privileged ' +
      'alternative documented here today. Create a token specifically for this ' +
      'connection so it can be revoked on its own.',
    maskedConfirmationField: 'CJ_API_TOKEN',
  },
  {
    slug: 'impact',
    name: 'Impact',
    claimStatus: 'partial',
    docsUrl: 'https://integrations.impact.com/impact-publisher/reference',
    setupDocPath: 'docs/networks/impact.md',
    fields: [
      {
        key: 'IMPACT_ACCOUNT_SID',
        label: 'Account SID',
        inputType: 'text',
        whereToFind:
          'Sign in at app.impact.com. Open Settings (gear icon) then API. The page is ' +
          'titled "Account SID and Auth Token". Copy the Account SID field exactly.',
      },
      {
        key: 'IMPACT_AUTH_TOKEN',
        label: 'Auth Token',
        inputType: 'password',
        whereToFind:
          'Same Settings -> API page. Click Show next to Auth Token and copy the value.',
      },
    ],
    leastPrivilegeNote:
      "This repo's docs do not record a scoped or read-only Auth Token option for " +
      'Impact: the Settings -> API screen shows one Account SID and Auth Token pair ' +
      'with the same access your dashboard login has. There is no lesser-privileged ' +
      'alternative documented here today. If your Impact plan supports additional ' +
      'API users with restricted roles, prefer one of those over your own primary ' +
      'login credentials; this repo has not verified whether your account tier offers it.',
    maskedConfirmationField: 'IMPACT_AUTH_TOKEN',
  },
  {
    slug: 'rakuten',
    name: 'Rakuten Advertising',
    claimStatus: 'partial',
    docsUrl: 'https://developers.rakutenadvertising.com/',
    setupDocPath: 'docs/networks/rakuten.md',
    fields: [
      {
        key: 'RAKUTEN_CLIENT_ID',
        label: 'OAuth2 Client ID',
        inputType: 'text',
        whereToFind:
          'Sign in at rakutenadvertising.com and switch to the Publisher view. Open ' +
          'Account then API Credentials. This requires Rakuten Publisher Solutions to ' +
          'have already granted API access (typically 3-7 business days); if the tab is ' +
          'missing, request access there before continuing.',
      },
      {
        key: 'RAKUTEN_CLIENT_SECRET',
        label: 'OAuth2 Client Secret',
        inputType: 'password',
        whereToFind:
          'Same Account -> API Credentials screen. Rakuten shows the Client Secret in ' +
          'full only once, at generation time.',
      },
      {
        key: 'RAKUTEN_SID',
        label: 'Site ID (SID)',
        inputType: 'text',
        whereToFind:
          'Open the Sites tab in the same Account area. Each publisher site has its own ' +
          'numeric Site ID. A single OAuth2 client can access more than one site, so this ' +
          'cannot be derived automatically.',
        placeholder: '4567890',
      },
    ],
    leastPrivilegeNote:
      "This repo's docs do not record a scoped or read-only credential option for " +
      'Rakuten: the API Credentials screen issues one client ID and secret pair with ' +
      'the same access your dashboard login has. There is no lesser-privileged ' +
      'alternative documented here today. Regenerating the pair invalidates the ' +
      'previous secret, so create a fresh pair for this connection rather than reusing ' +
      'one shared with another integration.',
    maskedConfirmationField: 'RAKUTEN_CLIENT_SECRET',
  },
];

export function findConnectNetwork(slug: string): ConnectNetwork | undefined {
  return CONNECT_NETWORKS.find((n) => n.slug === slug);
}
