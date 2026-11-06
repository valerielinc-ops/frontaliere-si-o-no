#!/usr/bin/env node
/**
 * build-canton-notice-sources.mjs — rigenera `data/canton-notice-sources.json`
 * dal profilo editoriale del corpus, conservando la curatela.
 *
 * Il profilo (`generator/data/canton-sections.json`) vive nel repo
 * `frontaliere-articles` e non si importa (il confine fra i repo e' HTTP):
 * questo script lo legge da un file locale passato a mano, una tantum, quando
 * il profilo cambia. Il registro risultante e' l'unica cosa che il workflow
 * `crawl-canton-notices.yml` legge.
 *
 * Curatela conservata per canton+URL: `linkPattern` / `linkHosts` /
 * `dropParams` delle fonti `html-links` e le esclusioni motivate
 * (`excluded[].curated: true`). Una fonte `html-links` nuova senza pattern
 * finisce in `excluded` con il motivo: si attiva solo dopo aver verificato la
 * pagina vera.
 *
 * Uso:
 *   node scripts/build-canton-notice-sources.mjs --profile ../frontaliere-articles/generator/data/canton-sections.json
 *   node scripts/build-canton-notice-sources.mjs --profile <file> --check   # diff, non scrive
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { buildRegistry, validateRegistry } from './lib/canton-notices-dataset.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = process.env.CANTON_NOTICE_SOURCES_OUT || path.join(ROOT, 'data', 'canton-notice-sources.json');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  ?? (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);

const profilePath = arg('profile');
if (!profilePath) {
  console.error('uso: node scripts/build-canton-notice-sources.mjs --profile <canton-sections.json> [--previous <registro>] [--check]');
  process.exit(2);
}
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const previousPath = arg('previous') ?? OUT_PATH;
const previous = fs.existsSync(previousPath) ? JSON.parse(fs.readFileSync(previousPath, 'utf8')) : null;

const registry = buildRegistry(profile, {
  previous,
  profileRef: { schemaVersion: profile.schemaVersion, verifiedAt: profile.verifiedAt },
  today: arg('today') ?? new Date().toISOString().slice(0, 10),
});
const errors = validateRegistry(registry);
if (errors.length) {
  for (const e of errors) console.error(`::error::[build-canton-notice-sources] ${e}`);
  process.exit(1);
}
const byParser = {};
for (const s of registry.sources) byParser[s.parser] = (byParser[s.parser] ?? 0) + 1;
console.log(
  `[build-canton-notice-sources] ${registry.sources.length} fonti attive ${JSON.stringify(byParser)}, ` +
    `${registry.excluded.length} escluse, ${new Set(registry.sources.map((s) => s.canton)).size} cantoni`,
);
if (process.argv.includes('--check')) process.exit(0);
writeJsonAtomic(OUT_PATH, registry);
console.log(`[build-canton-notice-sources] scritto ${path.relative(ROOT, OUT_PATH)}`);
