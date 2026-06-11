// @ts-check

const REPOSITORY_URL = 'https://github.com/bobberrisford/affiliatemcp';
const DESKTOP_TAG = /^desktop-v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Select the newest stable desktop release from a mixed repository release
 * stream. Server releases (`vX.Y.Z`) must never become desktop update feeds.
 * @param {Array<{ tag_name?: unknown, draft?: unknown, prerelease?: unknown }>} releases
 */
function selectLatestDesktopRelease(releases) {
  return releases
    .filter((release) => release?.draft !== true && release?.prerelease !== true)
    .map((release) => {
      const tag = typeof release?.tag_name === 'string' ? release.tag_name : '';
      const match = DESKTOP_TAG.exec(tag);
      return match
        ? { tag, version: `${match[1]}.${match[2]}.${match[3]}` }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => compareVersions(b.version, a.version))[0] || null;
}

/** @param {string} tag */
function desktopReleaseFeed(tag) {
  if (!DESKTOP_TAG.test(tag)) throw new Error(`Invalid desktop release tag: ${tag}`);
  return `${REPOSITORY_URL}/releases/download/${tag}/`;
}

/** @param {string} tag */
function desktopReleasePage(tag) {
  if (!DESKTOP_TAG.test(tag)) throw new Error(`Invalid desktop release tag: ${tag}`);
  return `${REPOSITORY_URL}/releases/tag/${tag}`;
}

/** @param {string} a @param {string} b */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (pa[i] || 0) - (pb[i] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

module.exports = {
  compareVersions,
  desktopReleaseFeed,
  desktopReleasePage,
  selectLatestDesktopRelease,
};
