import { describe, it, expect } from 'vitest';
import {
  htmlToMarkdown,
  validateLaFonteDescription,
} from '../scripts/lib/lafonte-job-parser.mjs';

// ──────────────────────────────────────────────────────────────
// Real fixture: Operatore/trice socioassistenziale 60%
// Contains <p> paragraphs, <ul>/<li> requirement lists, <span>
// ──────────────────────────────────────────────────────────────

const FIXTURE_OPERATORE = `<p>&nbsp;</p>
<p style="text-align: justify;"><span>Obiettivo della funzione è assicurare l'accompagnamento dei sei residenti del foyer Fonte 6 nelle attività della vita quotidiana, curando con loro una relazione rispettosa, professionale, di fiducia e seguendo gli obiettivi e le modalità di intervento definiti nei rispettivi Piani di sviluppo individuale.</span></p>
<p><span>Requisiti:</span></p>
<ul>
<li><span>rispetto a candidati/e con formazione a livello secondario II in ambito sociale, è richiesta un'esperienza lavorativa di almeno tre anni e la disponibilità a seguire una formazione certificata in accompagnamento socioprofessionale</span></li>
<li><span>esperienza certificata in ambito socio-assistenziale</span></li>
<li><span>competenze sociali</span></li>
<li><span>buone capacità organizzative</span></li>
<li><span>disponibilità al lavoro a turni (mattina, sera e weekend)</span></li>
</ul>
<p><span>Condizioni:</span></p>
<ul>
<li><span>contratto a tempo indeterminato</span></li>
<li><span>retribuzione secondo il CCL socio-assistenziale</span></li>
</ul>`;

// ──────────────────────────────────────────────────────────────
// Real fixture: Contabile 50-70%
// Contains detailed task list with mixed formatting
// ──────────────────────────────────────────────────────────────

const FIXTURE_CONTABILE = `<p>&nbsp;</p>
<p><span>Il posto di lavoro è presso la nostra amministrazione in via Giacometti a Lugano. I principali compiti sono:</span></p>
<ul>
<li><span style="color: #000000;">assicurare la gestione amministrativa e la retribuzione dei dipendenti (ca. 110 collaboratrici/tori incl. supplenti e personale in formazione), occupandosi della preparazione dei contratti, dell'elaborazione dei conteggi mensili, del calcolo dei contributi e imposte inclusa la riconciliazione di fine anno, dei rapporti con le autorità fiscali e delle casse previdenziali nonché assicurative</span></li>
<li><span>fornire supporto nella gestione del budget, nella pianificazione e nel controlling, garantendo un'accurata reportistica e un monitoraggio finanziario costante</span></li>
<li><span>gestire la contabilità attiva e passiva (registrazione fatture, gestione debitori e creditori, scadenziari, pagamenti), assicurando la conformità con le normative fiscali e contabili vigenti</span></li>
<li><span>collaborare nella chiusura annuale dei conti</span></li>
</ul>
<p><span>Requisiti:</span></p>
<ul>
<li><span>formazione specifica ed esperienza consolidata nella gestione dei salari (idealmente con conoscenza del sistema Abacus)</span></li>
<li><span>solide competenze in contabilità generale</span></li>
<li><span>buone capacità organizzative e precisione nei dettagli</span></li>
<li><span>capacità di lavorare in autonomia e in team</span></li>
<li><span>madrelingua italiana con buona conoscenza del tedesco e/o francese</span></li>
</ul>
<p><span>Condizioni:</span></p>
<ul>
<li><span>contratto a tempo indeterminato</span></li>
<li><span>retribuzione secondo il CCL socio-assistenziale</span></li>
<li><span>inizio: da concordare</span></li>
</ul>`;

// ──────────────────────────────────────────────────────────────
// Real fixture: Apprendisti/e OSA AFC
// ──────────────────────────────────────────────────────────────

