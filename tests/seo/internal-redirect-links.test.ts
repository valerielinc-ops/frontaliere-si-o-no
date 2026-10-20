import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const linkSources = [
  'index.html',
  'build-plugins/editorialContent.ts',
  'build-plugins/faqHubPlugin.ts',
  'build-plugins/staticPagesPlugin.ts',
];

const redirectPaths = new Set([
  '/calcola-stipendio/confronta-permesso-g-vs-b/',
  '/guida-frontaliere/comuni-di-frontiera/',
  '/vivere-in-ticino/vivere-in-svizzera/',
  '/statistiche/traffico-dogane/',
  '/guida-frontaliere/tempi-attesa-dogana/',
  '/guida-frontaliere/diritto-lavoro-frontalieri/',
  '/tfr-calculator/',
  '/calcolatore/',
  '/guida-frontaliere/diritto-opzione-lamal/',
  '/statistiche/confronta-premi/',
  '/job-board/',
  '/stipendi-frontalieri-ticino/',
  '/tredicesima-svizzera/',
  '/comparatori/cambio-valuta/',
  '/costo-della-vita/',
  '/guida-frontaliere/nuova-legge-frontalieri-2024/',
  '/fisco-frontalieri/',
]);

function literalHrefs(source: string): string[] {
  const patterns = [
    /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g,
    /\bhref\s*:\s*['"]([^'"]+)['"]/g,
  ];
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]),
  );
}

describe('internal links to legacy redirects', () => {
  it('links to canonical destinations from shared homepage and content emitters', () => {
    for (const relativePath of linkSources) {
      const source = readFileSync(path.join(root, relativePath), 'utf8');
      for (const href of literalHrefs(source)) {
        let target: URL;
        try {
          target = new URL(href, 'https://frontaliereticino.ch');
        } catch {
          continue;
        }
        if (target.hostname.replace(/^www\./, '') !== 'frontaliereticino.ch') continue;
        const canonicalPath = target.pathname.endsWith('/') ? target.pathname : `${target.pathname}/`;
        expect(redirectPaths.has(canonicalPath), `${relativePath} links to ${canonicalPath}`).toBe(false);
      }
    }
  });
});
