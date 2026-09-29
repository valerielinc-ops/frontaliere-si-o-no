import { describe, it, expect } from 'vitest';
import {
  zohoHtmlToMarkdown,
  extractEmbeddedJobData,
  validateRelewantDescription,
  titleOverlap,
} from '../scripts/lib/relewant-job-parser.mjs';

// ──────────────────────────────────────────────────────────────
// Real HTML fixtures from Zoho Recruit detail pages
// ──────────────────────────────────────────────────────────────

const FIXTURE_MFT_HTML = `<span id="spandesc"><div><b>Chi siamo?</b> <br/></div><div>Relewant è una società di consulenza specializzata in ambito informatico con sede a Chiasso, in Svizzera.<br/></div><div>Con noi, potrai mettere a frutto il tuo potenziale in un team coeso e vincente ed esplorare tecnologie sempre più innovative in contesti multinazionali.<br/></div><div><br/></div><div><b>La nostra Mission</b><br/></div><div>Il nostro successo nasce dalle qualità delle persone che fanno parte del gruppo.<br/></div><div>Competenza, professionalità e voglia di stare al passo in un mercato tecnologico in continua evoluzione ci contraddistinguono.<br/></div><div>Proprio per questo motivo attrarre i migliori talenti è una nostra priorità.<br/></div><div><b><br/></b></div><div><b>Chi stiamo cercando?</b><br/></div><div>Siamo alla ricerca di un&nbsp;<b>Automation &amp; MFT Specialist</b> che sarà responsabile della gestione e dell'automazione dei processi batch e dell'orchestrazione dei workflow attraverso la piattaforma Broadcom Automic Automation. Si occuperà anche della configurazione e amministrazione degli strumento MFT garantendo sicurezza e tracciabilità dei trasferimenti di dati sensibili.<br/></div></span><br/><span id="spanreq"><h3>Requisiti</h3><ul><li><span>Esperienza consolidata con <b>Broadcom Automic (UC4)</b> o scheduler equivalenti.</span><br/></li><li><span>Padronanza di tool <b>MFT</b> (es. Axway, Sterling, GoAnywhere, CFT).</span><br/></li><li><span>Ottime capacità di scripting: <b>Bash, Python, PowerShell.</b></span><br/></li><li>Conoscenza approfondita di <b>Linux</b> (amministrazione) e basi Windows.<br/></li><li>Familiarità con strumenti di automazione/monitoraggio (<b>Ansible, Jenkins, Splunk, Dynatrace</b>).<br/></li><li>Esperienza operativa in ambienti regolamentati (FINMA / PCI DSS).<br/></li><li>Ottima conoscenza della lingua inglese<br/></li></ul><div><br/></div><div><b>Assunzione a tempo indeterminato con contratto Svizzero.</b><br/></div><div><b>Sede di lavoro&nbsp;Lugano</b>.<br/></div><div><br/></div><div><b>Cosa aspetti?</b><br/></div><div>Cogli l\u2019opportunità di crescere professionalmente in un ambiente positivo e dinamico, sviluppando le tue competenze in un\u2019azienda attenta al cambiamento e vicina ai propri collaboratori!<br/></div><div><br/></div><div><i>Il presente annuncio è rivolto ad entrambi i sessi e a persone di tutte le età e le nazionalità.</i><br/></div><div><br/></div><div><i>I dati saranno trattati e conservati esclusivamente per le finalità di questa o future selezioni, nel rispetto della Legge federale sulla protezione dei dati (LPD) e garantendo i diritti di cui all'art. 13 del Regolamento UE 679/16 (GDPR).</i><br/></div><div><br/></div></span><br/>`;

const FIXTURE_BI_HTML = `<span id="spandesc"><div><b>Chi siamo?</b> <br/></div><div>Relewant è una società di consulenza specializzata in ambito informatico con sede a Chiasso, in Svizzera.<br/></div><div>Con noi, potrai mettere a frutto il tuo potenziale in un team coeso e vincente ed esplorare tecnologie sempre più innovative in contesti multinazionali.<br/></div><div><br/></div><div><b>La nostra Mission</b><br/></div><div>Il nostro successo nasce dalle qualità delle persone che fanno parte del gruppo.<br/></div><div>Competenza, professionalità e voglia di stare al passo in un mercato tecnologico in continua evoluzione ci contraddistinguono.<br/></div><div>Proprio per questo motivo attrarre i migliori talenti è una nostra priorità.<br/></div><div><b><br/></b></div><div><b>Chi stiamo cercando?</b><br/></div><div>Siamo alla ricerca di un <b>BI Specialist</b> con una solida esperienza nella gestione di piattaforme di Business Intelligence (BI). La persona ideale ha competenze avanzate in strumenti come <b>MicroStrategy</b>, <b>Power BI</b>, <b>Tableau</b> o simili, con focus sulla creazione di report, dashboard e analisi dati a supporto delle decisioni aziendali.<br/></div></span><br/><span id="spanreq"><h3>Requisiti</h3><ul><li>Esperienza consolidata in progetti di BI con piattaforme come <b>MicroStrategy</b>, <b>Power BI</b>, <b>Tableau</b>.<br/></li><li>Capacità di sviluppare dashboard, report e visualizzazioni interattive.<br/></li><li>Conoscenza dei processi ETL e della modellazione dei dati.<br/></li><li>Familiarità con database relazionali (<b>SQL Server</b>, <b>Oracle</b>, <b>PostgreSQL</b>).<br/></li><li>Buona padronanza di <b>SQL</b> per query complesse e ottimizzazione.<br/></li><li>Esperienza nella raccolta e formalizzazione dei requisiti di business.<br/></li><li>Ottima conoscenza della lingua inglese.<br/></li></ul></span><br/>`;

