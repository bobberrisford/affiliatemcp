import { loadFont } from '@remotion/fonts';
import { staticFile } from 'remotion';

// Self-hosted variable fonts, copied from the repo design system. Loaded via
// @remotion/fonts so every frame renders with the brand type, no CDN call.
let loaded = false;

export const loadBrandFonts = async () => {
  if (loaded) return;
  loaded = true;
  await Promise.all([
    loadFont({
      family: 'Bricolage Grotesque',
      url: staticFile('fonts/bricolage-grotesque.woff2'),
      weight: '600 800',
    }),
    loadFont({
      family: 'Space Grotesk',
      url: staticFile('fonts/space-grotesk.woff2'),
      weight: '400 700',
    }),
    loadFont({
      family: 'JetBrains Mono',
      url: staticFile('fonts/jetbrains-mono.woff2'),
      weight: '400 800',
    }),
  ]);
};
