import { describe, it, expect } from 'vitest';
import {
  htmlToMarkdown,
  validateLaFonteDescription,
  buildLaFonteDescription,
  isLaFonteLegacyFrame,
  stripLaFonteLegacyFrame,
  scrubLaFonteLegacyFrame,
  laFonteHasSourceBody,
  laFonteRoleUrl,
} from '../scripts/lib/lafonte-job-parser.mjs';
import { checkSourceDetailsBatch, sourceDetailSamplesForCrawler } from '../scripts/audit-parser-quality.mjs';
import { sourceBodyWordCount } from '../scripts/lib/source-body-floor.mjs';

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

// ──────────────────────────────────────────────────────────────
// Published description = the role card only
// ──────────────────────────────────────────────────────────────

// Card body of "Apprendisti/e operatori/trici socioassistenziali AFC" as the
// page publishes it (lafonte.ch/inizia-con-noi, 2026-09-29).
const APPRENDISTI_BODY = "Nel corso dei tre anni di formazione potrai raggiungere gli obiettivi fissati dall'ordinanza sulla formazione di operatori/trici OSA, indirizzo persone con disabilità. Le/gli apprendiste/i fanno parte del team di presa in carico dei residenti e, affiancati da un responsabile pratico, sviluppano le proprie competenze attraverso il progressivo svolgimento delle mansioni previste dal curriculum formativo. È possibile svolgere l’apprendistato presso le strutture abitative Fonte 3 a Neggio e Fonte 8 a Lugano.\n\nCondizioni:\n\n- maggiore età\n- assolvimento della scolarità obbligatoria\n- spiccato interesse e motivazione all’accompagnamento e assistenza di persone con disabilità\n- titolo preferenziale verrà dato a candidature che hanno già svolto prime esperienze in ambito sociale, quali volontariato, colonie estive, stage d’orientamento\n\nLe/gli interessate/i sono pregate/i di inviare la loro candidatura insieme ad una lettera di presentazione e motivazione, un curriculum vitae e la copia dei certificati di studio via mail a [recruiting@lafonte.ch](mailto:recruiting@lafonte.ch)";
// The same job as the old runner stored it (committed slice): the card body
// inside a frame of sentences and fixed lines that are not on the page, and a
// machine translation of that frame in `en`.
const LEGACY_IT = `## Descrizione\nFondazione La Fonte, con sede a Lugano (TI), è alla ricerca di: Apprendisti/e operatori/trici socioassistenziali AFC.\n\n${APPRENDISTI_BODY}\n\n## Mansioni\n\n**Settore:** Servizi sociali / Assistenza disabilità\n**Sede:** Via A. Giacometti 1, 6900 Lugano (TI), Svizzera\n**Luogo di lavoro:** Lugano e Neggio\n**Candidatura:** recruiting@lafonte.ch`;
const LEGACY_EN = 'Description Fondazione La Fonte, based in Lugano (TI), is looking for: Apprentices in Social Care AFC.\n\nTasks\n\nSector: Social Services / Disability Assistance Location: Via A. Giacometti 1, 6900 Lugano (TI), Switzerland Workplace: Lugano and Neggio Candidatura:AZI@lafonte.ch';

describe('La Fonte published description', () => {
  it('is the card body alone, with no sentence or line the page does not carry', () => {
    expect(buildLaFonteDescription(APPRENDISTI_BODY)).toBe(APPRENDISTI_BODY);
    expect(buildLaFonteDescription(APPRENDISTI_BODY)).not.toMatch(/alla ricerca di:|\*\*Settore:\*\*|Via A\. Giacometti|Contattare/);
  });

  it('is empty for a card without a body — no "Contattare … per i dettagli" filler', () => {
    expect(buildLaFonteDescription('')).toBe('');
    expect(buildLaFonteDescription('Posizione aperta.')).toBe('');
  });

  it('recovers the card body from a description written by the old frame', () => {
    expect(isLaFonteLegacyFrame(LEGACY_IT)).toBe(true);
    expect(isLaFonteLegacyFrame(APPRENDISTI_BODY)).toBe(false);
    expect(stripLaFonteLegacyFrame(LEGACY_IT)).toBe(APPRENDISTI_BODY);
    expect(stripLaFonteLegacyFrame(APPRENDISTI_BODY)).toBe(APPRENDISTI_BODY);
  });

  it('drops the translated frame and keeps real translations when scrubbing a stored job', () => {
    const scrubbed = scrubLaFonteLegacyFrame({
      sourceLang: 'it',
      description: LEGACY_IT,
      descriptionByLocale: {
        it: LEGACY_IT,
        en: LEGACY_EN,
        de: 'Im Laufe der dreijährigen Ausbildung kannst du die Ziele der Verordnung über die Ausbildung zur Fachperson Betreuung erreichen.',
      },
    });
    expect(scrubbed.description).toBe(APPRENDISTI_BODY);
    expect(Object.keys(scrubbed.descriptionByLocale).sort()).toEqual(['de', 'it']);
    expect(scrubbed.descriptionByLocale.it).toBe(APPRENDISTI_BODY);
  });

  it('keeps a job with an empty card only when an earlier run read a body from the page', () => {
    expect(laFonteHasSourceBody({ sourceLang: 'it', description: LEGACY_IT, descriptionByLocale: { it: LEGACY_IT } })).toBe(true);
    const emptyFrame = '## Descrizione\nFondazione La Fonte, con sede a Lugano (TI), è alla ricerca di: Stagiaire.\n\n## Mansioni\nContattare Fondazione La Fonte per i dettagli della posizione.\n\n**Settore:** Servizi sociali / Assistenza disabilità\n**Sede:** Via A. Giacometti 1, 6900 Lugano (TI), Svizzera\n**Candidatura:** recruiting@lafonte.ch';
    expect(laFonteHasSourceBody({ sourceLang: 'it', description: emptyFrame, descriptionByLocale: { it: emptyFrame } })).toBe(false);
  });
});

