/**
 * Credential-help sidecar (D8).
 *
 * `SetupStep` in `src/shared/types.ts` is declared STABLE and must not grow new
 * fields. The desktop app, however, wants two things the adapter step list does
 * not carry: a deep-link straight to the exact dashboard page where a credential
 * lives, and (optionally) an app-tuned description that reads better in a GUI
 * sidebar than the wizard's multi-line terminal prose.
 *
 * This module is that open-data layer. It is keyed `slug -> field -> help`, using
 * the REAL field names each adapter's `setupSteps()` emits. `facade.setupSteps()`
 * merges this over the adapter's own steps: a `description` here overrides the
 * adapter's, a `deepLink` is additive, and an `example` here fills one in only
 * when the adapter step did not already supply one.
 *
 * Authoring rules (mirrors CONTRIBUTING for adapters):
 *   - UK spelling in user-facing copy ("programme", "optimise").
 *   - A `deepLink` must be the network's real, documented dashboard/credentials
 *     page. Where the exact sub-page URL is not documented, link the portal root
 *     and add a `// TODO(verify-deeplink)` so a contributor (or the network
 *     itself) can tighten it later. NEVER invent a plausible-looking URL.
 *
 * Populated for the launch four: awin-advertiser, impact, partnerize, cj.
 * Other networks fall back to the adapter's own `description` with no deep-link.
 */

export interface CredentialHelp {
  /** Deep-link to the exact dashboard page where this credential is found. */
  deepLink?: string;
  /** GUI-tuned description; overrides the adapter step's description when present. */
  description?: string;
  /** Example value; fills the adapter step's example only if it had none. */
  example?: string;
}

/** `slug -> field -> help`. */
export type CredentialHelpMap = Record<string, Record<string, CredentialHelp>>;

