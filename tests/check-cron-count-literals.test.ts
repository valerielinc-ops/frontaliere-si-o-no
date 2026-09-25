// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildCronPathMatcher,
  scanRepository,
  scanTestSource,
} from '../scripts/ci/check-cron-count-literals.mjs';

/**
 * Issue #9743: un test che fissa un conteggio letterale su un file riscritto
 * da un cron diventa rosso sulla stessa revisione di codice appena il cron
 * gira, e ferma PR che parlano d'altro (#9724, Varese 266 -> 268).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const isCron = (p: string) => p === 'data/foo.json' || p.startsWith('data/jobs/');
const scan = (source: string, file = 'tests/sample.test.ts') => scanTestSource(source, file, isCron);

describe('scanTestSource — letture dirette', () => {
  it('segnala un conteggio letterale su un JSON del cron importato e sui suoi derivati', () => {
    const found = scan(`
      import rows from '../data/foo.json';
      const varese = rows.items.filter((r) => r.province === 'VA');
      expect(rows.items).toHaveLength(266);
      expect(varese.length).toBe(193);
      expect(rows.provinces.map((p) => p.duties.length)).toEqual([2, 3, 0]);
    `);
    expect(found.map((v) => v.value)).toEqual([266, 193, 3]);
    expect(found.every((v) => v.cronPaths.includes('data/foo.json'))).toBe(true);
  });

  it('segnala un path letterale ancorato alla root, non uno costruito in una cartella temporanea', () => {
    const anchored = scan(`
      import { readFileSync, mkdtempSync } from 'node:fs';
      import path from 'node:path';
      const ROOT = path.resolve(__dirname, '..');
      const live = JSON.parse(readFileSync(path.join(ROOT, 'data', 'jobs', 'by-crawler', 'acme.json'), 'utf8'));
      expect(live).toHaveLength(12);
    `);
    expect(anchored).toHaveLength(1);
    expect(anchored[0].cronPaths).toEqual(['data/jobs/by-crawler/acme.json']);

    const tmp = scan(`
      import { readFileSync, mkdtempSync } from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';
      const dir = mkdtempSync(path.join(os.tmpdir(), 'fixture-'));
      const written = JSON.parse(readFileSync(path.join(dir, 'data', 'jobs', 'by-crawler', 'acme.json'), 'utf8'));
      expect(written).toHaveLength(12);
    `);
    expect(tmp).toEqual([]);
  });

  it('non segnala invarianti, attese lette dal dataset o negazioni', () => {
    expect(scan(`
      import rows from '../data/foo.json';
      const varese = rows.items.filter((r) => r.province === 'VA');
      expect(rows.duplicates).toHaveLength(0);
      expect(rows.winner).toHaveLength(1);
      expect(varese).toHaveLength(rows.items.filter((r) => r.province === 'VA').length);
      expect(rows.items.length).toBeGreaterThan(200);
      expect(rows.items).not.toHaveLength(2);
      expect(rows.label).toBe(12);
    `)).toEqual([]);
  });

  it('accetta un contratto vero solo se il commento ne dichiara il motivo', () => {
    expect(scan(`
      import registry from '../data/foo.json';
      // cron-count-ok: un canale per ciascuno dei 26 cantoni, costante del codice.
      expect(registry.cantons).toHaveLength(26);
    `)).toEqual([]);
    expect(scan(`
      import registry from '../data/foo.json';
      // cron-count-ok:
      expect(registry.cantons).toHaveLength(26);
    `)).toHaveLength(1);
  });
});

function writeFile(root: string, rel: string, content: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Un repo in miniatura: un cron schedulato, un modulo di dati, un componente, dei test. */
function syntheticRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-count-literals-'));
  tempRoots.push(root);
  writeFile(root, '.github/workflows/sync-foo.yml', [
    'on:',
    '  schedule:',
    "    - cron: '0 3 * * *'",
    'jobs:',
    '  sync:',
    '    steps:',
    '      - run: git add data/foo.json && git commit -m sync',
    '',
  ].join('\n'));
  writeFile(root, 'data/foo.json', '{"items":[]}\n');
  writeFile(root, 'data/curated.json', '{"items":[]}\n');
  writeFile(root, 'services/data.ts', `
    import raw from '../data/foo.json';
    import curated from '../data/curated.json';
    export const ITEMS = raw.items;
    export const PROVINCES = [{ code: 'CO' }, { code: 'VA' }, { code: 'VB' }];
    export const CURATED = curated.items;
    export function itemsFor(code: string) { return ITEMS.filter((item) => item.province === code); }
    export function parseListing(html: string) { return html.split(','); }
  `);
  writeFile(root, 'services/index.ts', `export * from './data';\n`);
  writeFile(root, 'components/List.tsx', `
    import { ITEMS } from '../services/data';
    export default function List({ kind }: { kind: string }) {
      return <ul data-kind={kind}>{ITEMS.map((item) => <li key={item.id}>{item.id}</li>)}</ul>;
    }
    export function FixtureList({ items }: { items: string[] }) {
      return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;
    }
  `);
  return root;
}

