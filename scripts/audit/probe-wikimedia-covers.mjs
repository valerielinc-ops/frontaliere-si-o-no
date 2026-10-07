#!/usr/bin/env node
/**
 * Source-proof pass for historical covers.  It replays the public Wikimedia
 * search vocabulary used by create-article.mjs, caches every API response and
 * candidate thumbnail, and accepts a match only when the candidate's dHash is
 * within the same strict threshold used by the local duplicate audit.
 *
 * This script never writes public/images/blog.  Its output is an evidence
 * cache consumed by blog-cover-ledger.mjs on the next pass.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = process.cwd();
const CACHE_ROOT = path.join(ROOT, '.cache/blog-cover-ledger/wikimedia');
const API_CACHE = path.join(CACHE_ROOT, 'api');
const IMAGE_CACHE = path.join(CACHE_ROOT, 'images');
const DEFAULT_OUTPUT = 'data/blog-cover-wikimedia-matches.json';
const USER_AGENT = 'FrontaliereTicino-ImageCredits/1.0 (https://frontaliereticino.ch/; cover audit)';
const ALLOWED_DISTANCE = 4;
const API_FIELDS = 'Artist|Attribution|LicenseShortName|LicenseUrl|License|AttributionRequired|Restrictions|NonFree';

const TOPIC_SEARCH_MAP = [
  { keywords: ['benzina', 'carburante', 'petrolio', 'diesel', 'rifornimento'], queries: ['fuel station Switzerland', 'gas pump Europe'] },
  { keywords: ['tasse', 'fiscale', 'imposta', 'irpef', 'fisco', 'deduzioni'], queries: ['tax office building', 'financial documents desk'] },
  { keywords: ['salute', 'malattia', 'lamal', 'assicurazione', 'premio'], queries: ['hospital Switzerland modern', 'health insurance card'] },
  { keywords: ['lavoro', 'impiego', 'occupazione', 'assunzione', 'disoccup'], queries: ['modern office workplace', 'job interview meeting'] },
  { keywords: ['confine', 'dogana', 'frontiera', 'frontalier', 'permesso'], queries: ['Swiss Italian border crossing', 'customs checkpoint Europe'] },
  { keywords: ['treno', 'ferrovia', 'trasporto', 'pendolar', 'tilo'], queries: ['train station Switzerland', 'commuter train Alps'] },
  { keywords: ['casa', 'affitto', 'immobiliare', 'appartamento', 'mutuo'], queries: ['apartment building Switzerland', 'residential area Ticino'] },
  { keywords: ['banca', 'finanziario', 'cambio', 'valuta', 'franco', 'euro'], queries: ['Swiss bank building', 'currency exchange counter'] },
  { keywords: ['scuola', 'formazione', 'educazione', 'universit', 'corso'], queries: ['university campus Switzerland', 'classroom education'] },
  { keywords: ['pensione', 'avs', 'pilastro', 'previdenza', 'anzian'], queries: ['retirement couple walking', 'pension fund documents'] },
  { keywords: ['salario', 'stipendio', 'busta paga', 'reddito', 'retribuzion'], queries: ['salary paycheck document', 'business accounting office'] },
  { keywords: ['dumping', 'sindacat', 'contratto', 'ccl'], queries: ['labor union protest Switzerland', 'workers rights demonstration'] },
  { keywords: ['voto', 'elezioni', 'referendum', 'iniziativa', 'parlament'], queries: ['Swiss parliament Bern', 'voting ballot Switzerland'] },
  { keywords: ['clima', 'meteo', 'alluvione', 'tempesta', 'neve'], queries: ['weather Alps Switzerland', 'storm clouds mountains'] },
  { keywords: ['polizia', 'sicurezza', 'reato', 'accident'], queries: ['police patrol Switzerland', 'road safety checkpoint'] },
  { keywords: ['ospedale', 'medico', 'farmacia', 'sanitar'], queries: ['medical center Switzerland', 'doctor consultation'] },
  { keywords: ['costruzione', 'cantiere', 'ediliz', 'ristrutturazione'], queries: ['construction site Switzerland', 'building renovation'] },
  { keywords: ['supermercato', 'spesa', 'prezzi', 'costo vita'], queries: ['supermarket grocery store', 'shopping food prices'] },
  { keywords: ['auto', 'macchina', 'traffico', 'stradale', 'autostrada'], queries: ['highway traffic Switzerland', 'car road Alps'] },
  { keywords: ['economia', 'pil', 'crescita', 'mercato', 'commercial'], queries: ['business district Zurich', 'economic growth chart'] },
  { keywords: ['bambini', 'famiglia', 'asilo', 'nido', 'genitor'], queries: ['family park Switzerland', 'kindergarten playground'] },
  { keywords: ['golfo', 'guerra', 'conflitto', 'geopolitica', 'medio oriente'], queries: ['oil tanker shipping port', 'cargo ship Mediterranean'] },
  { keywords: ['tecnologia', 'digitale', 'intelligenza artificiale', 'innovation'], queries: ['technology office workspace', 'digital innovation center'] },
];
const GENERIC_QUERIES = [
  'Swiss Alps panorama mountain', 'Lake Lugano sunset boating', 'Ticino village stone street',
  'Bellinzona castle medieval', 'Mendrisio vineyard autumn', 'Locarno piazza grande',
  'Swiss Italian architecture colorful', 'Gotthard pass scenic road', 'Como lake panorama',
  'Swiss railway bridge Ticino', 'Ascona lakefront promenade', 'Lugano Monte Bre funicular',
];

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function clean(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function parseTitles(file) {
  const source = fs.readFileSync(file, 'utf8');
  const titles = new Map();
  const rx = /'blog\.article\.([^']+)\.title':\s*'((?:\\.|[^'])*)'/g;
  let match;
  while ((match = rx.exec(source))) {
    const value = match[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, ' ');
    titles.set(match[1], value);
  }
  return titles;
}
function parseRegistry(file, section) {
  const source = fs.readFileSync(file, 'utf8');
  const articles = [];
  const starts = [...source.matchAll(/^\s*\{\s*$/gm)].map((match) => match.index);
  for (const start of starts) {
    const endRx = /^\s*\},\s*$/gm;
    endRx.lastIndex = start;
    const end = endRx.exec(source)?.index;
    if (end === undefined) continue;
    const block = source.slice(start, end);
    const id = block.match(/\bid:\s*'([^']+)'/)?.[1];
    const image = block.match(/\bimage:\s*'([^']+)'/)?.[1];
    if (id && image) articles.push({ section, id, image });
  }
  return articles;
}
function coverKey(image) {
  return String(image || '').match(/\/images\/blog\/([^/]+)\.[^.]+$/)?.[1] || null;
}
function queryVocabulary(title, id) {
  const lower = `${title || ''} ${id || ''}`.toLowerCase();
  const queries = [];
  for (const entry of TOPIC_SEARCH_MAP) {
    if (entry.keywords.some((keyword) => lower.includes(keyword))) {
      queries.push(...entry.queries);
      if (queries.length >= 3) break;
    }
  }
  for (const city of ['lugano', 'bellinzona', 'locarno', 'mendrisio', 'chiasso', 'ascona']) {
    if (lower.includes(city)) queries.push(`${city} Switzerland photo`);
  }
  queries.push(...GENERIC_QUERIES);
  return [...new Set(queries)];
}
function heroBytes(file) {
  return execFileSync('git', ['cat-file', 'blob', `HEAD:public/images/blog/${file}`], { cwd: ROOT, maxBuffer: 2 * 1024 * 1024 });
}
async function dHash(buffer) {
  const { data } = await sharp(buffer, { failOn: 'none' })
    .resize({ width: 9, height: 8, fit: 'fill' }).greyscale().raw()
    .toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) {
    bits += data[row * 9 + column] < data[row * 9 + column + 1] ? '1' : '0';
  }
  return BigInt(`0b${bits}`);
}
function distance(left, right) {
  let value = left ^ right;
  let count = 0;
  while (value) { value &= value - 1n; count += 1; }
  return count;
}
function licenceMeta(info) {
  const meta = info?.extmetadata || {};
  const value = (name) => meta[name]?.value ?? meta[name] ?? '';
  const short = clean(value('LicenseShortName')).toLowerCase();
  const code = clean(value('License')).toLowerCase();
  if (short.includes('cc by-sa') || short.includes('cc-by-sa') || code.startsWith('cc-by-sa')) {
    return { family: 'cc-by-sa', name: clean(value('LicenseShortName')) || 'CC BY-SA', url: clean(value('LicenseUrl')) || 'https://creativecommons.org/licenses/by-sa/4.0/', attributionRequired: true };
  }
  if ((short.includes('cc by') && !short.includes('nc') && !short.includes('nd')) || /^cc-by(?!-sa)/.test(code)) {
    return { family: 'cc-by', name: clean(value('LicenseShortName')) || 'CC BY', url: clean(value('LicenseUrl')) || 'https://creativecommons.org/licenses/by/4.0/', attributionRequired: true };
  }
  if (short.includes('cc0') || code === 'cc0') return { family: 'cc0', name: 'CC0', url: clean(value('LicenseUrl')) || 'https://creativecommons.org/publicdomain/zero/1.0/', attributionRequired: false };
  if (short.includes('public domain') || short === 'pd' || code.startsWith('pd')) return { family: 'pd', name: 'Public domain', url: clean(value('LicenseUrl')) || null, attributionRequired: false };
  return null;
}
function candidateRecord(page, info, query, fetchedAt) {
  const licence = licenceMeta(info);
  if (!licence) return null;
  const meta = info.extmetadata || {};
  const artist = clean(meta.Artist?.value ?? meta.Artist ?? '');
  const attribution = clean(meta.Attribution?.value ?? meta.Attribution ?? '');
  const authorName = attribution && !/unknown|anonymous|sconosciut|unbekannt/i.test(attribution) ? attribution : artist;
  if (licence.attributionRequired && (!authorName || /unknown|anonymous|sconosciut|unbekannt/i.test(authorName))) return null;
  const title = String(page.title || '').replace(/^File:/, '');
  const pageUrl = info.descriptionurl || `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const authorHref = artist.match(/https:\/\/[^\s)]+/)?.[0] || null;
  const originalRatio = Number(info.width || 0) / Number(info.height || 1);
  const modified = Math.abs(originalRatio - 1200 / 675) / originalRatio > 0.02 ? 'cropped' : 'resized';
  return {
    schema: 1,
    cover: null,
    source: 'wikimedia-commons',
    commons: { title, pageUrl, ...(page.pageid ? { pageId: page.pageid } : {}), ...(info.width ? { width: info.width } : {}), ...(info.height ? { height: info.height } : {}), ...(info.timestamp ? { revision: info.timestamp } : {}) },
    author: { text: artist || null, name: authorName || null, url: authorHref, type: 'Person' },
    attribution: attribution || null,
    licence,
    restrictions: [],
    modified,
    fetchedAt,
    status: 'ok',
    curation: null,
    _query: query,
  };
}

async function getJson(url, cacheFile) {
  const cached = readJson(cacheFile);
  if (cached) return cached;
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Wikimedia API HTTP ${response.status}`);
  const json = await response.json();
  writeJson(cacheFile, json);
  return json;
}
async function getBytes(url, cacheFile) {
  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile);
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Wikimedia image HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, bytes);
  return bytes;
}

async function main() {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? (process.argv[outputIndex + 1] || DEFAULT_OUTPUT) : DEFAULT_OUTPUT;
  const inventory = readJson(path.join(ROOT, 'data/blog-cover-ledger.json'));
  if (!inventory) throw new Error('Run blog-cover-ledger.mjs first');
  const titles = new Map([
    ...parseTitles(path.join(ROOT, 'packages/articles/content/blog-meta-it.ts')),
    ...parseTitles(path.join(ROOT, 'packages/articles/content/blog-meta-ch-it.ts')),
  ]);
  const articles = [
    ...parseRegistry(path.join(ROOT, 'packages/articles/content/blog-articles-data.ts'), 'frontaliere'),
    ...parseRegistry(path.join(ROOT, 'packages/articles/content/swiss-articles-data.ts'), 'svizzera'),
  ];
  const keysByQuery = new Map();
  for (const article of articles) {
    const key = coverKey(article.image);
    const item = key && inventory.covers[key];
    if (!key || !item || !item.published || item.proofLevel <= 2 || item.proofLevel === 5) continue;
    for (const query of queryVocabulary(titles.get(article.id) || '', article.id)) {
      const keys = keysByQuery.get(query) || new Set();
      keys.add(key);
      keysByQuery.set(query, keys);
    }
  }
  const targetHashes = new Map();
  const matches = readJson(path.join(ROOT, output), {}) || {};
  fs.mkdirSync(API_CACHE, { recursive: true });
  fs.mkdirSync(IMAGE_CACHE, { recursive: true });
  const queries = [...keysByQuery.keys()].sort();
  console.error(`[wikimedia-cover-probe] ${queries.length} query, ${[...new Set([...keysByQuery.values()].flatMap((set) => [...set]))].length} copertine candidate`);
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    const cacheFile = path.join(API_CACHE, `${sha256(query)}.json`);
    const url = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search'
      + `&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=12`
      + `&prop=imageinfo&iiprop=url|size|mime|timestamp|extmetadata`
      + `&iiextmetadatalanguage=en&iiextmetadatafilter=${API_FIELDS}&iiurlwidth=1280&format=json`;
    let body;
    try { body = await getJson(url, cacheFile); } catch (error) {
      console.error(`[wikimedia-cover-probe] ${index + 1}/${queries.length} ${query}: ${error.message}`);
      continue;
    }
    const candidates = Object.values(body.query?.pages || {}).map((page) => {
      const info = page.imageinfo?.[0];
      if (!info?.thumburl || !/^image\/(?:jpe?g|png|webp)$/i.test(info.mime || '')) return null;
      const record = candidateRecord(page, info, query, new Date().toISOString().slice(0, 10));
      return record ? { page, info, record } : null;
    }).filter(Boolean);
    const targetKeys = [...(keysByQuery.get(query) || [])];
    for (const candidate of candidates) {
      const imageCache = path.join(IMAGE_CACHE, `${sha256(candidate.info.thumburl)}.bin`);
      let candidateHash;
      try { candidateHash = await dHash(await getBytes(candidate.info.thumburl, imageCache)); } catch { continue; }
      for (const key of targetKeys) {
        if (matches[key]?.distance !== undefined && matches[key].distance <= ALLOWED_DISTANCE) continue;
        if (!targetHashes.has(key)) {
          const heroFile = `${key}.webp`;
          try { targetHashes.set(key, await dHash(heroBytes(heroFile))); } catch { continue; }
        }
        const distanceValue = distance(targetHashes.get(key), candidateHash);
        if (distanceValue > ALLOWED_DISTANCE) continue;
        const current = matches[key];
        if (!current || distanceValue < current.distance) {
          matches[key] = { ...candidate.record, cover: `/images/blog/${key}.webp`, evidence: 'wikimedia-search-dhash', distance: distanceValue };
          console.error(`[wikimedia-cover-probe] match ${key} <- ${candidate.record.commons.title} (dHash ${distanceValue}, ${query})`);
        }
      }
    }
    writeJson(path.join(ROOT, output), matches);
    if (index + 1 < queries.length) await sleep(120);
  }
  console.log(JSON.stringify({ queries: queries.length, matches: Object.keys(matches).length, output }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
