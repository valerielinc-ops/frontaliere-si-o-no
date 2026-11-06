import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const COMPANY_LOGO_SOURCE = path.join(
  'services',
  'jobDataNormalization.ts',
);

/**
 * Parse the source registry used by the TypeScript resolver.
 *
 * The registry is intentionally kept in the resolver source because it is
 * also consumed by the browser build. Acquisition scripts must therefore
 * read the same declarations instead of maintaining a second list of logo
 * URLs that can drift from runtime behavior.
 */
export function parseLogoRegistry(source) {
  const match = String(source || '').match(
    /CRAWLED_COMPANY_LOGOS:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\n\};/,
  );
  if (!match) throw new Error('Cannot find CRAWLED_COMPANY_LOGOS in jobDataNormalization.ts');

  const entries = [];
  const lineRe = /['"]([a-z0-9-]+)['"]\s*:\s*([^,\n]+),?/g;
  let line;
  while ((line = lineRe.exec(match[1]))) {
    const slug = line[1];
    const raw = line[2].trim().replace(/,$/, '').trim();
    let url = null;
    let domain = null;
    let kind = 'unknown';

    const clearbit = raw.match(/^cLogo\(['"]([^'"]+)['"]\)$/);
    const googleFavicon = raw.match(/^gFavicon\(['"]([^'"]+)['"]\)$/);
    const local = raw.match(/^['"](\/[^'"]+)['"]$/);
    const direct = raw.match(/^['"](https?:\/\/[^'"]+)['"]$/);

    if (clearbit) {
      domain = clearbit[1];
      url = `https://logo.clearbit.com/${domain}`;
      kind = 'clearbit';
    } else if (googleFavicon) {
      domain = googleFavicon[1];
      url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
      kind = 'google-favicon';
    } else if (local) {
      entries.push({ slug, kind: 'local-existing', localExisting: local[1] });
      continue;
    } else if (direct) {
      url = direct[1];
      try {
        domain = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        domain = null;
      }
      kind = 'direct-url';
    } else {
      continue;
    }

    entries.push({ slug, kind, url, domain });
  }
  return entries;
}

export async function loadLogoRegistry(root = process.cwd()) {
  const sourcePath = path.resolve(root, COMPANY_LOGO_SOURCE);
  return parseLogoRegistry(await readFile(sourcePath, 'utf8'));
}

export function directLogoSources(entries = []) {
  return entries.filter((entry) => entry?.kind === 'direct-url' && entry.url);
}
