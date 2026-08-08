/**
 * Regex boundary invariants for the profession/sector taxonomies (#5203, #5204, #5205).
 *
 * The coverage-gap issues were not a crawler problem: they were a regex
 * boundary problem that made whole professions unmatchable against titles
 * that were sitting in the corpus the whole time.
 *
 * Three defect classes, each pinned in BOTH directions here — the must-match
 * cases are verbatim titles from `data/jobs.json`, the must-NOT-match cases
 * are the verbatim titles that the naive repair would have wrongly swept in:
 *
 *  A. trailing `\b` after a group of PREFIX stems voids every stem in it
 *     (`/\b(autist|…)\b/` cannot match "Autista").
 *  B. leading `\b` before a stem blocks German compounds
 *     (`/\boptiker/` cannot match "Augenoptiker").
 *  C. literal multi-word phrases break on Italian gender-inclusive slashes
 *     ("Operatore/trice socio sanitario/a") and on closed compounds
 *     ("Operatori Sociosanitari").
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as np from 'node:path';

import {
  aggregateProfessionJobs,
  _resetProfessionJobsAggregateCache,
} from '../build-plugins/professionJobsAggregate';
import { SECTOR_MATCHERS, jobMatchesSector } from '../build-plugins/jobSectorLanding';
import { ROLE_COMBO_MATCHERS } from '../build-plugins/jobsSeoPagesPlugin';

/**
 * Build a throwaway rootDir holding a `data/jobs.json` of TI jobs with the
 * given titles, and return the per-profession snapshot the real aggregator
 * derives from it. Goes through the production code path (matcher + exclude)
 * rather than reaching into the matcher table, which is deliberately private.
 */
function snapshotForTitles(titles: readonly string[]) {
  const dir = fs.mkdtempSync(np.join(os.tmpdir(), 'prof-matcher-'));
  fs.mkdirSync(np.join(dir, 'data'), { recursive: true });
  const jobs = titles.map((title, i) => ({
    id: `job-${i}`,
    slug: `job-${i}`,
    title,
    // canton TI so aggregateProfessionJobs (which pins to TI) keeps them
    canton: 'TI',
    location: 'Lugano',
    addressLocality: 'Lugano',
    company: 'Test SA',
    postedDate: new Date().toISOString(),
  }));
  fs.writeFileSync(np.join(dir, 'data', 'jobs.json'), JSON.stringify(jobs));
  _resetProfessionJobsAggregateCache();
  return aggregateProfessionJobs(dir);
}

/** liveCount for `id` when the corpus is exactly `titles`. */
function countFor(id: string, titles: readonly string[]): number {
  const snap = snapshotForTitles(titles) as Record<string, { liveCount: number }>;
  return snap[id]?.liveCount ?? 0;
}

beforeEach(() => {
  _resetProfessionJobsAggregateCache();
});

describe('defect A — a trailing \\b voids prefix stems', () => {
  // Every title here is verbatim from data/jobs.json and matched NOTHING
  // before the fix.
  const MUST_MATCH: ReadonlyArray<readonly [string, string]> = [
    ['autista', 'Autista Camion con Gru'],
    ['autista', 'Autista furgone con gru – patente B'],
    ['autista', "autisti/e veicoli leggeri o speciali presso l'Amministrazione comunale"],
    ['autista', 'Chauffeure/Chauffeuse'],
    ['autista', 'ChauffeurIn Kat. C'],
    ['operaio', 'Operaio/a di produzione'],
    ['operaio', 'Operaio Polimeccanico AFC'],
    ['operaio', 'Produktionsmitarbeiter:in 80-100%'],
    ['operaio', 'Lagermitarbeiter:in Warenausgang'],
    ['operaio', 'Tornitore'],
    ['operaio', 'Fresatore'],
    ['impiegato', 'Impiegato/a amministrativo/a'],
    ['impiegato', 'Impiegato/a di commercio AFC'],
    ['impiegato', 'Kaufmännische:r Mitarbeiter:in Aftersales (m/w/d)'],
    ['impiegato', 'Sekretariatsmitarbeiter/in 70%'],
    ['cuoco', 'Cuoco/a e/o Cuoco/a in dietetica'],
    ['cuoco', 'Cuochi'],
    ['cuoco', 'Cuoca/o'],
    ['cuoco', 'Pizzaiolo im Stundenlohn, Kilchberg'],
    ['cameriere', 'Camerieri di sala'],
    ['cameriere', 'Kellnerin 60%'],
    ['architetto', 'Architetti per studio di progettazione'],
    ['architetto', 'Architetta SIA 80-100%'],
  ];

  for (const [id, title] of MUST_MATCH) {
    it(`${id} matches ${JSON.stringify(title)}`, () => {
      expect(countFor(id, [title])).toBe(1);
    });
  }
});

