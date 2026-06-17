// Social video generator. Not shipped; a working tool for producing
// LinkedIn-ready 4:5 posts from the canonical design system, per
// docs/product/social-video-playbook.md. It embeds design-system/colors_and_type.css
// and design-system/components.css verbatim and composes scenes from their
// classes (.mega, .label, .hl, .term, .data-table, .status, .card, .btn, .halftone).
// The only local CSS is the poster canvas, safe-area, and scene timeline.
//
// Run: node scripts/social-video.mjs <post-id>
// Posts are defined in scripts/social-posts.mjs.

import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { POSTS } from './social-posts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DS = path.join(ROOT, 'design-system');
const FONTS = path.join(DS, 'fonts');
const MARK = path.join(DS, 'assets', 'mark.svg');

const W = 1080;
const H = 1350;
const FPS = 30;
// Poster root size: design-system components are rem-based and tuned for the
// web. Scaling the root up renders the same components at poster size.
const ROOT_PX = 34;

const postId = process.argv[2];
const MODE = process.argv[3] || 'video'; // video | carousel | static
const post = POSTS[postId];
if (!post) {
  console.error(`Unknown post "${postId}". Known: ${Object.keys(POSTS).join(', ')}`);
  process.exit(1);
}

const OUT = path.join(ROOT, 'docs', 'product', 'social-assets', postId);
mkdirSync(OUT, { recursive: true });

// --- Design-system CSS, embedded verbatim --------------------------------
// The bundled woff2 files load reliably as data URIs without a format() hint
// in headless Chromium, so we strip the stylesheet's own @font-face blocks
// (which use file paths + format('woff2')) and supply data-URI faces instead.
const fontFace = (family, weights, file) =>
  `@font-face{font-family:'${family}';font-weight:${weights};font-display:swap;` +
  `src:url('data:font/woff2;base64,${readFileSync(path.join(FONTS, file)).toString('base64')}');}`;

const FONT_CSS = [
  fontFace('Bricolage Grotesque', '600 800', 'bricolage-grotesque.woff2'),
  fontFace('Space Grotesk', '400 700', 'space-grotesk.woff2'),
  fontFace('JetBrains Mono', '400 800', 'jetbrains-mono.woff2'),
].join('\n');

const COLORS_CSS = readFileSync(path.join(DS, 'colors_and_type.css'), 'utf8')
  .replace(/@font-face\s*\{[^}]*\}/g, '');
const COMPONENTS_CSS = readFileSync(path.join(DS, 'components.css'), 'utf8');

const markDataUri =
  'data:image/svg+xml;base64,' + readFileSync(MARK).toString('base64');
const MARK_HTML = `<div class="mark"><img src="${markDataUri}" alt=""><span class="h3">agentic affiliate</span></div>`;

// --- Poster layout (presentation only; no brand tokens redefined) ---------
const LAYOUT_CSS = `
html{font-size:${ROOT_PX}px;}
html,body{width:${W}px;height:${H}px;margin:0;overflow:hidden;background:var(--ink);}
.stage{position:relative;width:${W}px;height:${H}px;}
.scene{position:absolute;inset:0;
  /* safe area: clear of LinkedIn's top, bottom, and right UI */
  padding:150px 120px 220px 120px;
  display:flex;flex-direction:column;justify-content:center;gap:var(--s-5);}
.scene.on-ink{background:var(--ink);color:var(--fg-invert);}
.scene.on-paper{background:var(--paper);color:var(--fg);}
/* light-dot halftone for ink scenes (the .halftone utility is dark-on-light) */
.scene.on-ink.tex{background-image:radial-gradient(rgba(255,255,255,0.05) 2.2px,transparent 2.5px);background-size:26px 26px;background-color:var(--ink);}
.scene.on-paper.tex{background-image:radial-gradient(rgba(11,11,12,0.06) 2.2px,transparent 2.5px);background-size:26px 26px;background-color:var(--paper);}
.scene.on-ink .muted{color:var(--fg-invert-mut);}
/* .card is a paper surface; keep its text ink even on a dark scene */
.scene .card{color:var(--fg);}
.scene .label{color:var(--blue-bright);}
.scene.on-paper .label{color:var(--blue);}
.btns{display:flex;gap:var(--s-4);flex-wrap:wrap;}
.mark{position:absolute;left:120px;bottom:150px;display:flex;align-items:center;gap:var(--s-4);}
.mark img{width:78px;height:78px;}
.mark .h3{color:var(--fg-invert);}
.endwrap{justify-content:center;align-items:flex-start;}
/* single static poster: top content, bottom lockup */
.scene.poster{justify-content:space-between;padding-top:160px;padding-bottom:190px;}
.scene.poster .mark{position:static;}
.scene.poster .ptop{display:flex;flex-direction:column;gap:var(--s-5);}
.scene.poster .pbot{display:flex;flex-direction:column;gap:var(--s-4);}
/* carousel: flow each slide as its own print page instead of stacking */
.slide{position:relative;inset:auto;width:${W}px;height:${H}px;break-after:page;}
.pageno{position:absolute;top:64px;right:120px;font-family:var(--font-mono);font-size:0.72rem;font-weight:700;letter-spacing:0.12em;color:var(--blue-bright);}
.on-paper .pageno{color:var(--blue);}
.swipe{position:absolute;bottom:150px;right:120px;font-family:var(--font-mono);font-size:0.8rem;font-weight:700;letter-spacing:0.08em;color:var(--blue-bright);}
.foot{font-family:var(--font-mono);font-size:0.8rem;font-weight:700;letter-spacing:0.06em;color:var(--blue-bright);}
`;

