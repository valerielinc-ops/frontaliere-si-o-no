import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { decode as decodeHTML } from 'html-entities';
import { decodeHtmlText } from '../packages/articles/engine/shared/htmlEntities';
import { parseFhgrDetailPage } from '../scripts/lib/fhgr-job-parser.mjs';
import { parseSpitalDavosDetailPage } from '../scripts/lib/spital-davos-job-parser.mjs';
import { parseGkbDetailPage } from '../scripts/lib/gkb-job-parser.mjs';
import { parseTschuggenDetailPage } from '../scripts/lib/tschuggen-job-parser.mjs';
import { parseSfsGroupDetail } from '../scripts/lib/sfs-group-job-parser.mjs';
import { parseHoneggerDetailPage } from '../scripts/lib/honegger-job-parser.mjs';
import { buildFallbackCanonicalContent } from '../services/jobs/canonicalFallback';
import { buildJobMetaDescription } from '../build-plugins/shared/jobMetaDescription';

const encoded = 'Kenntnisse f&uuml;r Qualit&agrave; &lpar;R&amp;D&rpar; &#128640; &#x1F9EA; &lt;SQL&gt; &amp;lt;literal&amp;gt;';
const decoded = 'Kenntnisse für Qualità (R&D) 🚀 🧪 <SQL> &lt;literal&gt;';

// Execute the actual private text boundary without importing crawler CLI mains
// or running a full SSG build. No implementation is copied into the fixture.
function boundary<T>(file: string, name: string, bindings: Record<string, unknown>, contains = ''): T {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let expression = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer?.getText(source).includes(contains)) {
      expression ||= node.initializer.getText(source);
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      expression ||= node.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error(`Missing boundary ${file}:${name}`);
  const compiled = ts.transpileModule(`const value = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(bindings), `${compiled}\nreturn value;`)(...Object.values(bindings)) as T;
}

describe('HTML entity publication boundaries', () => {
  it('decodes a single layer with HTML5 C1 mappings and valid Unicode scalars', () => {
    expect(decodeHtmlText(encoded)).toBe(decoded);
    expect(decodeHtmlText('&#128; &#x80; &#55296; &#0; &#1114112; &#99999999999999999999999999;'))
      .toBe('€ € � � � �');
    expect(decodeHtmlText('&#1114111;')).toBe(String.fromCodePoint(0x10ffff));
    expect(decodeHtmlText('&copycat &notarealentity; &amp;eacute;')).toBe('&copycat &notarealentity; &eacute;');
  });

  it.each([
    ['FHGR', () => parseFhgrDetailPage(`<div class="einleitung"><p>${encoded}</p></div><div class="text" id="einschub"><b>${encoded}</b></div>`).description],
    ['Spital Davos', () => parseSpitalDavosDetailPage(`<div id="einleitung_text"><p>${encoded}</p></div><div id="text"><b>${encoded}</b></div>`).description],
    ['GKB', () => parseGkbDetailPage(`<div class="customdatablock"><p>${encoded}</p></div>`).description],
    ['Tschuggen', () => parseTschuggenDetailPage(`<div id="content"><h2>Profil &lt;SQL&gt;</h2><p>${encoded}</p></div>`).description],
    ['SFS', () => parseSfsGroupDetail(`<div class="organism-text"><div class="text"><p>${encoded}</p></div></div><h3 class="atom-section-headline">Profil &lt;SQL&gt;</h3><div class="atom-copytext">${encoded}</div>`).description],
    ['Honegger', () => parseHoneggerDetailPage(`<h2>Das kannst du bei uns bewirken</h2><ul class="wp-block-list hon-list"><li>${encoded}</li></ul>`).tasks.join(' ')],
  ] as const)('%s removes real tags before decoding text once', (_name, parse) => {
    expect(parse()).toContain(decoded);
  });

  it('preserves Hamilton Workday text and list boundaries', () => {
    const description = boundary<string>('scripts/update-hamilton-jobs.mjs', 'description', {
      decodeHTML, rawDescription: `<p>${encoded}</p><ul><li>Weitere Kenntnisse &lt;CAD&gt;</li></ul>`,
    });
    expect(description).toContain(decoded);
    expect(description).toContain('\n- Weitere Kenntnisse <CAD>');
  });

  it('preserves Kempinski Pinpoint accents instead of deleting named references', () => {
    const strip = boundary<(html: string) => string>('scripts/update-kempinski-jobs.mjs', 'stripHtml', { decodeHTML });
    expect(strip(`<p>${encoded}</p>`)).toBe(decoded);
  });

  it('keeps decoded text through canonical section cleanup, including requirements', () => {
    const result = buildFallbackCanonicalContent(`<p>${encoded}</p>`, [`Esperienza della citt&agrave; con &lt;CAD&gt; e &amp;lt;literal&amp;gt;`], 'it');
    expect(JSON.stringify(result)).toContain(decoded);
    expect(result.requirements.join(' ')).toContain('Esperienza della città con <CAD> e &lt;literal&gt;');
  });

  it('preserves literal angle-bracket tokens in plain text persisted by a crawler', () => {
    const parsed = parseFhgrDetailPage('<div class="text" id="einschub"><p>Conoscenza approfondita di &lt;SQL&gt; e qualit&agrave; dei dati richiesta.</p></div>');
    expect(parsed.description).toContain('<SQL>');
    const result = buildFallbackCanonicalContent(parsed.description, [], 'it');
    expect(JSON.stringify(result)).toContain('Conoscenza approfondita di <SQL> e qualità dei dati richiesta');
    const mixed = buildFallbackCanonicalContent('<p>Conoscenza approfondita di <SQL> e List<T> richiesta.</p><br>Esperienza nella gestione dei dati.', [], 'it');
    expect(JSON.stringify(mixed)).toContain('Conoscenza approfondita di <SQL> e List<T> richiesta');
  });

  it('keeps article JSON-LD excerpt text after stripping source markup', () => {
    const excerpt = boundary<(html: string) => string>('packages/articles/engine/ogPagesPlugin.ts', 'extractExcerpt', { decodeHtmlText });
    expect(excerpt(`<p>${encoded} tail</p>`)).toBe(decoded);
  });

  it('retains named source text in job metadata and leaves final assembly decoded once', () => {
    const file = 'build-plugins/jobsSeoPagesPlugin.ts';
    const decodeHtmlEntities = boundary<(text: string) => string>(file, 'decodeHtmlEntities', { decodeHtmlText });
    const clean = boundary<(text: string) => string>(file, 'cleanMetaDescription', { decodeHtmlEntities });
    const metaIntro = boundary<string>(file, 'metaIntro', {
      decodeHtmlEntities, locale: 'en', localizedTitle: 'Analyst &amp;eacute; &#x1D400;',
      job: { company: 'H&ocirc;pital', location: 'Citt&agrave;' },
    });
    expect(metaIntro).toBe('Analyst &eacute; 𝐀 at Hôpital in Città.');
    expect(clean('Capacit&agrave; f&uuml;r &#x1D400; &amp;eacute;')).toBe('Capacità für 𝐀 &eacute;');
    // The active-job emitter now composes the final description through the
    // shared helper, adding CTA/completeness text after the decoded intro.
    const description = boundary<string>(file, 'description', {
      buildJobMetaDescription,
      locale: 'en', localizedTitle: 'Analyst &amp;eacute; &#x1D400;',
      job: { company: 'H&ocirc;pital', location: 'Citt&agrave;' },
      cleanDesc: '',
    }, 'buildJobMetaDescription');
    expect(description.startsWith(metaIntro)).toBe(true);
  });
});
