import esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  appendArticleListItem,
  upsertArticleListItem,
} from '../../scripts/lib/seo-pages-article-list.mjs';

// Minimal fixture mirroring the shape of services/seo/seo-pages.ts's
// "Articoli Frontaliere" ItemList block (see line ~4669 in the real file).
function makeFixture(items: Array<{ position: number; name: string; url: string }>) {
  const lines = items
    .map(
      (it, i) =>
        `          { "@type": "ListItem", "position": ${it.position}, "name": "${it.name}", "url": \`${it.url}\` }${
          i < items.length - 1 ? ',' : ''
        }`,
    )
    .join('\n');
  return `const BASE_URL = 'https://frontaliereticino.ch';
export const SEO_PAGES = [
 {
 "@context": "https://schema.org",
 "@type": "ItemList",
 "name": "Articoli Frontaliere",
 "numberOfItems": ${items.length},
 "itemListElement": [
${lines}
 ]
 },
];
`;
}

async function assertParses(src: string) {
  await expect(
    esbuild.transform(src, { loader: 'ts', format: 'esm', target: 'es2022' }),
  ).resolves.toBeDefined();
}

function countOccurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

// Wraps a fixture (built by makeFixture) with an EARLIER, unrelated array
// that shares the exact same single-line `{ ... "url": `...` }` shape —
// e.g. a HowTo `step` list — followed (modulo whitespace) by its own
// closing `]`. Reproduces the real services/seo/seo-pages.ts layout, where
// several such arrays exist before the "Articoli Frontaliere" ItemList.
// Regression coverage for a PR-review finding: an earlier, unbounded
// version of LAST_ITEM_RE matched THIS kind of array first (against the
// real committed file) instead of the intended block, and would have
// corrupted unrelated structured data.
function withLeadingUnrelatedArray(fixture: string): string {
  const decoy = `export const OTHER_PAGE = {
 "@type": "HowTo",
 "step": [
          { "@type": "HowToStep", "position": 1, "name": "Passo uno", "url": \`\${BASE_URL}/calcola-stipendio/passo-uno\` }
 ]
};
`;
  return decoy + fixture;
}