// Embedded page HTML for extractEmbeddedJobData
const FIXTURE_EMBEDDED_PAGE = `<!DOCTYPE html><html><head><title>Test</title></head><body><script>var jobs = JSON.parse('[{\\x22Posting_Title\\x22:\\x22Automation \\x26 MFT Specialist\\x22,\\x22City\\x22:\\x22Lugano\\x22,\\x22Job_Description\\x22:\\x22<b>Test desc</b>\\x22,\\x22Work_Experience\\x22:\\x224-5 anni\\x22,\\x22Industry\\x22:\\x22Servizi finanziari\\x22,\\x22id\\x22:\\x22123\\x22}]');</script></body></html>`;

// ──────────────────────────────────────────────────────────────
// zohoHtmlToMarkdown tests
// ──────────────────────────────────────────────────────────────

describe('zohoHtmlToMarkdown', () => {
  it('converts MFT Specialist HTML to markdown ≥ 500 chars', () => {
    const md = zohoHtmlToMarkdown(FIXTURE_MFT_HTML);
    expect(md.length).toBeGreaterThanOrEqual(500);
  });

  it('preserves section headings from MFT job', () => {
    const md = zohoHtmlToMarkdown(FIXTURE_MFT_HTML);
    expect(md).toMatch(/###.*Chi siamo/);
    expect(md).toMatch(/###.*La nostra Mission/);
    expect(md).toMatch(/###.*Chi stiamo cercando/);
    expect(md).toMatch(/###.*Requisiti|#### Requisiti/);
  });

  it('preserves list items from MFT requirements', () => {
    const md = zohoHtmlToMarkdown(FIXTURE_MFT_HTML);
    expect(md).toContain('- Esperienza consolidata con');
    expect(md).toContain('Broadcom Automic');
    expect(md).toContain('- Padronanza di tool MFT');
    expect(md).toContain('Bash, Python, PowerShell');
  });

  it('converts BI Specialist HTML to markdown ≥ 400 chars', () => {
    const md = zohoHtmlToMarkdown(FIXTURE_BI_HTML);
    expect(md.length).toBeGreaterThanOrEqual(400);
  });

  it('preserves BI-specific content', () => {
    const md = zohoHtmlToMarkdown(FIXTURE_BI_HTML);
    expect(md).toContain('MicroStrategy');
    expect(md).toContain('Power BI');
    expect(md).toContain('dashboard');
    expect(md).toContain('SQL');
  });

  it('returns empty string for empty input', () => {
    expect(zohoHtmlToMarkdown('')).toBe('');
    expect(zohoHtmlToMarkdown(null as any)).toBe('');
  });

  it('does not contain raw HTML tags', () => {
    const md = zohoHtmlToMarkdown(FIXTURE_MFT_HTML);
    expect(md).not.toMatch(/<(div|span|b|strong|ul|li|br)\b/);
  });
});

// ──────────────────────────────────────────────────────────────
// extractEmbeddedJobData tests
// ──────────────────────────────────────────────────────────────

describe('extractEmbeddedJobData', () => {
  it('extracts job data from embedded JSON', () => {
    const data = extractEmbeddedJobData(FIXTURE_EMBEDDED_PAGE);
    expect(data).not.toBeNull();
    expect(data.Posting_Title).toBe('Automation & MFT Specialist');
    expect(data.City).toBe('Lugano');
    expect(data.Work_Experience).toBe('4-5 anni');
    expect(data.Industry).toBe('Servizi finanziari');
  });

  it('returns null for pages without embedded JSON', () => {
    expect(extractEmbeddedJobData('<html><body>No jobs here</body></html>')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractEmbeddedJobData('')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────
// validateRelewantDescription tests
// ──────────────────────────────────────────────────────────────

describe('validateRelewantDescription', () => {
  it('passes for rich MFT description', () => {
    const md = zohoHtmlToMarkdown(FIXTURE_MFT_HTML);
    const result = validateRelewantDescription(md, FIXTURE_MFT_HTML.length);
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('passes for BI Specialist description', () => {
    const md = zohoHtmlToMarkdown(FIXTURE_BI_HTML);
    const result = validateRelewantDescription(md, FIXTURE_BI_HTML.length);
    expect(result.ok).toBe(true);
  });

  it('fails for too short descriptions', () => {
    const result = validateRelewantDescription('Very short', 5000);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes('too short'))).toBe(true);
  });

  it('fails for too few content blocks', () => {
    const result = validateRelewantDescription('A single paragraph that is long enough to pass the length check but has no structure whatsoever and no headings or lists.'.repeat(3), 0);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes('content blocks'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// titleOverlap tests
// ──────────────────────────────────────────────────────────────

describe('titleOverlap', () => {
  it('returns 1 for exact match', () => {
    expect(titleOverlap('Automation & MFT Specialist', 'Automation & MFT Specialist')).toBe(1);
  });

  it('returns 1 for empty expected', () => {
    expect(titleOverlap('', 'anything')).toBe(1);
  });

  it('returns high overlap for close match', () => {
    expect(titleOverlap('BI Specialist', 'BI Specialist (Senior)')).toBeGreaterThanOrEqual(0.6);
  });

  it('returns low overlap for mismatch', () => {
    expect(titleOverlap('Java Developer', 'Network Engineer')).toBeLessThan(0.5);
  });

  it('handles special characters', () => {
    expect(titleOverlap('Automation & MFT Specialist', 'Automation MFT Specialist')).toBeGreaterThanOrEqual(0.6);
  });
});
