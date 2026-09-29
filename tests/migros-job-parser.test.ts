/**
 * Tests for scripts/lib/migros-job-parser.mjs
 *
 * Verifies that extractMigrosStructuredData correctly parses Migros SSR
 * job pages and returns the full description including responsibilities,
 * requirements, and benefits sections — not just the brief overview
 * that appears in the JSON-LD JobPosting.
 */
import { describe, expect, it } from 'vitest';
import {
  extractMigrosStructuredData,
  extractMigrosSectionItems,
  extractMigrosWorkplaces,
  migrosRecruitmentToMarkdown,
} from '../scripts/lib/migros-job-parser.mjs';

// ─── Shared fixture helpers ────────────────────────────────────────────────────

function migrosPageHtml({
  overviewText = 'Testo di introduzione alla posizione.',
  taskItems = [
    'Gestisci il team di vendita e garantisci gli obiettivi.',
    'Curi la qualità dei prodotti freschi e combatti gli sprechi.',
    'Pianifichi il lavoro settimanale del personale.',
  ],
  skillItems = [
    { label: '3 anni', detail: 'Esperienza nella vendita al dettaglio.' },
    { label: 'Italiano', detail: 'Madrelingua o livello ottimo.' },
  ],
  benefitItems = [
    { label: 'Sconti', detail: 'Riduzione del 10% sugli acquisti Migros.' },
    { label: 'Formazione', detail: 'Accesso a corsi professionali interni.' },
  ],
  recruitmentText = 'Invia la candidatura tramite il portale online. Contatto: hr@migros.ch',
  workPercentage = '80-100',
} = {}) {
  const tasksHtml = taskItems
    .map(t => `<p class="text-pretty font-body1">${t}</p>`)
    .join('\n');

  const skillsHtml = skillItems
    .map(s => `<div class="grid-card"><h4 class="font-bold">${s.label}</h4><p>${s.detail}</p></div>`)
    .join('\n');

  const benefitsHtml = benefitItems
    .map(b => `<div class="grid-card"><h4 class="font-bold">${b.label}</h4><p>${b.detail}</p></div>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="it">
<head><title>Job Title - jobs.migros.ch</title></head>
<body>
<section id="overview">
  <div class="typo-body1">${overviewText}</div>
  <div>${workPercentage}%</div>
</section>
<section id="tasks">
  <h3>Mansioni</h3>
  ${tasksHtml}
</section>
<section id="skills">
  <h3>Competenze</h3>
  ${skillsHtml}
</section>
<section id="benefits">
  <h3>Cosa offriamo</h3>
  ${benefitsHtml}
</section>
<section id="recruitment">
  <div class="recruitment-info">${recruitmentText}</div>
</section>
</body>
</html>`;
}

// ─── Denner Gerente fixture ───────────────────────────────────────────────────

const DENNER_GERENTE_HTML = migrosPageHtml({
  overviewText:
    "Da noi non dirigi una filiale qualsiasi, ma bensì il nostro negozio. " +
    "Tu ne ha la responsabilità, ma noi raggiungiamo sempre insieme l'obiettivo. " +
    "Noi dimostriamo apprezzamento. La spinta ideale alla tua voglia di fare. " +
    "E un ambiente cordiale con un team vincente. Denner siamo noi.",
  taskItems: [
    'Istruisci, incentivi il personale trasmettendogli le tue conoscenze e rappresenti il nostro negozio.',
    'Presti particolare attenzione alla freschezza di frutta, verdura e pane e combatti gli sprechi alimentari.',
    'Ordini la merce per tempo e nella giusta quantità.',
    'Programmi sapientemente il lavoro nel quadro del piano settimanale garantendo il rispetto delle normative.',
    "Dai il massimo per far quadrare i conti – in termini di fatturato, spese per il personale e resa.",
  ],
  skillItems: [
    { label: '3 anni', detail: 'Esperienza nella vendita al dettaglio, preferibilmente nel ramo alimentare.' },
    { label: 'Diploma', detail: 'Diploma di scuola media o formazione equivalente.' },
    { label: 'Italiano', detail: 'Padronanza della lingua italiana.' },
  ],
  benefitItems: [
    { label: 'Salario', detail: 'Retribuzione attrattiva con premi legati alle prestazioni.' },
    { label: 'Sconti', detail: 'Vantaggi esclusivi per i collaboratori presso le insegne del Gruppo Migros.' },
  ],
  recruitmentText: 'Hai domande? Contatta il responsabile HR al numero +41 91 000 00 00.',
  workPercentage: '80-100',
});

// ─── Migros Ticino Project Manager fixture ────────────────────────────────────

const MIGROS_PM_HTML = migrosPageHtml({
  overviewText:
    "Stai cercando una sfida stimolante nel settore immobiliare? " +
    "Unisciti al team di Migros Ticino come Project Manager Immobiliare e contribuisci " +
    "alla gestione e allo sviluppo del patrimonio immobiliare della cooperativa.",
  taskItems: [
    'Coordini progetti di costruzione e ristrutturazione dalla fase di pianificazione alla consegna.',
    'Gestisci i rapporti con architetti, ingegneri e imprese di costruzione.',
    'Monitori i costi e i tempi di realizzazione garantendo il rispetto del budget.',
    'Elabori rapporti periodici per la direzione sullo stato di avanzamento dei progetti.',
  ],
  skillItems: [
    { label: 'Laurea', detail: 'In architettura, ingegneria civile o discipline affini.' },
    { label: '5 anni', detail: 'Esperienza nella gestione di progetti immobiliari complessi.' },
    { label: 'Tedesco B2', detail: 'Conoscenza del tedesco a livello B2 o superiore.' },
    { label: 'MS Project', detail: 'Padronanza di strumenti di project management.' },
  ],
  benefitItems: [
    { label: 'Smart working', detail: 'Possibilità di lavoro da remoto per alcuni giorni a settimana.' },
    { label: '6 settimane', detail: 'Sei settimane di ferie annuali.' },
    { label: 'Cassa pensione', detail: 'Piano pensionistico con contributi aziendali superiori al minimo legale.' },
  ],
  recruitmentText:
    'Invia la candidatura online entro il 31 marzo 2026. Per domande: immobiliare-hr@migros.ch',
  workPercentage: '100',
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('migros-job-parser / extractMigrosStructuredData', () => {
  describe('Denner Gerente fixture', () => {
    const result = extractMigrosStructuredData(DENNER_GERENTE_HTML);

    it('returns a non-null result', () => {
      expect(result).not.toBeNull();
    });

    it('extracts 5 responsibility items from the tasks section', () => {
      expect(result!.responsibilities).toHaveLength(5);
    });

    it('description contains ## Mansioni section', () => {
      expect(result!.description).toContain('## Mansioni');
    });

    it('description contains ## Requisiti section', () => {
      expect(result!.description).toContain('## Requisiti');
    });

    it('description contains ## Cosa offriamo section', () => {
      expect(result!.description).toContain('## Cosa offriamo');
    });

    it('description length exceeds 500 chars (full body, not overview-only)', () => {
      expect(result!.description.length).toBeGreaterThan(500);
    });

    it('includes the overview text', () => {
      expect(result!.description).toContain('Denner siamo noi');
    });

    it('includes a specific responsibility item', () => {
      expect(result!.description).toContain('freschezza di frutta');
    });

    it('includes requirements from skills section', () => {
      expect(result!.requirements.length).toBeGreaterThan(0);
      expect(result!.requirements.some(r => r.includes('vendita al dettaglio'))).toBe(true);
    });

    it('detects work percentage from overview badge', () => {
      expect(result!.workPercentage).toBe('80-100%');
    });
  });

  describe('Migros Ticino Project Manager fixture', () => {
    const result = extractMigrosStructuredData(MIGROS_PM_HTML);

    it('returns a non-null result', () => {
      expect(result).not.toBeNull();
    });

    it('extracts 4 responsibility items', () => {
      expect(result!.responsibilities).toHaveLength(4);
    });

    it('extracts 4 requirement items', () => {
      expect(result!.requirements).toHaveLength(4);
    });

    it('extracts 3 benefit items', () => {
      expect(result!.benefits).toHaveLength(3);
    });

    it('description length exceeds 500 chars', () => {
      expect(result!.description.length).toBeGreaterThan(500);
    });

    it('description contains all four main sections', () => {
      expect(result!.description).toContain('## Mansioni');
      expect(result!.description).toContain('## Requisiti');
      expect(result!.description).toContain('## Cosa offriamo');
    });

    it('includes PM-specific content', () => {
      expect(result!.description).toContain('project management');
      expect(result!.description).toContain('patrimonio immobiliare');
    });
  });

  describe('page without Migros sections', () => {
    it('returns null for a plain HTML page without sections', () => {
      const html = '<html><body><h1>Job Title</h1><p>Description.</p></body></html>';
      expect(extractMigrosStructuredData(html)).toBeNull();
    });

    it('returns null when only overview section is present', () => {
      const html = '<section id="overview"><div class="typo-body1">Intro.</div></section>';
      expect(extractMigrosStructuredData(html)).toBeNull();
    });
  });
});

describe('migros-job-parser / extractMigrosSectionItems', () => {
  it('extracts text-pretty paragraph items (tasks grid)', () => {
    const html = `
      <p class="text-pretty font-body2">Gestisci il team di vendita e garantisci gli obiettivi.</p>
      <p class="text-pretty font-body2">Assicuri la qualità dei prodotti freschi.</p>
    `;
    const items = extractMigrosSectionItems(html);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('Gestisci il team');
    expect(items[1]).toContain('qualità dei prodotti');
  });

  it('extracts h4+p pairs (skills grid)', () => {
    const html = `
      <div class="card">
        <h4 class="font-bold">3 anni</h4>
        <p>Esperienza nella gestione del personale.</p>
      </div>
      <div class="card">
        <h4 class="font-bold">Italiano</h4>
        <p>Madrelingua o livello eccellente.</p>
      </div>
    `;
    const items = extractMigrosSectionItems(html);
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.some(i => i.includes('3 anni') && i.includes('gestione del personale'))).toBe(true);
  });

  it('strips tooltip overlay noise before extraction', () => {
    const html = `
      <div class="group/tooltip some-tooltip-class">Mansione principale</div>
      <p class="text-pretty">Gestisci il negozio.</p>
    `;
    const items = extractMigrosSectionItems(html);
    // The tooltip should be stripped, only the task text should remain
    expect(items).toHaveLength(1);
    expect(items[0]).toContain('Gestisci il negozio');
  });

  it('filters out generic section headings', () => {
    const html = `
      <h4>Mansioni</h4>
      <h4>Competenze</h4>
      <p class="text-pretty">Lavora in modo autonomo e preciso.</p>
    `;
    const items = extractMigrosSectionItems(html);
    expect(items.every(i => !/^(mansioni|competenze)$/i.test(i.trim()))).toBe(true);
    expect(items.some(i => i.includes('autonomo'))).toBe(true);
  });
});

// ─── Live page shape (jobs.migros.ch, 2026-09-29) ──────────────────────────────
// Minimized from two "Allrounder*in Verkauf" vacancies of Genossenschaft Migros
// Luzern (6742a08c-… and db244148-…): same title, same city, same body — they
// differ only in the overview's workplace card. The share links carry the job
// UUID URL-encoded, which is where the old raw-HTML workload regex read "00%".
function migrosLivePage({ uuid, store, street, zipCity }: { uuid: string; store: string; street: string; zipCity: string }) {
  const share = `https%3A%2F%2Fjobs.migros.ch%2Fde%2Funsere-unternehmen%2Fjob%2Fgenossenschaft-migros-luzern%2Fallrounderin-verkauf%2F${uuid}%3Futm_source%3Djobsharing`;
  return `
<script type="application/ld+json">{"@context":"https://schema.org/","@type":"JobPosting","title":"Allrounder*in Verkauf","description":"Gestalte das Einkaufserlebnis in der Migros mit!","workHours":"80% - 100%"}</script>
<section id="overview"><!--[--><div><div class="md:grid md:grid-cols-8 gap-grid print:!block"><div class="col-span-5"><div class="typo-body1">Gestalte das Einkaufserlebnis in der Migros mit! Als Allrounder*in Verkauf berätst du unsere Kundschaft.</div><div class="flex flex-wrap gap-6 mt-4 print:hidden"><div class="relative inline-block"><button class="link typo-body1 !font-bold"><span>Teilen</span></button><div class="bg-white absolute top-full left-0 z-50 border min-w-[220px]" style="display:none;"><ul class="grid ad-share-list"><li><a href="mailto:?body=${share}%26utm_medium%3Demail" target="_blank" class="link"><span>E-Mail</span></a></li></ul></div></div></div></div><div class="col-span-3 grid gap-6 mt-6 md:mt-0"><!--[--><div><!----><a class="typo-body1 flex-1 p-4 border group-link" href="https://www.google.com/maps/dir/?api=1&amp;destination=${street}, ${zipCity}" target="_blank"><address class="not-italic"><!--[--><p class="font-bold">Genossenschaft Migros Luzern</p><p>${store}</p><!--]--><div>${street}</div><!----><div><span>${zipCity}</span></div></address><span class="link with-arrow font-bold inline-block mt-4 print:hidden">Route berechnen</span></a></div><!--]--></div></div><div class="typo-body1 bg-gray-100 p-4 md:p-8 print:p-0 print:bg-transparent mt-container-gap"><h3 class="typo-headline2 mb-4 print:mb-1">Wichtige Hinweise</h3><div><!--[--><!--[--><p class="mt-4 print:mt-1">Bewerbungen werden nur mit vollständigem Dossier inkl. Arbeitszeugnisse und Diplome berücksichtigt. </p><!--]--><!--]--></div></div><div class="flicking-viewport job-ad-media my-container-gap print:hidden"><div class="flicking-camera"></div></div></div><!--]--></section>
<section id="tasks"><p class="text-pretty">Warendisposition, -präsentation und -pflege</p><p class="text-pretty">Qualitäts-, Data- und Frischekontrolle</p></section>
<section id="skills"><h4>Erste Berufserfahrung von Vorteil</h4><p>im Detailhandel</p></section>
<section id="benefits"><h4>Cumulus-Punkte</h4><p>Du sammelst zusätzliche Cumulus-Punkte im Bereich Food und Non Food</p></section>
<section id="recruitment"><!--[--><div><div><h3>Bewerbung &amp; Kontakt</h3><figure><img src="https://example.invalid/contact.jpg"></figure><div><p>Selina Blumenthal</p><p></p></div></div><div><h3>Rekrutierungsprozess</h3><div><details><summary><div><div>Vorselektion der Bewerbungen</div></div></summary><div><div>Eingegangene Bewerbungen prüfen wir laufend.

Dauer bis Rückmeldung: Bis zu drei Wochen</div></div></details><details><summary><div><div>Fachgespräch</div></div></summary><div><div>Kenntnisse werden durch die Führungsperson abgefragt.</div></div></details></div></div></div><!--]--></section>`;
}

describe('migros-job-parser / live overview blocks (audit-parser-quality issue 5253)', () => {
  const wurzenbach = extractMigrosStructuredData(migrosLivePage({
    uuid: '6742a08c-0d7a-4936-8cae-1ca7cf0c1b00',
    store: 'M Würzenbachstrasse Luzern',
    street: 'Würzenbachstrasse  19',
    zipCity: '6006 Luzern',
  }))!;
  const grossmatte = extractMigrosStructuredData(migrosLivePage({
    uuid: 'db244148-aa13-400f-a02f-585bb86eadc2',
    store: 'M Grossmatte Luzern',
    street: 'Luzernerstrasse 143',
    zipCity: '6014 Luzern',
  }))!;

  it('publishes the store of the workplace card, so two same-title openings in one city stay distinct', () => {
    expect(wurzenbach.workplaces).toEqual([
      'Genossenschaft Migros Luzern, M Würzenbachstrasse Luzern, Würzenbachstrasse 19, 6006 Luzern',
    ]);
    expect(wurzenbach.description).toContain('**Luogo di lavoro:** Genossenschaft Migros Luzern, M Würzenbachstrasse Luzern');
    expect(grossmatte.description).toContain('M Grossmatte Luzern, Luzernerstrasse 143, 6014 Luzern');
    expect(wurzenbach.description).not.toBe(grossmatte.description);
  });

  it('reads the workload from JobPosting.workHours, never from the URL-encoded share links', () => {
    expect(wurzenbach.workPercentage).toBe('80-100%');
    expect(grossmatte.workPercentage).toBe('80-100%');
    expect(wurzenbach.description).toContain('**Grado di occupazione:** 80-100%');
    expect(wurzenbach.description).not.toMatch(/Grado di occupazione:\*\* 00%/);
  });

  it('keeps the overview notice box that belongs to the vacancy', () => {
    expect(wurzenbach.description).toContain('## Wichtige Hinweise\nBewerbungen werden nur mit vollständigem Dossier');
  });

  it('renders the recruitment process as bullets instead of one inline heading', () => {
    expect(wurzenbach.recruitmentText).toBe([
      '**Bewerbung & Kontakt**',
      'Selina Blumenthal',
      '',
      '**Rekrutierungsprozess**',
      '',
      '- Vorselektion der Bewerbungen: Eingegangene Bewerbungen prüfen wir laufend. Dauer bis Rückmeldung: Bis zu drei Wochen',
      '- Fachgespräch: Kenntnisse werden durch die Führungsperson abgefragt.',
    ].join('\n'));
    expect(wurzenbach.description).not.toMatch(/## Bewerbung/);
  });

  it('extracts nothing when the overview has no workplace card', () => {
    expect(extractMigrosWorkplaces('<div class="typo-body1">Intro.</div>')).toEqual([]);
    expect(migrosRecruitmentToMarkdown('<div class="recruitment-info">Invia la candidatura online.</div>')).toBe('Invia la candidatura online.');
  });
});
