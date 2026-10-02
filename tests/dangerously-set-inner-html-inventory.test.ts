/**
 * Inventario di ogni `dangerouslySetInnerHTML` della SPA, per origine del
 * contenuto.
 *
 * Il 2026-10-02 `JobExpiredView` iniettava la description grezza di un
 * crawler (`__html: description`): una `<img onerror>` nella fonte girava
 * sulla pagina. La correzione passa dal serializer condiviso con le pagine
 * statiche (`jobDescriptionTextToHtml` → `sanitizeJobDescriptionHtml`,
 * verificato da `tests/seo/job-description-xss.test.tsx`). Questo test impedisce
 * che il prossimo `dangerouslySetInnerHTML` con testo di terzi entri senza che
 * qualcuno dica da dove viene l'HTML: ogni occorrenza deve corrispondere a una
 * voce qui sotto, con la sua ragione.
 */
import { describe, expect, it } from 'vitest';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// Only directories with SPA/React code. `packages/articles/content` is data,
// and `services/` links into it: symlinks are skipped (a sparse checkout
// leaves them dangling).
const SCAN_DIRS = ['components', 'services', 'hooks', 'packages/articles/engine'];

/** file → espressioni `__html` ammesse, ciascuna con l'origine del contenuto. */
const INVENTORY: Record<string, ReadonlyArray<{ html: RegExp; why: string }>> = {
  'components/community/JobExpiredView.tsx': [
    { html: /^descriptionHtml$/, why: 'description di crawler/ATS passata da jobDescriptionTextToHtml (allowlist sanitizer)' },
  ],
  'components/community/JobOrphanView.tsx': [
    { html: /^staticBodyHtml$/, why: 'innerHTML di .ft-static-article della pagina statica stessa, già sanitizzata al build' },
  ],
  'components/community/JobBoard.tsx': [
    { html: /^renderPublisherMarkdown\(/, why: 'markdown dei publisher: escape di tutto il testo PRIMA delle trasformazioni' },
  ],
  'components/pages/PublisherPublishPage.tsx': [
    { html: /^renderPublisherMarkdown\(/, why: 'anteprima dello stesso renderer escape-first' },
  ],
  'components/jobs/EmployerBrandHub.tsx': [
    { html: /^JSON\.stringify\(structuredData\./, why: 'JSON-LD in <script>, renderizzato solo lato client (innerHTML di <script> non esegue)' },
  ],
  'components/pages/AutorePage.tsx': [
    { html: /^JSON\.stringify\(jsonLd\)$/, why: 'JSON-LD di prima parte' },
  ],
  'components/pages/Correzioni.tsx': [
    { html: /^JSON\.stringify\(jsonLd\)$/, why: 'JSON-LD di prima parte' },
  ],
  'components/comparators/BankComparison.tsx': [
    { html: /^t\('/, why: 'stringa i18n di prima parte' },
  ],
  'components/guide/TrafficAlerts.tsx': [
    { html: /^t\('/, why: 'stringhe i18n di prima parte' },
  ],
  'components/calculator/SeasonalNaspiSimulator.tsx': [
    { html: /^paragraph\s*\.replace\(/, why: 'copy.editorialParagraphs, testo editoriale di prima parte' },
  ],
  'components/calculator/NewFrontierOver20KmHub.tsx': [
    { html: /^paragraph\s*\.replace\(/, why: 'copy.editorialParagraphs, testo editoriale di prima parte' },
  ],
};

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
}

/** Every `__html:` expression in the file, whitespace-collapsed. */
function htmlExpressions(src: string): string[] {
  const found: string[] = [];
  const re = /dangerouslySetInnerHTML=\{\{\s*__html:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const rest = src.slice(re.lastIndex, re.lastIndex + 400);
    const end = rest.search(/,?\s*\}\}/);
    found.push(rest.slice(0, end < 0 ? rest.length : end).replace(/\s+/g, ' ').trim());
  }
  return found;
}

describe('dangerouslySetInnerHTML: ogni occorrenza ha un\'origine dichiarata', () => {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir), files);
  const occurrences = files.flatMap((file) => {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    return htmlExpressions(readFileSync(file, 'utf8')).map((html) => ({ rel, html }));
  });

  it('trova le occorrenze (il parser non è cieco)', () => {
    expect(occurrences.length).toBeGreaterThanOrEqual(16);
  });

  it('nessuna occorrenza fuori inventario', () => {
    const unknown = occurrences
      .filter(({ rel, html }) => !(INVENTORY[rel] ?? []).some((entry) => entry.html.test(html)))
      .map(({ rel, html }) => `${rel}: __html: ${html}`);
    expect(unknown, 'aggiungi la voce a INVENTORY solo se l\'HTML è di prima parte o passa da un sanitizer').toEqual([]);
  });

  it('nessuna voce dell\'inventario è morta', () => {
    for (const [rel, entries] of Object.entries(INVENTORY)) {
      for (const entry of entries) {
        expect(occurrences.some((o) => o.rel === rel && entry.html.test(o.html)), `${rel} ${entry.html}`).toBe(true);
      }
    }
  });
});