const FIXTURE_APPRENDISTI = `<p>&nbsp;</p>
<p><span lang="IT-CH">Nel corso dei tre anni di formazione potrai raggiungere gli obiettivi fissati dall'ordinanza sulla formazione di operatori/trici OSA, indirizzo persone con disabilità. </span><span>Le/gli apprendiste/i fanno parte del team di presa in carico dei residenti e, affiancati da un responsabile pratico, sviluppano le proprie competenze attraverso il progressivo svolgimento delle mansioni previste dal curriculum formativo. </span><span lang="IT-CH">È possibile svolgere l'apprendistato presso una delle strutture abitative (Fonte 3 a Neggio, Fonte 6 ad Agno o Fonte 8 a Lugano).</span></p>
<p><span>Requisiti:</span></p>
<ul>
<li><span>Assolvimento della scuola dell'obbligo</span></li>
<li><span>Interesse per il settore socio-assistenziale</span></li>
<li><span>Attitudine al lavoro in team</span></li>
<li><span>Buone competenze relazionali e comunicative</span></li>
</ul>
<p><span>Condizioni:</span></p>
<ul>
<li><span>contratto di apprendistato triennale</span></li>
<li><span>formazione presso la scuola professionale SSPSS</span></li>
<li><span>accompagnamento da parte di un formatore pratico qualificato</span></li>
</ul>`;

// ──────────────────────────────────────────────────────────────
// htmlToMarkdown tests
// ──────────────────────────────────────────────────────────────

describe('htmlToMarkdown — La Fonte card descriptions', () => {
  it('converts Operatore card to markdown with bullets', () => {
    const { markdown, bulletCount, sourceTextLength } = htmlToMarkdown(FIXTURE_OPERATORE);

    expect(markdown.length).toBeGreaterThanOrEqual(350);
    expect(sourceTextLength).toBeGreaterThan(0);

    // Should contain bullet items from <ul>/<li>
    expect(bulletCount).toBeGreaterThanOrEqual(5);
    expect(markdown).toContain('- rispetto a candidati/e con formazione');
    expect(markdown).toContain('- esperienza certificata in ambito');
    expect(markdown).toContain('- competenze sociali');
    expect(markdown).toContain('- disponibilità al lavoro a turni');

    // Should have section labels
    expect(markdown).toContain('Requisiti:');
    expect(markdown).toContain('Condizioni:');

    // No raw HTML
    expect(markdown).not.toMatch(/<[a-z][a-z0-9]*[\s>]/i);
  });

  it('converts Contabile card with detailed task list', () => {
    const { markdown, bulletCount } = htmlToMarkdown(FIXTURE_CONTABILE);

    expect(markdown.length).toBeGreaterThanOrEqual(400);
    expect(bulletCount).toBeGreaterThanOrEqual(8);

    // Task list items
    expect(markdown).toContain('- assicurare la gestione amministrativa');
    expect(markdown).toContain('- fornire supporto nella gestione del budget');
    expect(markdown).toContain('- gestire la contabilità attiva e passiva');

    // Requirement items
    expect(markdown).toContain('- formazione specifica ed esperienza');
    expect(markdown).toContain('- madrelingua italiana');

    expect(markdown).not.toMatch(/<[a-z][a-z0-9]*[\s>]/i);
  });

  it('converts Apprendisti card with multi-lang spans', () => {
    const { markdown, bulletCount } = htmlToMarkdown(FIXTURE_APPRENDISTI);

    expect(markdown.length).toBeGreaterThanOrEqual(350);
    expect(bulletCount).toBeGreaterThanOrEqual(4);

    // Intro text preserved
    expect(markdown).toContain('Nel corso dei tre anni di formazione');
    expect(markdown).toContain('indirizzo persone con disabilità');

    // Requirements
    expect(markdown).toContain('- Assolvimento della scuola dell\'obbligo');
    expect(markdown).toContain('- Interesse per il settore socio-assistenziale');

    // Conditions
    expect(markdown).toContain('- contratto di apprendistato triennale');

    expect(markdown).not.toMatch(/<[a-z][a-z0-9]*[\s>]/i);
  });

  it('preserves emphasis formatting', () => {
    const html = '<p>Visita <em>La Fattoria</em> a Vaglio o <em>Il Fornaio</em> a Lugano.</p>';
    const { markdown } = htmlToMarkdown(html);
    expect(markdown).toContain('*La Fattoria*');
    expect(markdown).toContain('*Il Fornaio*');
  });

  it('preserves bold formatting', () => {
    const html = '<p><strong>Importante:</strong> candidarsi entro il 15 marzo.</p>';
    const { markdown } = htmlToMarkdown(html);
    expect(markdown).toContain('**Importante:**');
  });
});

