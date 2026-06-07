// @ts-check
/**
 * electron-builder `afterSign` hook — notarise the signed .app, but ONLY when
 * the Apple credentials are present in the environment. This keeps local
 * `npm run dist` working (it produces an unsigned/un-notarised .dmg) while a
 * release machine with the secrets set gets a fully notarised build.
 *
 * Required env for notarisation (all three, supplied by the human at release):
 *   APPLE_ID                      — the Apple Developer account email
 *   APPLE_APP_SPECIFIC_PASSWORD   — an app-specific password for that account
 *   APPLE_TEAM_ID                 — the Developer Team ID
 *
 * Signing itself (separate from notarisation) is driven by electron-builder's
 * own env vars: CSC_LINK (path/URL to the .p12) and CSC_KEY_PASSWORD. With
 * neither set, electron-builder skips signing and emits an unsigned app — no
 * crash. We mirror that for notarisation here.
 */
const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.warn(
      '[notarize] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set — ' +
        'skipping notarisation. The .dmg will be produced unsigned/un-notarised. ' +
        'Set all three to notarise a release build.',
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  console.log(`[notarize] notarising ${appName}.app …`);
  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId,
    appleIdPassword,
    teamId,
  });
  console.log('[notarize] done.');
};
