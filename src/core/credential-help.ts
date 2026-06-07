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
        'Sign in to the Awin advertiser portal, then open Toolbox → API Credentials and ' +
        'generate an OAuth token (or rotate an existing one). Copy it immediately — Awin ' +
        'will not show the value again. The token is long-lived and user-scoped, so the same ' +
        'token your publisher Awin set-up uses will usually work here, provided your sign-in ' +
        'is linked to at least one advertiser account. The adapter is read-only and we verify ' +
        'the token by listing your addressable advertiser accounts. Note: the advertiser API ' +
        'is gated to Awin Accelerate and Advanced plans — Entry-tier brands appear in the ' +
        'account list but return 401/403 on data endpoints.',
    },
  },

  // -------------------------------------------------------------------------
  // Impact (publisher). Two credentials on one screen: Settings → API.
  // -------------------------------------------------------------------------
  impact: {
    IMPACT_ACCOUNT_SID: {
      deepLink: 'https://app.impact.com/', // TODO(verify-deeplink): exact Settings → API route
      description:
        'Sign in to Impact, open Settings (the gear icon) → API, and find the page titled ' +
        '"Account SID and Auth Token". Copy the Account SID exactly, without trimming — it is ' +
        'also the path prefix for every API call. The Auth Token (next step) lives on the same ' +
        'screen.',
      example: 'IRxxxxAbc…',
    },
    IMPACT_AUTH_TOKEN: {
      deepLink: 'https://app.impact.com/', // TODO(verify-deeplink): exact Settings → API route
      description:
        'On the same Impact screen (Settings → API → "Account SID and Auth Token"), click ' +
        '"Show" next to Auth Token and copy the value. This is the Basic-auth password paired ' +
        'with your Account SID. It is long-lived but rotatable: if calls start returning 401, ' +
        'regenerate it here and re-run setup.',
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
        'Sign in to the Partnerize console, open your user menu (top-right) → Settings → ' +
        'Account Settings, and copy the value under "User Application Key". This key identifies ' +
        'the Partnerize network partition and does not rotate.',
      example: 'a1b2c3d4e5f6g7h8',
    },
    PARTNERIZE_USER_API_KEY: {
      deepLink: 'https://console.partnerize.com/', // TODO(verify-deeplink): exact Settings → Account Settings route
      description:
        'On the same Partnerize screen (Settings → Account Settings), copy the value under ' +
        '"User API Key". This is the Basic-auth password used alongside your Application Key.',
      example: 'z9y8x7w6v5u4t3s2',
    },
    PARTNERIZE_PUBLISHER_ID: {
      deepLink: 'https://console.partnerize.com/', // TODO(verify-deeplink): publisher id appears in the console URL after login
      description:
        'Your numeric Partnerize publisher ID. Setup normally derives this automatically from ' +
        'your credentials, so you usually leave it blank. Set it manually only if your ' +
        'credentials reach several publisher accounts and the wrong one was auto-selected — ' +
        'you can read the correct ID from the console URL after login, e.g. /publisher/1234567.',
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
        'Account menu (top-right avatar) → Account, then the "Personal Access Tokens" tab, and ' +
        'click Create Token. Copy the value immediately — CJ does not show it again. The token ' +
        'is long-lived; revoke it from the same screen if it ever leaks.',
      example: 'by_kf93…',
    },
    CJ_COMPANY_ID: {
      deepLink: 'https://members.cj.com/', // TODO(verify-deeplink): company id is derived from the token, not a fixed page
      description:
        'Your numeric CJ publisher Company ID. Setup normally extracts this from your token ' +
        'automatically, so you usually leave it blank. Set it manually only if your token ' +
        'reaches several companies and the wrong one was picked.',
      example: '1234567',
    },
  },
};