describe('defect A — but the trailing \\b is load-bearing for WHOLE words', () => {
  // These are the false positives a blanket "drop the trailing \b" would
  // create. All verbatim from data/jobs.json. `engineer` and `cook` are whole
  // words, not stems: "Engineering" is a field and "Cookie" is not a kitchen.
  const MUST_NOT_MATCH: ReadonlyArray<readonly [string, string]> = [
    ['ingegnere', 'Software Engineering Internship - AI Platform'],
    ['ingegnere', '(80 - 100%) Engineering Change Manager Service'],
    ['ingegnere', 'QA Engineering Manager (a), 100%'],
    ['ingegnere', 'Engineering Planner (m/f/d)'],
    ['ingegnere', 'Zeichner:in Ingenieurbau EFZ (alle)'],
    ['cuoco', 'Manager für Cookie-Einwilligungen'],
    ['cuoco', 'Gestore consenso ai cookie'],
    ['cuoco', 'Gestionnaire de consentements pour les cookies'],
    ['architetto', 'Leiter:in Solution Architektur 80–100 %'],
    ['architetto', 'Praktikum im Bereich Architektur 80 - 100%'],
    ['architetto', 'Dottorato di Ricerca in Architettura e Studi Ambientali'],
  ];

  for (const [id, title] of MUST_NOT_MATCH) {
    it(`${id} does NOT match ${JSON.stringify(title)}`, () => {
      expect(countFor(id, [title])).toBe(0);
    });
  }

  it('ingegnere still matches the role noun itself', () => {
    expect(countFor('ingegnere', ['Ingegnere Elettronico / Telecomunicazione'])).toBe(1);
    expect(countFor('ingegnere', ['Software Engineer 80-100%'])).toBe(1);
  });

  it('cuoco still matches the whole-word kitchen roles', () => {
    expect(countFor('cuoco', ['Koch 100%'])).toBe(1);
    expect(countFor('cuoco', ['Chef de partie'])).toBe(1);
  });
});

describe('defect B — a leading \\b blocks German compounds', () => {
  const MUST_MATCH: ReadonlyArray<readonly [string, string]> = [
    ['ottico-optometrista', 'Augenoptiker (w/m/d)'],
    ['ottico-optometrista', 'Augenoptikerin / Augenoptiker Augenklinik 50-80%'],
    ['ottico-optometrista', 'Ausbildung Augenoptiker EFZ (w/m/d)'],
    ['saldatore', 'Aluminiumschweisser:in'],
  ];

  for (const [id, title] of MUST_MATCH) {
    it(`${id} matches ${JSON.stringify(title)}`, () => {
      expect(countFor(id, [title])).toBe(1);
    });
  }

  it('ottico-optometrista still rejects the optics-adjective false positives', () => {
    // The `exclude` list must survive the boundary loosening.
    expect(countFor('ottico-optometrista', ['Ricercatore in fibra ottica'])).toBe(0);
    expect(countFor('ottico-optometrista', ['PostDoc sensore ottico laser'])).toBe(0);
  });
});

describe('defect C — IT gender-inclusive slashes and closed compounds', () => {
  const MUST_MATCH: ReadonlyArray<readonly [string, string]> = [
    ['oss', 'Operatore/trice socio sanitario/a'],
    ['oss', 'Operatore/trice sociosanitario/a'],
    ['oss', 'Operatori Sociosanitari'],
    ['tecnico-radiologia', 'Tecnico/a di radiologia medica'],
    ['tecnico-radiologia', 'Tecnici / tecniche di radiologia (50-100%)'],
  ];

  for (const [id, title] of MUST_MATCH) {
    it(`${id} matches ${JSON.stringify(title)}`, () => {
      expect(countFor(id, [title])).toBe(1);
    });
  }

  it('tecnico-radiologia still rejects the physician titles', () => {
    // "Medico radiologo" is an MD, not a TRM — the exclude must still bite.
    expect(countFor('tecnico-radiologia', ['Medico radiologo'])).toBe(0);
  });
});

describe('defect D — missing alias forms, not a boundary bug (#5413)', () => {
  // TI profession landings at 0 live matches even though the corpus held
  // real TI jobs the whole time — the matcher just didn't know the official
  // Swiss job-title forms these employers use. Titles verbatim from the
  // live corpus (Pro Senectute Ticino e Moesano, EOC).
  const MUST_MATCH: ReadonlyArray<readonly [string, string]> = [
    ['assistente-sociale', 'Concorso generale 2025 Assistenti Sociali'],
    ['assistente-sociale', 'Assistente Sociale'],
    ['cameriere', 'Impiegato/a della ristorazione'],
    ['cameriere', 'Collaboratore/trice di ristorazione'],
    ['cameriere', 'Collaboratrice della ristorazione'],
  ];

  for (const [id, title] of MUST_MATCH) {
    it(`${id} matches ${JSON.stringify(title)}`, () => {
      expect(countFor(id, [title])).toBe(1);
    });
  }

  const MUST_NOT_MATCH: ReadonlyArray<readonly [string, string]> = [
    ['cameriere', 'Ausiliario/a ristorazione'],
    ['cameriere', 'Assistant Restaurant Manager'],
  ];

  for (const [id, title] of MUST_NOT_MATCH) {
    it(`${id} does NOT match ${JSON.stringify(title)}`, () => {
      expect(countFor(id, [title])).toBe(0);
    });
  }
});

