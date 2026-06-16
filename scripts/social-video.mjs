// Social video generator. Not shipped; a working tool for producing
// LinkedIn-ready 4:5 posts from the design system, per
// docs/product/social-video-playbook.md. Renders branded 1080x1350 frames,
// exports each beat as a PNG, and records the animated sequence to MP4.
//
// Run: node scripts/social-video.mjs <post-id>
// Posts are defined in scripts/social-posts.mjs.

import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { POSTS } from './social-posts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FONTS = path.join(ROOT, 'design-system', 'fonts');
const MARK = path.join(ROOT, 'design-system', 'assets', 'mark.svg');

const W = 1080;
const H = 1350;
const FPS = 30;

const postId = process.argv[2];
const post = POSTS[postId];
if (!post) {
  console.error(`Unknown post "${postId}". Known: ${Object.keys(POSTS).join(', ')}`);
  process.exit(1);
}

const OUT = path.join(ROOT, 'docs', 'product', 'social-assets', postId);
mkdirSync(OUT, { recursive: true });

const fontUrl = (f) =>
  'data:font/woff2;base64,' + readFileSync(path.join(FONTS, f)).toString('base64');
const markDataUri =
  'data:image/svg+xml;base64,' + readFileSync(MARK).toString('base64');

// Total timeline is the end of the last scene plus a short tail.
const TOTAL = post.scenes[post.scenes.length - 1].end + 0.4;

function sceneKeyframes() {
  // Each scene fades+rises in over 0.45s, holds, fades out over 0.35s.
  return post.scenes
    .map((s, i) => {
      const inA = (s.start / TOTAL) * 100;
      const inB = ((s.start + 0.45) / TOTAL) * 100;
      const outA = ((s.end - 0.35) / TOTAL) * 100;
      const outB = (s.end / TOTAL) * 100;
      return `
@keyframes scene${i} {
  0%, ${inA.toFixed(3)}% { opacity: 0; transform: translateY(26px); }
  ${inB.toFixed(3)}%, ${outA.toFixed(3)}% { opacity: 1; transform: translateY(0); }
  ${outB.toFixed(3)}%, 100% { opacity: 0; transform: translateY(-18px); }
}`;
    })
    .join('\n');
}

function html({ still = null } = {}) {
  const scenesHtml = post.scenes
    .map((s, i) => {
      const animated =
        still === null
          ? `animation: scene${i} ${TOTAL}s linear forwards;`
          : still === i
            ? 'opacity:1; transform:none;'
            : 'opacity:0;';
      const body = s.html.replace('{{MARK}}', MARK_HTML);
      return `<section class="scene ${s.bg === 'paper' ? 'on-paper' : 'on-ink'} ${s.wrap || ''}" style="${animated}">
        ${body}
      </section>`;
    })
    .join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family:'Bricolage Grotesque'; font-weight:600 800; src:url('${fontUrl('bricolage-grotesque.woff2')}') ; }
@font-face { font-family:'Space Grotesk'; font-weight:400 700; src:url('${fontUrl('space-grotesk.woff2')}') ; }
@font-face { font-family:'JetBrains Mono'; font-weight:400 800; src:url('${fontUrl('jetbrains-mono.woff2')}') ; }
:root{
  --ink:#0B0B0C; --ink-soft:#16161B; --paper:#fff; --paper-2:#F2F3F7;
  --smudge:#8B8FA0; --smudge-dk:#565A6B; --blue:#2B2BFF; --blue-bright:#5A78FF;
  --magenta:#FF2E88; --amber:#E8A317;
}
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:${W}px;height:${H}px;overflow:hidden;}
body{font-family:'Space Grotesk',sans-serif;background:var(--ink);}
.stage{position:relative;width:${W}px;height:${H}px;background:var(--ink);}
.scene{
  position:absolute;inset:0;
  /* safe area: keep meaning clear of LinkedIn UI */
  padding:150px 120px 220px 120px;
  display:flex;flex-direction:column;justify-content:center;gap:34px;
}
.scene.on-ink{background:
  radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 1.4px, transparent 1.6px) 0 0/26px 26px,
  var(--ink);color:var(--paper);}
.scene.on-paper{background:
  radial-gradient(circle at 1px 1px, rgba(11,11,12,0.06) 1.4px, transparent 1.6px) 0 0/26px 26px,
  var(--paper);color:var(--ink);}
.kicker{font-family:'JetBrains Mono',monospace;font-weight:800;font-size:30px;
  letter-spacing:2px;text-transform:uppercase;color:var(--blue-bright);}
