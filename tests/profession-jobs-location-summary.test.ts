import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderProfessionJobsLocationSummary,
  type ProfessionLocationJob,
} from '../build-plugins/shared/professionJobsLocationSummary';
import {
  emitProfessionLandingPages,
} from '../build-plugins/professionLandingsPlugin';
import {
  _resetProfessionJobsAggregateCache,
} from '../build-plugins/professionJobsAggregate';
import {
  buildProfessionLandingPath,
  PROFESSION_LOCALES,
} from '../build-plugins/professionLandingsData';
import { buildProfessionLandingFaqs } from '../build-plugins/professionLandingsCopy';
import { fingerprintPage, scoreCohorts } from '../scripts/lib/informationGain.mjs';

const job = (
  city: string,
  company: string,
  companyKey = company,
): ProfessionLocationJob => ({ city, addressLocality: city, company, companyKey });

describe('riepilogo annunci per località', () => {
  it('mostra al massimo tre località, con datori ordinati per frequenza', () => {
    const html = renderProfessionJobsLocationSummary('it', [
      job('Lugano', 'Azienda Alfa'),
      job('Lugano', 'Azienda Alfa'),
      job('Bellinzona', 'Impresa Beta'),
      job('Bellinzona', 'Cooperativa Gamma'),
      job('Locarno', 'Ditta Delta'),
      job('Mendrisio', 'Ditta Epsilon'),
    ]);

    expect(html).toContain('data-profession-location-summary="1"');
    expect(html).toContain('A Lugano risultano 2 annunci attivi: Azienda Alfa (2).');
    expect(html).toContain('A Bellinzona risultano 2 annunci attivi: Cooperativa Gamma (1) e Impresa Beta (1).');
    expect(html).toContain('Locarno');
    expect(html).not.toContain('Mendrisio');
  });

  it('produce lo stesso ordine anche se cambia l’ordine dei record in ingresso', () => {
    const jobs = [
      job('Bellinzona', 'Impresa Beta'),
      job('Bellinzona', 'Cooperativa Gamma'),
      job('Locarno', 'Ditta Delta'),
      job('Lugano', 'Azienda Alfa'),
      job('Lugano', 'Azienda Alfa'),
    ];

    expect(renderProfessionJobsLocationSummary('it', jobs)).toBe(
      renderProfessionJobsLocationSummary('it', [...jobs].reverse()),
    );
  });

  it('non promette un riepilogo se le schede non hanno una località leggibile', () => {
    expect(
      renderProfessionJobsLocationSummary('it', [
        { city: '', addressLocality: null, company: 'Azienda Alfa' },
      ]),
    ).toBe('');
  });

  it('normalizza i campi preferiti prima del fallback', () => {
    const html = renderProfessionJobsLocationSummary('it', [
      { city: 'Lugano', addressLocality: '  ', company: 'A', companyKey: '  ' },
      { city: 'Lugano', addressLocality: 'Lugano', company: 'B', companyKey: '  ' },
    ]);

    expect(html).toContain('A Lugano risultano 2 annunci attivi: A (1) e B (1).');
    expect(html).not.toContain('A (2)');
  });

  it('localizza titolo, conteggi e provenienza in tutte le lingue pubblicate', () => {
    const jobs = [job('Lugano', 'Azienda Alfa')];
    const expected = {
      it: ['Offerte attive per località', '1 annuncio attivo'],
      en: ['Active openings by location', '1 active opening is listed'],
      de: ['Aktive Stellen nach Ort', '1 aktive Stelle gelistet'],
      fr: ['Offres actives par lieu', '1 offre active est répertoriée'],
    } as const;

    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const html = renderProfessionJobsLocationSummary(locale, jobs);
      expect(html).toContain(expected[locale][0]);
      expect(html).toContain(expected[locale][1]);
      expect(html).toContain('Azienda Alfa');
      expect(html).toContain('data-profession-location-summary');
    }
  });

  it('porta il riepilogo dalla landing emessa a tutti i quattro locali', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profession-location-summary-'));
    const now = Date.now();
    const jobs = Array.from({ length: 7 }, (_, index) => ({
      id: `infermiere-${index + 1}`,
      slug: `infermiere-${index + 1}`,
      title: `Infermiere SSS ${index + 1}`,
      company: `Clinica ${index + 1}`,
      canton: 'TI',
      location: 'Lugano',
      addressLocality: 'Lugano',
      postedDate: new Date(now - index * 86_400_000).toISOString(),
    }));
    const expectedSentence = {
      it: 'A Lugano risultano 7 annunci attivi',
      en: 'In Lugano, 7 active openings are listed',
      de: 'In Lugano sind 7 aktive Stellen gelistet',
      fr: 'À Lugano, 7 offres actives sont répertoriées',
    } as const;

    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'data', 'jobs.json'), JSON.stringify(jobs));
    writeFileSync(join(root, 'data', 'expired-jobs.json'), '[]');

    try {
      _resetProfessionJobsAggregateCache();
      const result = await emitProfessionLandingPages({
        rootDir: root,
        distDir: join(root, 'dist'),
        now,
      });

      expect(result.professionsBelowFloor).not.toContain('infermiere');
      for (const locale of PROFESSION_LOCALES) {
        const path = join(root, 'dist', buildProfessionLandingPath(locale, 'infermiere'), 'index.html');
        const html = readFileSync(path, 'utf-8');
        expect(html).toMatch(/data-profession-location-summary(?:="1"|=1)/u);
        expect(html).toContain(expectedSentence[locale]);
      }
    } finally {
      _resetProfessionJobsAggregateCache();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('aggiunge segmenti che sopravvivono alla maschera dell’identità della pagina', () => {
    const pages = [
      { role: 'infermiere', city: 'Bellinzona', employer: 'Azienda Alfa' },
      { role: 'muratore', city: 'Locarno', employer: 'Impresa Beta' },
    ].map(({ role, city, employer }) => {
      const path = `lavoro-ticino-${role}/index.html`;
      const html = `<!doctype html><html lang="it"><head><title>Lavoro Ticino ${role}</title></head><body>
        <h1>Lavoro in Ticino: ${role}</h1>
        ${renderProfessionJobsLocationSummary('it', [job(city, employer)])}
      </body></html>`;
      return fingerprintPage(path, html);
    });

    const cohort = scoreCohorts(pages, { minCohortPages: 2, includePageScores: true }).cohorts[0];
    expect(cohort.pages).toBe(2);
    expect(cohort.zeroGainPages).toBe(0);
    expect(cohort.pageScores?.every((page) => page.pageSpecific > 0)).toBe(true);
  });
});

describe('FAQ delle landing professionali', () => {
  it('rimuove la risposta G/B con soglie generiche e conserva quattro risposte sostanziali per lingua', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const faqs = buildProfessionLandingFaqs(locale, 'muratore');
      expect(faqs).toHaveLength(4);
      expect(faqs.map(({ question }) => question).join(' ')).not.toMatch(
        /permesso G o il permesso B|G-permit or B-permit|G- oder B-Bewilligung|permis G ou B/i,
      );
      expect(faqs[1].answer).not.toMatch(/Il netto dipende|Net pay depends|Netto-Lohn hängt|Le net dépend/i);
      expect(faqs[3].answer).not.toMatch(/updated weekly|weekly|wöchentlich|chaque semaine/i);
    }
  });
});