// Word floor (source-body-floor.mjs): real card text of "Stagiaire"
// (lafonte.ch/inizia-con-noi, 2026-09-29) cut at 49 and 50 words. Both cuts
// are far above the old 100-character gate, which let the 49-word one through.
const STAGIAIRE_CARD_TEXT = "È possibile svolgere uno stage presso una struttura abitativa (Fonte 3 a Neggio o Fonte 8 a Lugano) o presso un laboratorio protetto (La Fattoria a Vaglio, Il Fornaio a Lugano, Lo Spazio Officina ad Agno). Lo stage può avere validità preformativa e prevede l’accompagnamento di persone con disabilità in attività socio-assistenziali e/o lavorative. Condizioni: maggiore età, spiccato interesse e motivazione all’accompagnamento e assistenza di persone con disabilità";
const firstWords = (text: string, n: number) => text.split(' ').slice(0, n).join(' ');

describe('La Fonte source body word floor', () => {
  const body49 = firstWords(STAGIAIRE_CARD_TEXT, 49);
  const body50 = firstWords(STAGIAIRE_CARD_TEXT, 50);

  it('pins the fixture at 49 and 50 words, both over the old character gate', () => {
    expect(sourceBodyWordCount(body49)).toBe(49);
    expect(sourceBodyWordCount(body50)).toBe(50);
    expect(body49.length).toBeGreaterThan(100);
  });

  it('publishes a 50-word card and nothing for a 49-word one', () => {
    expect(buildLaFonteDescription(body49)).toBe('');
    expect(buildLaFonteDescription(body50)).toBe(body50);
  });

  it('keeps a stored body only at 50 words or more', () => {
    expect(laFonteHasSourceBody({ sourceLang: 'it', description: body49, descriptionByLocale: { it: body49 } })).toBe(false);
    expect(laFonteHasSourceBody({ sourceLang: 'it', description: body50, descriptionByLocale: { it: body50 } })).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// The published URL leads to the role card (#5253, run 36571839273)
// ──────────────────────────────────────────────────────────────
// The careers page ignores `?role=`: each value serves the same page,
// canonical /inizia-con-noi, where every role is a card under its <h4>.
describe('laFonteRoleUrl', () => {
  const CAREERS = 'https://www.lafonte.ch/inizia-con-noi';
  const card = (title: string, body: string) => `<div class="pwr-simple-list-item pwr-simple-list-item--text-style-1"><div>Regione del Luganese</div><h4><strong>${title}</strong></h4><span class="pwr-rich-text pwr-simple-list-item__desc"><p>${body}</p></span></div>`;
  const stage = 'È possibile svolgere uno stage presso una struttura abitativa della fondazione, accompagnando i residenti nella vita quotidiana insieme all\'équipe educativa. '.repeat(3);
  const afc = 'La formazione di operatore/trice socioassistenziale AFC dura tre anni e alterna la pratica nei foyer della fondazione alla scuola professionale. '.repeat(3);
  const page = `<html><head><link rel="canonical" href="${CAREERS}"></head><body><h1>Inizia con noi</h1><p>${'La Fonte vuol essere un luogo di apprendimento e di sviluppo. '.repeat(10)}</p>${card('Stagiaire', stage)}${card('Apprendisti/e operatori/trici socioassistenziali AFC', afc)}<footer><h2>Contatti</h2></footer></body></html>`;

  it('keeps the ?role= identity and adds the text fragment of the card title', () => {
    expect(laFonteRoleUrl(CAREERS, 'stagiaire-la-fonte-lugano', 'Stagiaire'))
      .toBe('https://www.lafonte.ch/inizia-con-noi?role=stagiaire-la-fonte-lugano#:~:text=Stagiaire');
    expect(laFonteRoleUrl(CAREERS, 'apprendisti-afc', 'Apprendisti/e operatori/trici socioassistenziali AFC'))
      .toBe('https://www.lafonte.ch/inizia-con-noi?role=apprendisti-afc#:~:text=Apprendisti%2Fe%20operatori%2Ftrici%20socioassistenziali%20AFC');
  });

  it('lets the parser-quality audit read each card as its posting, with a URL that leads there', async () => {
    const jobs = [
      { title: 'Stagiaire', url: laFonteRoleUrl(CAREERS, 'stagiaire-la-fonte-lugano', 'Stagiaire'), location: 'Lugano', sourceLang: 'it', description: stage },
      { title: 'Apprendisti/e operatori/trici socioassistenziali AFC', url: laFonteRoleUrl(CAREERS, 'apprendisti-afc', 'Apprendisti/e operatori/trici socioassistenziali AFC'), location: 'Lugano', sourceLang: 'it', description: afc },
    ];
    const results = await checkSourceDetailsBatch(sourceDetailSamplesForCrawler('la-fonte', jobs), 1, {
      fetchPage: async (url: string) => ({ ok: true, status: 200, url: url.split('#')[0], body: page, host: 'www.lafonte.ch' }),
    });
    for (const result of results) {
      expect(result).toMatchObject({ sourceScope: 'fragment-anchor', sharedBy: 'query', descriptionMismatch: false });
      expect(result.urlAddressesPosting).toBeUndefined();
    }
  });
});
