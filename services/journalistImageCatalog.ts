/**
 * Local, non-AI cover-image search for the redazione dashboard
 * (components/pages/JournalistDashboardPage.tsx).
 *
 * Proposes images purely from our OWN existing catalog — every real photo
 * already used by a published article (public/images/blog/*.webp) — scored
 * by simple keyword overlap against the draft's title + body. No AI call,
 * no external service: the only network request is a one-time fetch of the
 * static manifest built by scripts/generate-journalist-image-catalog.mjs.
 * Mirrors scripts/create-article.mjs's findBestFallbackImage() strategy,
 * exposed here as a ranked multi-candidate list instead of a single pick.
 */
import { cdnDataUrl } from '@/services/cdnDataBase';

export interface CatalogImageCandidate {
  path: string;
  score: number;
}

interface CatalogEntry {
  path: string;
  words: string[];
}

let _catalog: CatalogEntry[] | null = null;

async function loadCatalog(): Promise<CatalogEntry[]> {
  if (_catalog) return _catalog;
  const res = await fetch(cdnDataUrl('/data/journalist-image-catalog.json'));
  if (!res.ok) throw new Error(`catalog-fetch-failed:${res.status}`);
  const data = (await res.json()) as unknown;
  _catalog = Array.isArray(data) ? (data as CatalogEntry[]) : [];
  return _catalog;
}

/** Same 4+ char word tokenization as generate-journalist-image-catalog.mjs's wordsFromFilename(). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zà-ÿ0-9]+/)
    .filter((w) => w.length >= 4);
}

/** Ranks the local image catalog by word overlap with `title` + `body`; highest score first. */
export async function searchImageCatalog(title: string, body: string, count = 8): Promise<CatalogImageCandidate[]> {
  const catalog = await loadCatalog();
  const queryWords = new Set(tokenize(`${title} ${body}`));
  if (queryWords.size === 0) return [];
  const scored: CatalogImageCandidate[] = [];
  for (const entry of catalog) {
    let score = 0;
    for (const word of entry.words) {
      if (queryWords.has(word)) score++;
    }
    if (score > 0) scored.push({ path: entry.path, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count);
}

/** Full catalog (all ~3k entries), alphabetical by path — for manual browsing when keyword suggestions miss. */
export async function listAllCatalogImages(): Promise<CatalogImageCandidate[]> {
  const catalog = await loadCatalog();
  return catalog.map((entry) => ({ path: entry.path, score: 0 })).sort((a, b) => a.path.localeCompare(b.path));
}