describe('sector taxonomy — SECTOR_MATCHERS.oss (#5203)', () => {
  const match = (title: string) => jobMatchesSector({ title } as never, 'oss');

  it('matches the gender-inclusive slash form', () => {
    expect(match('Operatore/trice socio sanitario/a')).toBe(true);
  });

  it('matches the closed compound form', () => {
    expect(match('Operatori Sociosanitari')).toBe(true);
    expect(match('Operatore/trice sociosanitario/a')).toBe(true);
  });

  it('keeps matching the plain forms it always did', () => {
    expect(match('Operatore socio sanitario')).toBe(true);
    expect(match('Operatore socio assistenziale')).toBe(true);
    expect(match('Pflegehelfer 80%')).toBe(true);
    expect(match('Aide-soignant 100%')).toBe(true);
  });

  it('does not match unrelated titles', () => {
    expect(match('Ingegnere civile')).toBe(false);
    expect(match('Consulente previdenziale')).toBe(false);
  });
});

describe('sibling taxonomy — ROLE_COMBO_MATCHERS (/{ruolo}-ticino/ combo pages)', () => {
  // Third table with the same defect, found by sweeping the repo for the
  // `\b(…)\b` shape. It drives an indexed SEO surface, so it is funnel-critical
  // and gets fixed in the same pass rather than left owed.
  const byKey = new Map(ROLE_COMBO_MATCHERS.map((r) => [r.key, r.match]));
  const m = (key: string, title: string) => byKey.get(key)!.test(title);

  const MUST_MATCH: ReadonlyArray<readonly [string, string]> = [
    // Italian plurals — none of these matched before.
    ['infermiere', 'Infermieri'],
    ['infermiere', 'Concorso generale 2026 Infermieri'],
    ['medico', 'Medici assistenti in formazione (Medicina interna)'],
    ['autista', "autisti/e veicoli leggeri o speciali presso l'Amministrazione comunale"],
    ['cuoco', 'Cuochi'],
    ['meccanico', 'Meccanici di manutenzione'],
    ['elettricista', 'Elettricisti di cantiere'],
    ['piastrellista', 'Muratori e piastrellisti'],
    // German feminine / compound forms.
    ['medico', 'Oberarzt Innere Medizin'],
    ['medico', 'Fachärztin Radiologie'],
    ['infermiere', 'Krankenpflegerin 80%'],
    ['infermiere', 'Pflegefachfrau HF'],
    ['elettricista', 'Elektroinstallateur EFZ'],
    ['cuoco', 'Köchin 100%'],
    ['educatore', 'Erzieherin Kita'],
    ['vendita', 'Verkäuferin Teilzeit'],
  ];

  for (const [key, title] of MUST_MATCH) {
    it(`${key} matches ${JSON.stringify(title)}`, () => {
      expect(m(key, title)).toBe(true);
    });
  }

  // The false positives the loose-stem repair introduced, measured on the
  // corpus and then tightened back out. These must stay out.
  const MUST_NOT_MATCH: ReadonlyArray<readonly [string, string]> = [
    ['infermiere', 'Stage servizio infermieristico'],
    ['infermiere', 'Assistente di studio medico (servizio infermieristico)'],
    ['contabile', 'Impiegato/a amministrativo/a per il Servizio Centrale di Contabilità e Fatturazione'],
    ['cuoco', 'Manager für Cookie-Einwilligungen'],
    ['cuoco', 'Mitarbeiter Kocherei'],
  ];

  for (const [key, title] of MUST_NOT_MATCH) {
    it(`${key} does NOT match ${JSON.stringify(title)}`, () => {
      expect(m(key, title)).toBe(false);
    });
  }

  it('keeps every key it had before', () => {
    expect(ROLE_COMBO_MATCHERS.map((r) => r.key)).toEqual([
      'medico', 'infermiere', 'autista', 'cuoco', 'piastrellista',
      'elettricista', 'vendita', 'educatore', 'contabile', 'meccanico',
    ]);
  });
});

describe('the boundary invariant, stated structurally', () => {
  // A stem is a prefix: whatever inflection follows, it must still match.
  // This is the property the trailing `\b` silently destroyed, so assert it
  // directly on the sector table too — those regexes are exported.
  const STEM_CASES: ReadonlyArray<readonly [keyof typeof SECTOR_MATCHERS, readonly string[]]> = [
    ['infermieri', ['Infermiere', 'Infermiera', 'Infermieri diplomati']],
    ['camerieri', ['Cameriere di sala', 'Cameriera', 'Camerieri']],
    ['agricoltura', ['Operaio agricolo', 'Agricoltore', 'Giardiniere']],
    ['sicurezza', ['Agente di sicurezza privata', 'Security guard']],
  ];

  for (const [sector, titles] of STEM_CASES) {
    for (const title of titles) {
      it(`sector ${String(sector)} matches inflected form ${JSON.stringify(title)}`, () => {
        expect(SECTOR_MATCHERS[sector].test(title)).toBe(true);
      });
    }
  }
});
