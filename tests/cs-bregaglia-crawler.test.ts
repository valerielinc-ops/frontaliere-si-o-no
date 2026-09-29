import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseCsBregagliaDetailBody, parseRssFeed } from '../scripts/lib/cs-bregaglia-job-parser.mjs';

// Real csbregaglia.ch vacancy page (2026-09-29), minimized: the clinic
// presentation paragraph is shortened, every section and the Joomla
// email-cloak markup are kept as served.
const DETAIL_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'cs-bregaglia', 'detail-medico.html'),
  'utf8',
);

// The RSS item for the same vacancy carries only the intro facts list.
const RSS_XML = `<rss><channel><item>
<title>Offerta di lavoro: medico di medicina interna generale</title>
<link>https://www.csbregaglia.ch/it/centro-sanitario/offerte-di-lavoro/419-offerta-di-lavoro-medico-di-medicina-generale-o-internista</link>
<description><![CDATA[<p><strong>Offerta di lavoro in breve:</strong></p>
<ul><li><strong>Azienda:</strong> Centro Sanitario Bregaglia</li>
<li><strong>Contatto:</strong> <a href="mailto:info@csbregaglia.ch">info@csbregaglia.ch</a></li></ul>]]></description>
<pubDate>Mon, 28 Jul 2025 07:14:10 +0200</pubDate>
</item></channel></rss>`;

describe('cs-bregaglia detail body', () => {
  it('reads the whole posting from the vacancy page, not the RSS intro', () => {
    const [item] = parseRssFeed(RSS_XML);
    const body = parseCsBregagliaDetailBody(DETAIL_HTML);
    expect(item.description).not.toMatch(/Requisiti/);
    expect(body).toMatch(/^Offerta di lavoro in breve:/);
    expect(body).toContain('Requisiti:');
    expect(body).toContain('• Specializzazione in medicina interna generale');
    expect(body).toContain('Offriamo:');
    expect(body).toContain('• Alloggi disponibili');
    expect(body).toContain('non verranno considerate candidature prive di curriculum vitae');
    expect(body.length).toBeGreaterThan(item.description.length * 2);
  });

  it('keeps list items as line-start bullets without blank lines between them', () => {
    const body = parseCsBregagliaDetailBody(DETAIL_HTML);
    expect(body).toMatch(/\n• Flessibilità e affidabilità\n• Capacità di lavorare in un piccolo team\n/);
  });

  it('drops the title, page chrome and the Joomla spam-protection notice but keeps the address', () => {
    const body = parseCsBregagliaDetailBody(DETAIL_HTML);
    expect(body).not.toMatch(/Offerta di lavoro: medico/);
    expect(body).not.toMatch(/spambots|JavaScript|getElementById|addy/);
    expect(body).not.toMatch(/© CSB/);
    expect(body).toContain('Contatto: info@csbregaglia.ch');
    expect(body).toMatch(/Contatto di riferimento: info@csbregaglia\.ch$/);
  });

  it('returns an empty body when the page has no article', () => {
    expect(parseCsBregagliaDetailBody('<html><body><p>Pagina non trovata</p></body></html>')).toBe('');
  });
});
