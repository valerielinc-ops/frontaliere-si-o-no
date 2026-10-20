import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasHtmlTags, countHtmlTags, stripHtmlTags } from '../packages/articles/engine/shared/htmlMarkup.mjs';
import { __testables as shared } from '../scripts/lib/shared-jobs-crawler.mjs';
import {
  cleanDescriptionDCC, stripHtmlBasic, htmlToStructuredTextDCC,
  enrichJobLocalesDCC, hardenJobLocaleFields, resetHardenCache,
} from '../scripts/lib/dedicated-crawler-common.mjs';

const tokens = ['<SQL>', 'List<T>', '<Linux>', '<Python>', '<pandas>', '<li-item>', '<strongType>', '<h1Role>', '<dividend>', '<ultrasound>', '<olFactory>', '<scripture>', '<stylesheet>'];
const plain = `${tokens.join(' ')}. ` + Array.from({ length: 12 }, (_, i) =>
  `The engineer will maintain <SQL> queries and List<T> data for customer project ${i + 1}.`,
).join(' ');
const mixed = `<p class="intro">${plain}</p><ul><li>Manage &lt;CAD&gt; data and report quality.</li></ul>`;
const temporaryDirs: string[] = [];

beforeEach(() => {
  vi.stubEnv('SKIP_AI_TRANSLATION', '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request in offline boundary test'); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetHardenCache();
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('shared description HTML boundary', () => {
  it('recognizes real HTML attributes without classifying technical tokens as markup', () => {
    expect(hasHtmlTags(plain)).toBe(false);
    expect(countHtmlTags(plain)).toBe(0);
    const html = '<div data-comparison="a > b"><strong>Use <SQL> and List<T></strong></div>';
    expect(hasHtmlTags(html)).toBe(true);
    expect(countHtmlTags(html)).toBe(4);
    expect(stripHtmlTags(html).trim()).toBe('Use <SQL> and List<T>');
    expect(stripHtmlTags('<SQL-version> List<TValue>')).toBe('<SQL-version> List<TValue>');
    expect(countHtmlTags('<p>Task</p>'.repeat(5))).toBe(10);
    expect(countHtmlTags('<p>Task</p>'.repeat(6))).toBe(12);
    expect(countHtmlTags(`<svg>${'<path d="M0 0"/>'.repeat(12)}</svg>`)).toBe(14);
    expect(countHtmlTags('List<Path> and List<G>')).toBe(0);
    expect(stripHtmlTags('<!DOCTYPE html><center><big><strike>Text</strike></big></center>').trim()).toBe('Text');
  });

  it('cleans standard embedded and form tags while retaining their fallback text', () => {
    const html = '<object data="diagram.svg"><param name="quality" value="high"><canvas>Diagram</canvas></object>'
      + '<map name="places"><area alt="Office"></map><data value="1">One</data>'
      + '<datalist><option>Choice</option></datalist><meter value="1">Meter</meter>'
      + '<progress>Progress</progress><output>Result</output><hgroup>Heading</hgroup>'
      + '<search>Search</search><selectedcontent>Selected</selectedcontent><slot>Fallback</slot>';
    expect(hasHtmlTags(html)).toBe(true);
    expect(countHtmlTags(html)).toBe(28);
    expect(stripHtmlTags(html).replace(/\s+/g, ' ').trim()).toBe(
      'Diagram One Choice Meter Progress Result Heading Search Selected Fallback',
    );
  });

  it.each([
    ['shared stripHtml', shared.stripHtml],
    ['shared cleanDescription', shared.cleanDescription],
    ['shared htmlToStructuredText', shared.htmlToStructuredText],
    ['dedicated stripHtmlBasic', stripHtmlBasic],
    ['dedicated cleanDescription', cleanDescriptionDCC],
    ['dedicated htmlToStructuredText', htmlToStructuredTextDCC],
  ] as const)('%s retains literal text across mixed markup and repeated cleanup', (_name, clean) => {
    const source = `${mixed}<script type="text/javascript">window.privateNoise = true;</script><style>.privateNoise { display: none; }</style><svg viewBox="0 0 10 10"><path d="M0 0" /></svg>`;
    const result = clean(source);
    // The dedicated basic cleaner historically lowercases via normalize().
    const expectedCase = (text: string) => _name.startsWith('dedicated') ? text.toLowerCase() : text;
    for (const token of [...tokens, '<CAD>']) expect(result).toContain(expectedCase(token));
    expect(result).not.toMatch(/privateNoise|<\/?(?:p|ul|li|script|style|svg|path)(?=[\s/>])/);
    expect(clean(result)).toBe(result);
  });

  it.each([false, true])('keeps source text and source-locale output during enrichment (mixed HTML: %s)', async (html) => {
    const description = html ? mixed : plain;
    const htmlToStructuredText = vi.fn(shared.htmlToStructuredText);
    const structureJobDescription = vi.fn(async (value: string) => value);
    const enriched = await enrichJobLocalesDCC({
      company: 'Boundary Example', companyKey: 'boundary-example', sourceLang: 'en',
      title: 'Data Systems Engineer', description,
      titleByLocale: { en: 'Data Systems Engineer' }, descriptionByLocale: { en: description },
    }, { minDescriptionChars: 120 }, {
      LOCALES: ['en'], FORCE_LOCALIZE_COMPANY_KEYS: new Set(['boundary-example']),
      normalizeCompanyKey: (value: string) => value,
      isAnyModelAvailable: () => false,
      cleanDescription: shared.cleanDescription, htmlToStructuredText, structureJobDescription,
    });
    expect(htmlToStructuredText).toHaveBeenCalledTimes(html ? 1 : 0);
    expect(structureJobDescription).toHaveBeenCalledTimes(html ? 0 : 1);
    for (const value of [enriched.description, enriched.descriptionByLocale.en]) {
      for (const token of tokens) expect(value).toContain(token);
      if (html) {
        expect(value).toContain('<CAD>');
        expect(value).not.toMatch(/<\/?p(?=[\s/>])/);
      }
    }
  });

  it.each(['plain', 'html', 'svg'])('restores persisted source locale only for plain technical text (%s)', (kind) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-html-boundary-'));
    temporaryDirs.push(dir);
    const file = path.join(dir, 'jobs.json');
    const description = kind === 'html'
      ? '<p>Technical role with clear source responsibilities and project requirements.</p>'.repeat(6)
      : kind === 'svg' ? `<svg>${'<path d="M0 0"/>'.repeat(12)}</svg> Technical role with clear source responsibilities and project requirements.` : plain;
    const shortSource = 'The engineer maintains customer data and project reports.';
    fs.writeFileSync(file, JSON.stringify([{
      id: 'boundary-example', slug: 'boundary-example-data-engineer',
      company: 'Boundary Example', companyKey: 'boundary-example', location: 'Lugano',
      title: 'Data Systems Engineer', sourceLang: 'en', description,
      titleByLocale: { en: 'Data Systems Engineer' }, descriptionByLocale: { en: shortSource },
    }]));
    hardenJobLocaleFields({ dataJobsPath: file });
    const [persisted] = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.descriptionByLocale.en).toBe(kind === 'plain' ? description : shortSource);
    expect(persisted.description).toBe(description);
  });
});
