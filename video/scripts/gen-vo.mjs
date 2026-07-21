// Generates the voiceover track for HostedVideo.
//
// For each line in src/vo/lines.json it writes an audio clip to public/vo/ and
// records the duration in src/vo/manifest.json. The composition reads that
// manifest to size each scene, so pacing always matches the narration.
//
// Voice source, in priority order per scene:
//   1. ElevenLabs  — if ELEVENLABS_API_KEY is set. Writes vo/<id>.mp3.
//   2. Existing     public/vo/<id>.mp3 — a premium clip dropped in by hand.
//   3. espeak-ng    — offline synthetic fallback. Writes vo/<id>.wav.
//
// Run with:  npm run vo
//
// ElevenLabs env vars:
//   ELEVENLABS_API_KEY   (required to use ElevenLabs)
//   ELEVENLABS_VOICE_ID  (default: George, a warm British male preset)
//   ELEVENLABS_MODEL     (default: eleven_multilingual_v2)
//   ELEVENLABS_FORMAT    (default: mp3_44100_128)
// If you are behind an HTTPS proxy, run with NODE_USE_ENV_PROXY=1 (Node >= 22.21)
// and make sure api.elevenlabs.io is allowed by your egress policy.

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
const ESPEAK_ARGS = ['-v', 'en-gb', '-s', '150', '-p', '42'];

const EL = {
  key: process.env.ELEVENLABS_API_KEY,
  voiceId: process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb', // "George" (British)
  model: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
  format: process.env.ELEVENLABS_FORMAT || 'mp3_44100_128',
};

mkdirSync(voDir, { recursive: true });
const { lines } = JSON.parse(readFileSync(linesPath, 'utf8'));

// Duration of a mono 16-bit PCM WAV from its size: bytes / (rate*channels*2).
const wavSeconds = (path, rate = 22050) => (statSync(path).size - 44) / (rate * 2);

// Duration of any file via the bundled ffprobe (used for mp3).
const probeSeconds = (path) => {
  const out = execFileSync('npx', ['remotion', 'ffprobe', path], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) throw new Error(`could not read duration of ${path}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
};

const elevenLabs = async (text, outPath) => {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${EL.voiceId}?output_format=${EL.format}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': EL.key,
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: EL.model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
};

console.log(
  EL.key
    ? `Voice: ElevenLabs (voice ${EL.voiceId}, model ${EL.model})`
    : 'Voice: espeak-ng placeholder (set ELEVENLABS_API_KEY for a premium voice)',
);

const scenes = [];
for (const { id, speak } of lines) {
  const mp3 = join(voDir, `${id}.mp3`);
  let file;
  let seconds;

  if (EL.key) {
    await elevenLabs(speak, mp3);
    seconds = probeSeconds(mp3);
    file = `vo/${id}.mp3`;
  } else if (existsSync(mp3)) {
    seconds = probeSeconds(mp3);
    file = `vo/${id}.mp3`;
  } else {
    const wav = join(voDir, `${id}.wav`);
    execFileSync('espeak-ng', [...ESPEAK_ARGS, '-w', wav, speak], { stdio: 'inherit' });
    seconds = wavSeconds(wav);
    file = `vo/${id}.wav`;
  }

  const frames = Math.ceil(seconds * FPS);
  console.log(`  ${id.padEnd(10)} ${seconds.toFixed(2)}s  (${frames}f)  ${file}`);
  scenes.push({ id, file, seconds: Number(seconds.toFixed(3)), frames });
}

const manifest = {
  fps: FPS,
  generatedWith: EL.key ? `elevenlabs:${EL.voiceId}` : existsSync(join(voDir, `${lines[0].id}.mp3`)) ? 'premium-mp3' : 'espeak-ng',
  scenes,
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nWrote ${manifestPath}`);