const PRINT_CSS = `@page{size:${W}px ${H}px;margin:0;} html,body{height:auto;overflow:visible;}`;

function sceneKeyframes() {
  return post.scenes
    .map((s, i) => {
      const inA = (s.start / TOTAL) * 100;
      const inB = ((s.start + 0.45) / TOTAL) * 100;
      const outA = ((s.end - 0.35) / TOTAL) * 100;
      const outB = (s.end / TOTAL) * 100;
      return `@keyframes scene${i}{0%,${inA.toFixed(3)}%{opacity:0;transform:translateY(26px);}` +
        `${inB.toFixed(3)}%,${outA.toFixed(3)}%{opacity:1;transform:translateY(0);}` +
        `${outB.toFixed(3)}%,100%{opacity:0;transform:translateY(-18px);}}`;
    })
    .join('\n');
}

const TOTAL = post.scenes ? post.scenes[post.scenes.length - 1].end + 0.4 : 0;

function html({ still = null } = {}) {
  const scenesHtml = post.scenes
    .map((s, i) => {
      const animated =
        still === null
          ? `animation:scene${i} ${TOTAL}s linear forwards;`
          : still === i
            ? 'opacity:1;transform:none;'
            : 'opacity:0;';
      const body = s.html.replace('{{MARK}}', MARK_HTML);
      const cls = `scene tex ${s.bg === 'paper' ? 'on-paper' : 'on-ink'} ${s.wrap || ''}`;
      return `<section class="${cls}" style="${animated}">${body}</section>`;
    })
    .join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
${FONT_CSS}
${COLORS_CSS}
${COMPONENTS_CSS}
${LAYOUT_CSS}
${still === null ? sceneKeyframes() : ''}
</style></head><body>
<div class="amcp stage">${scenesHtml}</div>
</body></html>`;
}

// Carousel: every beat as a standalone page, with a page counter and a swipe
// hint on slide one. Rendered to a portrait PDF, LinkedIn's native document
// (carousel) format.
function carouselHtml() {
  const n = post.scenes.length;
  const slides = post.scenes
    .map((s, i) => {
      const body = s.html.replace('{{MARK}}', MARK_HTML);
      const cls = `scene tex slide ${s.bg === 'paper' ? 'on-paper' : 'on-ink'} ${s.wrap || ''}`;
      const pageno = `<div class="pageno">${String(i + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}</div>`;
      const hint = i === 0 ? `<div class="swipe">swipe →</div>` : '';
      return `<section class="${cls}">${pageno}${hint}${body}</section>`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${FONT_CSS}
${COLORS_CSS}
${COMPONENTS_CSS}
${LAYOUT_CSS}
${PRINT_CSS}
</style></head><body><div class="amcp">${slides}</div></body></html>`;
}

// Static: one self-contained poster (defined per post as `poster`).
function posterHtml() {
  const body = post.poster.replace('{{MARK}}', MARK_HTML);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${FONT_CSS}
${COLORS_CSS}
${COMPONENTS_CSS}
${LAYOUT_CSS}
</style></head><body>
<div class="amcp stage"><section class="scene tex on-ink poster">${body}</section></div>
</body></html>`;
}

async function renderStills(browser) {
  const stillPage = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  for (let i = 0; i < post.scenes.length; i++) {
    await stillPage.setContent(html({ still: i }), { waitUntil: 'networkidle' });
    await stillPage.evaluate(() => document.fonts.ready);
    const name = `frame-${String(i + 1).padStart(2, '0')}-${post.scenes[i].id}.png`;
    await stillPage.screenshot({ path: path.join(OUT, name) });
    console.log('still:', name);
  }
  await stillPage.close();
}

async function main() {
  const browser = await chromium.launch(
    process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {},
  );

  if (MODE === 'static') {
    if (!post.poster) throw new Error(`Post "${postId}" has no poster defined for static mode.`);
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await page.setContent(posterHtml(), { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const out = path.join(OUT, `${postId}-static.png`);
    await page.screenshot({ path: out });
    await browser.close();
    console.log('static:', path.relative(ROOT, out));
    return;
  }

  if (MODE === 'carousel') {
    await renderStills(browser); // per-slide PNGs, also usable individually
    const page = await browser.newPage();
    await page.setContent(carouselHtml(), { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const pdf = path.join(OUT, `${postId}-carousel.pdf`);
    await page.pdf({ path: pdf, width: `${W}px`, height: `${H}px`, printBackground: true });
    await browser.close();
    console.log('carousel:', path.relative(ROOT, pdf));
    return;
  }

  // video (default)
  const tmp = path.join(OUT, '.tmp-video');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await renderStills(browser);
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
  const mp4Path = path.join(OUT, `${postId}.mp4`);
  execFileSync(ffmpegPath, [
    '-y', '-i', path.join(tmp, webm),
    '-vf', `fps=${FPS},scale=${W}:${H}:flags=lanczos`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-r', String(FPS),
    mp4Path,
  ], { stdio: 'ignore' });
  rmSync(tmp, { recursive: true, force: true });
  console.log('video:', path.relative(ROOT, mp4Path));
}

main().catch((e) => { console.error(e); process.exit(1); });