// ──────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────

describe('htmlToMarkdown — edge cases', () => {
  it('handles empty input', () => {
    const result = htmlToMarkdown('');
    expect(result.markdown).toBe('');
    expect(result.sourceTextLength).toBe(0);
  });

  it('handles plain text', () => {
    const { markdown } = htmlToMarkdown('Just text');
    expect(markdown).toBe('Just text');
  });

  it('strips empty paragraphs with &nbsp;', () => {
    const { markdown } = htmlToMarkdown('<p>&nbsp;</p><p>Real content</p>');
    expect(markdown).not.toMatch(/^\s*$/m);
    expect(markdown).toContain('Real content');
  });

  it('converts short bold-only paragraphs to headings', () => {
    const html = '<p><strong>Requisiti:</strong></p><p>Dettagli qui.</p>';
    const { markdown, headingCount } = htmlToMarkdown(html);
    expect(headingCount).toBe(1);
    expect(markdown).toContain('## Requisiti:');
  });

  it('does NOT convert long bold paragraphs to headings', () => {
    const longText = 'Questo è un paragrafo molto lungo che non dovrebbe diventare un heading';
    const html = `<p><strong>${longText}</strong></p>`;
    const { markdown, headingCount } = htmlToMarkdown(html);
    expect(headingCount).toBe(0);
    expect(markdown).toContain(`**${longText}**`);
  });

  it('handles <h3> headings', () => {
    const html = '<h3>Sezione importante</h3><p>Contenuto.</p>';
    const { markdown, headingCount } = htmlToMarkdown(html);
    expect(headingCount).toBe(1);
    expect(markdown).toContain('## Sezione importante');
  });

  it('handles ordered lists', () => {
    const html = '<ol><li>Primo</li><li>Secondo</li></ol>';
    const { markdown } = htmlToMarkdown(html);
    expect(markdown).toContain('1. Primo');
    expect(markdown).toContain('2. Secondo');
  });

  it('handles links', () => {
    const html = '<p>Contatta <a href="mailto:info@lafonte.ch">info@lafonte.ch</a></p>';
    const { markdown } = htmlToMarkdown(html);
    expect(markdown).toContain('[info@lafonte.ch](mailto:info@lafonte.ch)');
  });
});

// ──────────────────────────────────────────────────────────────
// validateLaFonteDescription
// ──────────────────────────────────────────────────────────────

describe('validateLaFonteDescription', () => {
  it('passes for Operatore description', () => {
    const detail = htmlToMarkdown(FIXTURE_OPERATORE);
    const { ok, warnings } = validateLaFonteDescription(detail);
    expect(ok).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('passes for Contabile description', () => {
    const detail = htmlToMarkdown(FIXTURE_CONTABILE);
    const { ok, warnings } = validateLaFonteDescription(detail);
    expect(ok).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('passes for Apprendisti description', () => {
    const detail = htmlToMarkdown(FIXTURE_APPRENDISTI);
    const { ok, warnings } = validateLaFonteDescription(detail);
    expect(ok).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('fails for too-short description', () => {
    const detail = { markdown: 'Short.', sourceTextLength: 50, headingCount: 0, bulletCount: 0 };
    const { ok, warnings } = validateLaFonteDescription(detail);
    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('too short'))).toBe(true);
  });

  it('fails for low source ratio', () => {
    const detail = { markdown: 'A'.repeat(360), sourceTextLength: 5000, headingCount: 0, bulletCount: 0 };
    const { ok, warnings } = validateLaFonteDescription(detail);
    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('ratio too low'))).toBe(true);
  });

  it('warns when too few text blocks on substantial source', () => {
    const detail = { markdown: 'Single block of text with no breaks at all.'.repeat(10), sourceTextLength: 500, headingCount: 0, bulletCount: 0 };
    const { ok, warnings } = validateLaFonteDescription(detail);
    expect(ok).toBe(false);
    expect(warnings.some((w) => w.includes('Too few text blocks'))).toBe(true);
  });

  it('accepts with custom thresholds', () => {
    const detail = { markdown: 'A'.repeat(200), sourceTextLength: 200, headingCount: 0, bulletCount: 0 };
    const { ok } = validateLaFonteDescription(detail, 100, 0.1);
    expect(ok).toBe(true);
  });
});
