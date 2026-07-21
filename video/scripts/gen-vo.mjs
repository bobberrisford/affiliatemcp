// Generates the voiceover track for HostedVideo.
//
// For each line in src/vo/lines.json it writes public/vo/<id>.wav and records
// the clip's duration in src/vo/manifest.json. The composition reads that
// manifest to size each scene, so the pacing always matches the narration.
//
// Default voice is espeak-ng (offline, installed here). It is a synthetic
// placeholder: to use a premium voice, drop a same-named file in public/vo/
// (e.g. vo/title.mp3 from ElevenLabs) and re-run — an existing .mp3 is
// preferred over regenerating the .wav, and durations are re-measured either
// way. Run with: npm run vo
//
// Requires: espeak-ng on PATH (apt-get install -y espeak-ng).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const voDir = join(root, 'public', 'vo');
const linesPath = join(root, 'src', 'vo', 'lines.json');
const manifestPath = join(root, 'src', 'vo', 'manifest.json');

const FPS = 30;
// espeak-ng: -s words/min (calmer for narration), -p pitch, en-gb voice.
const ESPEAK_ARGS = ['-v', 'en-gb', '-s', '150', '-p', '42'];

mkdirSync(voDir, { recursive: true });

const { lines } = JSON.parse(readFileSync(linesPath, 'utf8'));

// Duration of a mono 16-bit PCM WAV from its size: bytes / (rate*channels*2).
const wavSeconds = (path, rate = 22050) => (statSync(path).size - 44) / (rate * 2);

const scenes = lines.map(({ id, speak }) => {
  const mp3 = join(voDir, `${id}.mp3`);
  let file;
  let seconds;

  if (existsSync(mp3)) {
    // A premium voice was dropped in; measure it with the bundled ffprobe.
    const out = execFileSync('npx', ['remotion', 'ffprobe', mp3], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const m = out.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (!m) throw new Error(`could not read duration of ${mp3}`);
    seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    file = `vo/${id}.mp3`;
  } else {
    const wav = join(voDir, `${id}.wav`);
    execFileSync('espeak-ng', [...ESPEAK_ARGS, '-w', wav, speak], { stdio: 'inherit' });
    seconds = wavSeconds(wav);
    file = `vo/${id}.wav`;
  }

  const frames = Math.ceil(seconds * FPS);
  console.log(`  ${id.padEnd(10)} ${seconds.toFixed(2)}s  (${frames}f)  ${file}`);
  return { id, file, seconds: Number(seconds.toFixed(3)), frames };
});

const manifest = {
  fps: FPS,
  generatedWith: existsSync(join(voDir, `${lines[0].id}.mp3`)) ? 'mixed/premium' : 'espeak-ng',
  scenes,
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nWrote ${manifestPath}`);