.on-paper .kicker{color:var(--blue);}
h1{font-family:'Bricolage Grotesque';font-weight:800;font-size:104px;line-height:0.98;
  letter-spacing:-2px;}
h1 .blue{color:var(--blue-bright);} .on-paper h1 .blue{color:var(--blue);}
h1 .pink{color:var(--magenta);}
.sub{font-size:42px;line-height:1.22;font-weight:500;color:#D7D9E4;}
.on-paper .sub{color:var(--smudge-dk);}
.chip{display:inline-block;font-family:'JetBrains Mono',monospace;font-weight:800;
  font-size:26px;letter-spacing:1px;padding:12px 20px;border:3px solid var(--blue-bright);
  color:var(--blue-bright);text-transform:uppercase;align-self:flex-start;}
.on-paper .chip{border-color:var(--blue);color:var(--blue);}
.bubble{background:var(--ink-soft);border:2px solid #2a2a33;border-radius:22px;
  padding:34px 38px;font-size:40px;line-height:1.25;}
.bubble.user{border-color:var(--blue);background:#10101e;}
.bubble .who{font-family:'JetBrains Mono',monospace;font-size:24px;font-weight:800;
  letter-spacing:1px;color:var(--smudge);text-transform:uppercase;margin-bottom:14px;display:block;}
.rows{display:flex;flex-direction:column;gap:18px;}
.row{display:flex;justify-content:space-between;align-items:baseline;
  border-bottom:2px solid #23232b;padding-bottom:16px;font-size:38px;}
.on-paper .row{border-color:#e3e4ec;}
.row .net{font-family:'JetBrains Mono',monospace;font-weight:700;}
.row .amt{font-family:'JetBrains Mono',monospace;font-weight:800;color:var(--blue-bright);}
.on-paper .row .amt{color:var(--blue);}
.note{font-family:'JetBrains Mono',monospace;font-size:30px;font-weight:700;color:var(--amber);}
.big-num{font-family:'Bricolage Grotesque';font-weight:800;font-size:160px;
  line-height:0.9;color:var(--blue-bright);letter-spacing:-3px;}
.on-paper .big-num{color:var(--blue);}
.cta{font-family:'Bricolage Grotesque';font-weight:800;font-size:78px;line-height:1.02;}
.url{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:34px;color:var(--blue-bright);}
.mark{position:absolute;left:120px;bottom:150px;display:flex;align-items:center;gap:22px;}
.mark img{width:74px;height:74px;}
.mark .word{font-family:'Bricolage Grotesque';font-weight:800;font-size:46px;}
.endwrap{align-items:flex-start;justify-content:center;}
${still === null ? sceneKeyframes() : ''}
</style></head><body>
<div class="stage">${scenesHtml}</div>
</body></html>`;
}

const MARK_HTML = `<div class="mark"><img src="${markDataUri}" alt=""><span class="word">Agentic affiliate</span></div>`;

async function main() {
  const browser = await chromium.launch(
    process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {},
  );
  const tmp = path.join(OUT, '.tmp-video');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  // 1) Still PNG per beat.
  const stillPage = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  for (let i = 0; i < post.scenes.length; i++) {
    await stillPage.setContent(html({ still: i }), { waitUntil: 'networkidle' });
    await stillPage.evaluate(() => document.fonts.ready);
    const name = `frame-${String(i + 1).padStart(2, '0')}-${post.scenes[i].id}.png`;
    await stillPage.screenshot({ path: path.join(OUT, name) });
    console.log('still:', name);
  }
  await stillPage.close();

  // 2) Record the animated timeline to video.
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: tmp, size: { width: W, height: H } },
  });
  const page = await ctx.newPage();
  await page.setContent(html(), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(TOTAL * 1000 + 300);
  await page.close();
  await ctx.close();
  await browser.close();

  const webm = readdirSync(tmp).find((f) => f.endsWith('.webm'));
  const webmPath = path.join(tmp, webm);
  const mp4Path = path.join(OUT, `${postId}.mp4`);
  execFileSync(ffmpegPath, [
    '-y', '-i', webmPath,
    '-vf', `fps=${FPS},scale=${W}:${H}:flags=lanczos`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-r', String(FPS),
    mp4Path,
  ], { stdio: 'ignore' });
  rmSync(tmp, { recursive: true, force: true });
  console.log('video:', path.relative(ROOT, mp4Path));
}

main().catch((e) => { console.error(e); process.exit(1); });