describe('scanRepository — letture indirette attraverso i moduli del repo', () => {
  it('segue il VALORE esportato, non il modulo che lo ospita', () => {
    const root = syntheticRepo();
    writeFile(root, 'tests/indirect.test.tsx', `
      import { render } from '@testing-library/react';
      import List from '../components/List';
      import { ITEMS, PROVINCES, CURATED, itemsFor, parseListing } from '../services';
      const fixture = 'a,b';
      it.each(['CO', 'VA'])('%s', (code) => {
        expect(ITEMS).toHaveLength(266);
        expect(itemsFor('VA')).toHaveLength(193);
        expect(itemsFor(code)).toHaveLength(4);
        expect(PROVINCES).toHaveLength(3);
        expect(CURATED).toHaveLength(9);
        expect(parseListing(fixture)).toHaveLength(2);
        expect(parseListing('a,b')).toHaveLength(2);
        const { container } = render(<List kind={code} />);
        expect(container.querySelectorAll('li')).toHaveLength(5);
      });
    `);
    const { violations } = scanRepository(root);
    // ITEMS (valore del cron), itemsFor('VA') e itemsFor(code) (interrogazioni
    // del dataset), il DOM di un componente che lo rende. Non PROVINCES
    // (costante accanto al dato), non CURATED (file non riscritto da un cron),
    // non parseListing (funzione pura chiamata su una fixture).
    expect(violations.map((v) => v.value)).toEqual([266, 193, 4, 5]);
    expect(violations.every((v) => v.cronPaths.includes('data/foo.json'))).toBe(true);
  });

  it('non segnala un modulo sostituito da vi.mock ne\' un componente reso con una fixture', () => {
    const root = syntheticRepo();
    writeFile(root, 'tests/mocked.test.tsx', `
      import { render } from '@testing-library/react';
      import { vi } from 'vitest';
      import { FixtureList } from '../components/List';
      import { ITEMS } from '../services/data';
      vi.mock('../services/data', () => ({ ITEMS: [1, 2, 3] }));
      const items = ['a', 'b'];
      it('mocked', () => {
        expect(ITEMS).toHaveLength(3);
        const { container } = render(<FixtureList items={items} />);
        expect(container.querySelectorAll('li')).toHaveLength(2);
      });
    `);
    expect(scanRepository(root).violations).toEqual([]);
  });
});

describe('buildCronPathMatcher', () => {
  it('riconosce i file che i workflow schedulati committano e quelli misurati dai bot', () => {
    const isCronPath = buildCronPathMatcher(syntheticRepo());
    expect(isCronPath('data/foo.json')).toBe(true);
    expect(isCronPath('data/curated.json')).toBe(false);
    // Radice di directory di LIVE_DATA_ROOTS e glob di CRON_MANAGED_GLOBS.
    expect(isCronPath('data/jobs/by-crawler/acme.json')).toBe(true);
    // Coperto prima solo dalla radice di nome `data/border-wait`.
    expect(isCronPath('data/border-wait-averages.json')).toBe(true);
  });

  it('non prende le configurazioni curate a mano accanto al dato vivo', () => {
    // `data/pharmac` e' una radice di NOME del guard dei dati vivi: presa per
    // prefisso copriva il calendario di Ginevra e il registro dei 26 cantoni,
    // scritti solo da PR.
    const isCronPath = buildCronPathMatcher(syntheticRepo());
    expect(isCronPath('data/pharmacy-duties-geneva-sources.json')).toBe(false);
    expect(isCronPath('data/pharmacy-sources-registry.json')).toBe(false);
  });
});

describe('osservatore sul repo', () => {
  it('nessun test del repo fissa un conteggio letterale su un file riscritto da un cron', () => {
    const { scanned, violations } = scanRepository(ROOT);
    expect(scanned).toBeGreaterThan(1000);
    expect(
      violations.map((v) => `${v.file}:${v.line} ${v.text} <- ${v.cronPaths.join(', ')}`),
      'leggi l\'atteso dal dataset o verifica un invariante; un contratto vero va dichiarato con `// cron-count-ok: <motivo>`',
    ).toEqual([]);
  }, 180_000);
});
