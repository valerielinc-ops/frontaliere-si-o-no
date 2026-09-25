#!/usr/bin/env node
import { readdirSync, statSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIR = `${ROOT}/public/images/blog`;
const TARGET = 220 * 1024;
const HARD = 320 * 1024;

function cmdExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function run(cmd) {
  try {
    execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const tools = {
  magick: cmdExists('magick'),
  convert: cmdExists('convert'),
  sips: cmdExists('sips'),
  cwebp: cmdExists('cwebp'),
};

if (!tools.magick && !tools.convert && !tools.sips) {
  console.error('Nessun tool di ottimizzazione disponibile (magick/convert/sips).');
  process.exit(1);
}

const files = readdirSync(DIR).filter((f) => /\.(jpe?g|png)$/i.test(f));
let optimized = 0;
let totalSaved = 0;

for (const file of files) {
  const p = `${DIR}/${file}`;
  const before = statSync(p).size;
  if (before <= HARD) continue;

  const cmds = [
    tools.magick && `magick "${p}" -auto-orient -strip -interlace Plane -sampling-factor 4:2:0 -resize "1200x1200>" -quality 72 "${p}"`,
    tools.convert && `convert "${p}" -auto-orient -strip -interlace Plane -sampling-factor 4:2:0 -resize "1200x1200>" -quality 72 "${p}"`,
    tools.sips && `sips -s format jpeg --resampleWidth 1200 -s formatOptions 72 "${p}" --out "${p}"`,
  ].filter(Boolean);

  let ok = false;
  for (const c of cmds) {
    if (run(c)) {
      ok = true;
      break;
    }
  }
  if (!ok) continue;

  for (const q of [68, 62, 56, 50]) {
    const s = statSync(p).size;
    if (s <= TARGET) break;
    const rec = [
      tools.magick && `magick "${p}" -strip -interlace Plane -sampling-factor 4:2:0 -quality ${q} "${p}"`,
      tools.convert && `convert "${p}" -strip -interlace Plane -sampling-factor 4:2:0 -quality ${q} "${p}"`,
      tools.sips && `sips -s format jpeg -s formatOptions ${q} "${p}" --out "${p}"`,
    ].filter(Boolean);
    for (const c of rec) if (run(c)) break;
  }

  const after = statSync(p).size;
  if (after < before) {
    optimized++;
    totalSaved += before - after;
    console.error(`${file}: ${(before / 1024).toFixed(0)}KB -> ${(after / 1024).toFixed(0)}KB`);
  }

  if (tools.cwebp && /\.jpe?g$/i.test(file)) {
    const webp = p.replace(/\.(jpe?g)$/i, '.webp');
    run(`cwebp -quiet -q 72 "${p}" -o "${webp}"`);
    if (!existsSync(webp)) continue;
  }
}

console.error(`Ottimizzate: ${optimized} immagini`);
console.error(`Spazio recuperato: ${(totalSaved / 1024 / 1024).toFixed(2)} MB`);
