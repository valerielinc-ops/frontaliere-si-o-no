#!/usr/bin/env node

/**
 * Regenerate the public editorial-profile avatars and place views through the
 * shared generated-image engine. The engine owns provider order, safety
 * vision, WebP normalization and XMP/IPTC marking; this script only supplies
 * the fixed public asset catalogue and writes its registry incrementally.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateImageFromSpec } from '../packages/articles/engine/shared/generatedImageEngine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(ROOT, 'data', 'generated-image-registry.json');
const PUBLIC_PATH = path.join(ROOT, 'public');

// Samuele Valente is a real guest author: his original portrait is covered by
// the private-grant registry record and must never enter the image generator.
const GENERATED_AUTHORS = [
  ['marco-ferrari', 'fiscalità frontaliera e accordo Italia-Svizzera'],
  ['laura-bianchi', 'previdenza svizzera e assicurazioni sociali per frontalieri'],
  ['redazione', 'attualità ticinese, lavoro e mobilità transfrontaliera'],
];

const PLACES = [
  ['ascona', 'Ascona e il lungolago del Lago Maggiore'],
  ['bellinzona', 'Bellinzona e il paesaggio urbano ai piedi delle Alpi'],
  ['castelgrande', 'Castelgrande a Bellinzona e le sue mura storiche'],
  ['film-festival', 'una rassegna cinematografica sul lungolago di Locarno'],
  ['foroglio', 'la cascata di Foroglio nella Val Bavona'],
  ['foxtown', 'il distretto dello shopping di Mendrisio in forma generica'],
  ['gandria', 'Gandria e il sentiero sul Lago di Lugano'],
  ['lac-lugano', 'il centro culturale LAC sul lungolago di Lugano'],
  ['lago-lugano', 'il Lago di Lugano tra rive e montagne'],
  ['locarno', 'Locarno e il suo lungolago'],
  ['lugano-view', 'una veduta panoramica generica di Lugano'],
  ['mendrisio', 'Mendrisio e il paesaggio collinare del Mendrisiotto'],
  ['monte-bre', 'Monte Brè sopra Lugano'],
  ['monte-generoso', 'Monte Generoso e il crinale panoramico'],
  ['monte-san-salvatore', 'Monte San Salvatore sopra il Lago di Lugano'],
  ['swissminiatur', 'un parco svizzero di miniature in forma generica'],
];

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function readRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return { schema: 1, assets: [] };
  const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  return { ...parsed, assets: Array.isArray(parsed.assets) ? parsed.assets : [] };
}

function descriptors(scope) {
  const authorAssets = GENERATED_AUTHORS.map(([slug, subject]) => ({
    assetId: slug,
    scope: 'editorial-profile',
    subject: `emblema-avatar illustrato astratto per il profilo editoriale ${slug}: ${subject}; composizione geometrica non umana, nessun volto, occhi, naso, bocca, corpo o silhouette, nessuna somiglianza con persone reali`,
    area: 'redazione di frontaliereticino.ch',
    season: 'all seasons',
    variant: 'illustrated-avatar',
    format: { width: 400, height: 400, format: 'webp', maxBytes: 220 * 1024 },
    imageUrl: `/images/authors/${slug}.webp`,
    targetPath: path.join(PUBLIC_PATH, 'images', 'authors', `${slug}.webp`),
  }));
  const placeAssets = PLACES.flatMap(([slug, subject]) => [
    {
      assetId: slug,
      scope: 'place',
      subject: `veduta editoriale generica di ${subject}, senza persone riconoscibili, loghi o testo`,
      area: 'Canton Ticino e regione di confine',
      season: 'luce diurna equilibrata',
      variant: 'place-hero',
      format: { width: 1200, height: 675, format: 'webp', maxBytes: 220 * 1024 },
      imageUrl: `/images/places/${slug}.webp`,
      targetPath: path.join(PUBLIC_PATH, 'images', 'places', `${slug}.webp`),
    },
    {
      assetId: `${slug}-480w`,
      scope: 'place',
      subject: `thumbnail editoriale generica di ${subject}, senza persone riconoscibili, loghi o testo`,
      area: 'Canton Ticino e regione di confine',
      season: 'luce diurna equilibrata',
      variant: 'place-thumbnail',
      format: { width: 480, height: 270, format: 'webp', maxBytes: 220 * 1024 },
      imageUrl: `/images/places/thumbnails/${slug}-480w.webp`,
      targetPath: path.join(PUBLIC_PATH, 'images', 'places', 'thumbnails', `${slug}-480w.webp`),
    },
  ]);
  if (scope === 'authors') return authorAssets;
  if (scope === 'places') return placeAssets;
  return [...authorAssets, ...placeAssets];
}

function persist(assetsByUrl) {
  const assets = [...assetsByUrl.values()].sort((a, b) => a.imageUrl.localeCompare(b.imageUrl));
  const registry = {
    schema: 1,
    registry: 'editorial-profile-and-place-images',
    assetCount: assets.length,
    generatedAt: new Date().toISOString(),
    assets,
  };
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  return registry;
}

async function main() {
  const scope = argument('--only', 'all');
  if (!['all', 'authors', 'places'].includes(scope)) throw new Error(`Unsupported --only value: ${scope}`);
  const outputDir = path.resolve(ROOT, argument('--output-dir', '.cache/editorial-profile-place-images'));
  const registry = readRegistry();
  const assetsByUrl = new Map(registry.assets.map((record) => [record.imageUrl, record]));
  const items = descriptors(scope);
  const providerCounts = { 'openai-codex': 0, gemini: 0 };

  for (const item of items) {
    const result = await generateImageFromSpec({
      scope: item.scope,
      subject: item.subject,
      area: item.area,
      season: item.season,
      variant: item.variant,
      assetId: item.assetId,
      format: item.format,
    }, {
      outputDir,
      assetId: item.assetId,
      publishedImageUrl: item.imageUrl,
      onProviderAttempt: ({ provider }) => {
        providerCounts[provider] += 1;
        console.error(`[generated-image] ${item.assetId}: ${provider}`);
      },
    });
    fs.mkdirSync(path.dirname(item.targetPath), { recursive: true });
    fs.copyFileSync(result.filePath, item.targetPath);
    assetsByUrl.set(item.imageUrl, result.record);
    persist(assetsByUrl);
    console.error(`[generated-image] published ${item.imageUrl} (${result.record.width}x${result.record.height}, ${result.record.bytes} bytes)`);
  }

  const finalRegistry = persist(assetsByUrl);
  console.error(`[generated-image] registry records: ${finalRegistry.assetCount}; codex=${providerCounts['openai-codex']}; gemini=${providerCounts.gemini}`);
}

main().catch((error) => {
  console.error(`[generated-image] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