export const CREDENTIAL_HELP: CredentialHelpMap = {
  // -------------------------------------------------------------------------
  // Awin (advertiser / brand side) — the launch "Awin".
  // One credential: a user-scoped OAuth token from Toolbox → API Credentials.
  // -------------------------------------------------------------------------
  'awin-advertiser': {
    AWIN_ADVERTISER_API_TOKEN: {
      // The Awin UI exposes token generation under Toolbox → API Credentials.
      // The advertiser portal is ui.awin.com; the API-credentials route is not
      // a documented stable deep-link, so link the portal root.
      deepLink: 'https://ui.awin.com/', // TODO(verify-deeplink): exact Toolbox → API Credentials route
      description:
        'Sign in to the Awin advertiser portal at ui.awin.com, then open Toolbox → API ' +
        'Credentials from the top navigation. Click Generate Token (or rotate an existing one ' +
        'if you have lost the value) and copy it straight away — Awin shows the value only once. ' +
        'The token is a long, random OAuth string with no spaces; paste it exactly, with no ' +
        'leading or trailing whitespace. It is user-scoped, so the same token your publisher ' +
        'Awin set-up already uses (AWIN_API_TOKEN) will usually work here too, as long as your ' +
        'sign-in is linked to at least one advertiser account. The adapter is read-only and we ' +
        'verify the token by listing the advertiser accounts it can reach. Note: the advertiser ' +
        'API is gated to the Awin Accelerate and Advanced plans — Entry-tier brands show up in ' +
        'the account list but return 401/403 on the data endpoints.',
    },
  },

  // -------------------------------------------------------------------------
  // Impact (publisher). Two credentials on one screen: Settings → API.
  // -------------------------------------------------------------------------
  impact: {
    IMPACT_ACCOUNT_SID: {
      deepLink: 'https://app.impact.com/', // TODO(verify-deeplink): exact Settings → API route
      description:
        'Sign in to Impact at app.impact.com, then open Settings (the gear icon, top-right) → ' +
        'API. The page is titled "Account SID and Auth Token". Copy the value from the ' +
        '"Account SID" field exactly, without trimming — it is an alphanumeric string that ' +
        'usually starts with "IR", and it doubles as the path prefix for every API call, so a ' +
        'stray space or missing character breaks all of them. The Auth Token (the next step) ' +
        'lives on this same screen, so keep the page open.',
      example: 'IRxxxxAbc…',
    },
    IMPACT_AUTH_TOKEN: {
      deepLink: 'https://app.impact.com/', // TODO(verify-deeplink): exact Settings → API route
      description:
        'On the same Impact screen (Settings → API → "Account SID and Auth Token"), click ' +
        '"Show" next to the "Auth Token" field and copy the value — a long random string. ' +
        'This is the Basic-auth password that pairs with your Account SID; the two are useless ' +
        'apart. It is long-lived but rotatable: if calls start returning 401, regenerate it on ' +
        'this screen and re-run setup with the new value.',
    },
  },

  // -------------------------------------------------------------------------
  // Partnerize (publisher). Three credentials; two from Account Settings,
  // the third auto-derived from the credentials.
  // -------------------------------------------------------------------------
  partnerize: {
    PARTNERIZE_APPLICATION_KEY: {
      deepLink: 'https://console.partnerize.com/', // TODO(verify-deeplink): exact Settings → Account Settings route
      description:
        'Sign in to the Partnerize console at console.partnerize.com, open your user menu ' +
        '(top-right) → Settings → Account Settings, and copy the value labelled "User ' +
        'Application Key". It is a short alphanumeric string. This key identifies the ' +
        'Partnerize network partition and does not rotate, so you set it once. The User API ' +
        'Key (the next step) is on the same screen.',
      example: 'a1b2c3d4e5f6g7h8',
    },
    PARTNERIZE_USER_API_KEY: {
      deepLink: 'https://console.partnerize.com/', // TODO(verify-deeplink): exact Settings → Account Settings route
      description:
        'On the same Partnerize screen (Settings → Account Settings), copy the value labelled ' +
        '"User API Key" — a short alphanumeric string, distinct from the Application Key above. ' +
        'This is the Basic-auth password used alongside your Application Key; the two are sent ' +
        'together on every call. If the key is revoked, regenerate it here and re-run setup.',
      example: 'z9y8x7w6v5u4t3s2',
    },
    PARTNERIZE_PUBLISHER_ID: {
      deepLink: 'https://console.partnerize.com/', // TODO(verify-deeplink): publisher id appears in the console URL after login
      description:
        'Your numeric Partnerize publisher ID. Setup normally derives this automatically from ' +
        'the two keys above (via GET /user/publisher), so you usually leave it blank. Set it ' +
        'by hand only if your credentials reach several publisher accounts and the wrong one ' +
        'was auto-selected. You can read the correct ID straight from the console URL after ' +
        'login — it appears as the digits in a path like /publisher/1234567.',
      example: '1234567',
    },
  },

  // -------------------------------------------------------------------------
  // CJ (publisher). One token + one company id (usually auto-derived).
  // -------------------------------------------------------------------------
  cj: {
    CJ_API_TOKEN: {
      // CJ documents Personal Access Tokens on the developer portal; the member
      // dashboard also surfaces them under Account → Personal Access Tokens.
      deepLink: 'https://developers.cj.com/account/personal-access-tokens',
      description:
        'Generate a Personal Access Token (PAT) in CJ. Sign in at members.cj.com, open the ' +
        'Account menu (top-right avatar) → Account, then the "Personal Access Tokens" tab in ' +
        'the sidebar, and click Create Token (the label may read "Generate New Token" on some ' +
        'accounts). Copy the value immediately — CJ does not show it again. It is a long ' +
        'random string; the adapter sends it as a Bearer token. The token is long-lived; if it ' +
        'ever leaks, revoke it on this same screen and create a fresh one.',
      example: 'by_kf93…',
    },
    CJ_COMPANY_ID: {
      deepLink: 'https://members.cj.com/', // TODO(verify-deeplink): company id is derived from the token, not a fixed page
      description:
        'Your numeric CJ publisher Company ID. Setup normally extracts this from your token ' +
        'automatically (via the GraphQL { me { companyId } } query), so you usually leave it ' +
        'blank. Set it by hand only if your token reaches several companies and the wrong one ' +
        'was picked — there is no dedicated page for it, so the simplest source is the setup ' +
        'wizard itself once your token validates.',
      example: '1234567',
    },
  },
};
