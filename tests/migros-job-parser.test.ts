/**
 * Tests for scripts/lib/migros-job-parser.mjs
 *
 * Verifies that extractMigrosStructuredData correctly parses Migros SSR
 * job pages and returns the full description including responsibilities,
 * requirements, and benefits sections — not just the brief overview
 * that appears in the JSON-LD JobPosting.
 */
import { describe, expect, it } from 'vitest';
import { extractMigrosStructuredData, extractMigrosSectionItems } from '../scripts/lib/migros-job-parser.mjs';

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
