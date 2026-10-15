// Author presentation metadata has ONE source: the registry in data/authors.ts.
//
// PR 11327 corrected marco-ferrari's expertise in the registry ("accordo
// Italia-Svizzera 2026" -> "accordo Italia-Svizzera"), but the same text lived
// on as hand-written copies in services/seo/seo-pages.ts (the `autore-*` page
// entries) and in build-plugins/staticPagesPlugin.ts (the /chi-siamo/ roster,
// which also missed samuele-valente). This test fails when either file carries
// its own copy again, or when what they produce diverges from the registry.
//
// data/ sits outside the reverse import graph of scripts/ci/run-related-tests.mjs,
// and the two source files are read from disk: the test is registered in
// `sourceTreeLintTests` with that perimeter.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AUTHORS } from '../data/authors';
import { localizeAuthor } from '../data/authorLocales';
import { resolveAuthorProfileMetadata } from '../services/seo/authorProfileMetadata';
import { renderAuthorRosterItems } from '../build-plugins/shared/authorEditorial';
import SEO_PAGES from '../services/seo/seo-pages';
import { parseSeoEntries } from '../scripts/lib/llms-txt-generator.mjs';

const SOURCES = ['services/seo/seo-pages.ts', 'build-plugins/staticPagesPlugin.ts'];
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
const html = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

describe('author metadata derives from the registry', () => {
  it('seo-pages.ts carries exactly the registry-derived entry for every author', () => {
    const authorKeys = Object.keys(SEO_PAGES).filter(key => key.startsWith('autore-')).sort();
    expect(authorKeys).toEqual(AUTHORS.map(author => `autore-${author.slug}`).sort());
    for (const key of authorKeys) {
      expect(SEO_PAGES[key], key).toEqual(resolveAuthorProfileMetadata(key, 'it'));
    }
  });

  it.each(SOURCES)('%s holds no hand-written copy of an author', rel => {
    const source = read(rel);
    for (const author of AUTHORS) {
      const local = localizeAuthor(author, 'it');
      expect(source, `${rel}: /autori/${author.slug} path`).not.toContain(`/autori/${author.slug}`);
      expect(source, `${rel}: autore-${author.slug} entry`).not.toMatch(new RegExp(`["']autore-${author.slug}["']`));
      // Roster-shaped only (`</a> — <role>`): a generic role such as "Team
      // editoriale" may legitimately appear in unrelated prose.
      expect(source, `${rel}: roster line for ${author.slug}`).not.toContain(`</a> — ${local.role}`);
    }
  });

  it('the static /chi-siamo/ roster lists every author with registry name, role and expertise', () => {
    // Wiring: the plugin imports the registry-driven helper (the hand-copied
    // roster it replaced is caught by the roster-line check above).
    expect(read('build-plugins/staticPagesPlugin.ts')).toMatch(
      /import\s*\{[^}]*\brenderAuthorRosterItems\b[^}]*\}\s*from\s*['"]\.\/shared\/authorEditorial['"]/,
    );
    const roster = renderAuthorRosterItems('it', 'item', 'link');
    expect(roster.match(/<li /g)).toHaveLength(AUTHORS.length);
    for (const source of AUTHORS) {
      const author = localizeAuthor(source, 'it');
      expect(roster).toContain(`href="/autori/${author.slug}/" rel="author">${html(author.name)}</a> — ${html(author.role)}`);
      for (const topic of author.expertise) expect(roster, `${author.slug}: ${topic}`).toContain(html(topic));
    }
  });

  it('llms.txt reads author titles and descriptions from the same resolver', () => {
    const entries = parseSeoEntries(process.cwd(), fs);
    for (const author of AUTHORS) {
      const expected = resolveAuthorProfileMetadata(`autore-${author.slug}`, 'it')!;
      const entry = entries.get(`/autori/${author.slug}`);
      expect(entry?.title, author.slug).toBe(expected.title.replace(/\s*\|\s*Frontaliere Ticino$/, ''));
      expect(entry?.desc, author.slug).toBe(expected.description.slice(0, 160));
    }
  });
});