describe('seo-pages-article-list — comma-safe ItemList helpers', () => {
  it('never touches an unrelated earlier array with the same single-line-entry shape (bounded to the Articoli Frontaliere block only)', async () => {
    const fixture = withLeadingUnrelatedArray(
      makeFixture([
        { position: 1, name: 'Articolo uno', url: '${BASE_URL}/articoli-frontaliere/articolo-uno' },
      ]),
    );

    const result = appendArticleListItem(fixture, {
      name: 'Articolo due',
      url: '${BASE_URL}/articoli-frontaliere/articolo-due',
    });

    expect(result).not.toBeNull();
    // The decoy HowTo step array must be byte-identical — untouched.
    expect(result).toContain(
      '{ "@type": "HowToStep", "position": 1, "name": "Passo uno", "url": `${BASE_URL}/calcola-stipendio/passo-uno` }\n ]',
    );
    expect(countOccurrences(result as string, '"@type": "HowToStep"')).toBe(1);
    // The real Articoli Frontaliere ItemList gained the new entry.
    expect(result).toContain('"numberOfItems": 2');
    expect(result).toContain('articolo-due');
    await assertParses(result as string);
  });

  it('rename-replace never touches an unrelated earlier array with the same shape', async () => {
    const oldUrl = '${BASE_URL}/articoli-frontaliere/vecchio-slug';
    const newUrl = '${BASE_URL}/articoli-frontaliere/nuovo-slug';
    const fixture = withLeadingUnrelatedArray(
      makeFixture([{ position: 1, name: 'Titolo vecchio', url: oldUrl }]),
    );

    const result = upsertArticleListItem(fixture, {
      name: 'Titolo rinominato',
      url: newUrl,
      renameFromUrl: oldUrl,
    });

    expect(result).not.toBeNull();
    expect(countOccurrences(result as string, '"@type": "HowToStep"')).toBe(1);
    expect(result).toContain('passo-uno');
    expect(result).not.toContain('vecchio-slug');
    expect(result).toContain('nuovo-slug');
    await assertParses(result as string);
  });

  it('appendArticleListItem adds a new entry, bumps numberOfItems, and stays parseable', async () => {
    const fixture = makeFixture([
      { position: 1, name: 'Articolo uno', url: '${BASE_URL}/articoli-frontaliere/articolo-uno' },
      { position: 2, name: 'Articolo due', url: '${BASE_URL}/articoli-frontaliere/articolo-due' },
    ]);

    const result = appendArticleListItem(fixture, {
      name: 'Articolo tre',
      url: '${BASE_URL}/articoli-frontaliere/articolo-tre',
    });

    expect(result).not.toBeNull();
    expect(result).toContain('"numberOfItems": 3');
    expect(result).toContain('"position": 3');
    expect(result).toContain('articolo-tre');
    await assertParses(result as string);
  });

  it('appendArticleListItem is comma-safe even when the target is the last (single) element', async () => {
    const fixture = makeFixture([
      { position: 1, name: 'Solo articolo', url: '${BASE_URL}/articoli-frontaliere/solo-articolo' },
    ]);

    const result = appendArticleListItem(fixture, {
      name: 'Secondo articolo',
      url: '${BASE_URL}/articoli-frontaliere/secondo-articolo',
    });

    expect(result).not.toBeNull();
    // The previously-last (now second-to-last) entry must have gained a comma.
    expect(result).toMatch(/solo-articolo` \},/);
    await assertParses(result as string);
  });

  it('upsertArticleListItem with renameFromUrl REPLACES the old entry in place (no duplicate, no missing comma)', async () => {
    const oldUrl = '${BASE_URL}/articoli-frontaliere/vecchio-slug';
    const newUrl = '${BASE_URL}/articoli-frontaliere/nuovo-slug';
    const fixture = makeFixture([
      { position: 1, name: 'Primo articolo', url: '${BASE_URL}/articoli-frontaliere/primo-articolo' },
      { position: 2, name: 'Titolo vecchio', url: oldUrl },
      { position: 3, name: 'Terzo articolo', url: '${BASE_URL}/articoli-frontaliere/terzo-articolo' },
    ]);

    const result = upsertArticleListItem(fixture, {
      name: 'Titolo rinominato',
      url: newUrl,
      renameFromUrl: oldUrl,
    });

    expect(result).not.toBeNull();
    // Same array length — a rename REPLACES, it never appends a duplicate.
    expect(result).toContain('"numberOfItems": 3');
    expect(countOccurrences(result as string, '"@type": "ListItem"')).toBe(3);
    // Old slug is fully gone; new slug replaced it at the SAME position.
    expect(result).not.toContain('vecchio-slug');
    expect(result).not.toContain('Titolo vecchio');
    expect(result).toContain('nuovo-slug');
    expect(result).toMatch(/"position": 2,\s*"name": "Titolo rinominato"/);
    await assertParses(result as string);
  });

  it('upsertArticleListItem rename-replace stays comma-safe when the renamed entry IS the last element', async () => {
    const oldUrl = '${BASE_URL}/articoli-frontaliere/vecchio-slug-finale';
    const newUrl = '${BASE_URL}/articoli-frontaliere/nuovo-slug-finale';
    const fixture = makeFixture([
      { position: 1, name: 'Primo articolo', url: '${BASE_URL}/articoli-frontaliere/primo-articolo' },
      { position: 2, name: 'Titolo vecchio finale', url: oldUrl },
    ]);

    const result = upsertArticleListItem(fixture, {
      name: 'Titolo rinominato finale',
      url: newUrl,
      renameFromUrl: oldUrl,
    });

    expect(result).not.toBeNull();
    expect(countOccurrences(result as string, '"@type": "ListItem"')).toBe(2);
    expect(result).not.toContain('vecchio-slug-finale');
    // Last element must remain WITHOUT a trailing comma.
    expect(result).toMatch(/nuovo-slug-finale` \}\n( *)\]/);
    await assertParses(result as string);
  });

  it('upsertArticleListItem falls back to append when the old-slug entry cannot be found (self-healing, never silently drops the item)', async () => {
    const fixture = makeFixture([
      { position: 1, name: 'Primo articolo', url: '${BASE_URL}/articoli-frontaliere/primo-articolo' },
    ]);

    const result = upsertArticleListItem(fixture, {
      name: 'Articolo nuovo',
      url: '${BASE_URL}/articoli-frontaliere/articolo-nuovo',
      renameFromUrl: '${BASE_URL}/articoli-frontaliere/slug-mai-esistito',
    });

    expect(result).not.toBeNull();
    expect(result).toContain('"numberOfItems": 2');
    expect(countOccurrences(result as string, '"@type": "ListItem"')).toBe(2);
    await assertParses(result as string);
  });

  it('reproduces the #2834 incident shape and proves the helper never produces it: no "} {" adjacency anywhere in output', async () => {
    const fixture = makeFixture(
      Array.from({ length: 5 }, (_, i) => ({
        position: i + 1,
        name: `Articolo ${i + 1}`,
        url: `\${BASE_URL}/articoli-frontaliere/articolo-${i + 1}`,
      })),
    );

    let src = fixture;
    for (let i = 0; i < 10; i++) {
      const next = appendArticleListItem(src, {
        name: `Articolo generato ${i}`,
        url: `\${BASE_URL}/articoli-frontaliere/articolo-generato-${i}`,
      });
      expect(next).not.toBeNull();
      src = next as string;
    }

    // The exact corruption signature from the incident: a `}` immediately
    // followed (modulo whitespace) by `{` with no comma between two
    // ListItem entries.
    expect(src).not.toMatch(/\}\s*\n\s*\{\s*"@type":\s*"ListItem"/);
    await assertParses(src);
  });
});
