/**
 * #5312 §3, coda — gli ultimi offender di `audit:h1-title-duplicates`, e il
 * gemello latente accanto a loro.
 *
 * ─── Cosa dice la misura, oggi ──────────────────────────────────────────
 *
 * La baseline committata (`data/h1-title-duplicates-baseline.json`) e' del
 * **2026-07-22** e dichiara 15 offender: `spa-locale` 12, `profession-canton`
 * 2, `spa-other` 1. Da allora:
 *
 *   - il seed FULL-CORPUS del 2026-08-07 (run 31197413400) ne misura **31**
 *     su 2 061 240 pagine — `spa-locale` 24, `spa-other` 5,
 *     `profession-canton` 2. Non e' mai stato committato;
 *   - la PR **#5337** (2026-08-08) ha chiuso **29** duplicati alla fonte, sulle
 *     quattro famiglie di confine + le landing BFS, chiamando
 *     `differentiateH1FromTitle`;
 *   - i 18 run consecutivi di `validate-dist-postbuild` dal 2026-08-09 al
 *     2026-08-13 riportano `passed=true` sempre, con `offendersTotal=0` in 16
 *     run e `=2` in due. A `AUDIT_SAMPLE_RATE=0.25` con salt rotante
 *     (`github.run_number`) sono 18 estrazioni indipendenti: 4 avvistamenti
 *     campionati su 18 estrazioni ⇒ **~1-2 offender full-corpus**. Se fossero
 *     ancora 31, le stesse 18 estrazioni ne avrebbero mostrati ~140.
 *
 * 31 − 29 = 2, e i due residui hanno nome e cognome nel log del seed:
 *
 *     dist/de/arbeit-schaffhausen-optiker-optometrist/index.html
 *     dist/en/jobs-schaffhausen-optician-optometrist/index.html
 *
 * cioe' esattamente la famiglia che #5337 non ha toccato.
 *
 * ─── Perche' succede, e perche' NON e' un problema di copy ──────────────
 *
 * `renderProfessionCantonPage` compone il `<title>` con `composePlaceTitle`,
 * che sceglie il primo candidato entro `TITLE_MAX_CHARS` (66). Il secondo
 * candidato e' `PROFESSION_BRIDGE_COPY[locale].title`, e per due locali quel
 * template e' **byte per byte** lo stesso di `COPY[locale].h1`:
 *
 *     en   `${role} jobs in Canton ${canton}`
 *     de   `${role}-Stellen im Kanton ${canton}`
 *
 * «Optiker optometrist» + «Schaffhausen» porta il `metaTitle` a 67 caratteri:
 * il primo candidato viene scartato, il secondo vince, e la pagina esce con
 * `<title>` === `<h1>`. Nessun headline e' troppo lungo — e' il fallback ad
 * atterrare sulla stessa stringa.
 *
 * Riscrivere i due template curerebbe questa coppia e lascerebbe la CLASSE:
 * qualunque professione o cantone piu' lungo la ricrea. Il rimedio e' quello
 * di #5267/#5337 — differenziare l'H1 a render time, mai il `<title>`
 * (`build-plugins/shared/titleSuffix.ts` vieta di accorciare un headline).
 *
 * ─── La stessa forma vive in ALTRI DUE produttori ───────────────────────
 *
 * `salaryProfessionCantonPages.ts` ha la collisione su **tre** locali su
 * quattro (en/de/fr; solo `it` differisce, per un «nel») e il `metaTitle` piu'
 * lungo di tutta la famiglia — non l'avevo vista, l'ha alzata
 * `check-sibling-patterns.mjs` sul diff di questa PR. Riparata nello stesso
 * giro. Il quarto gemello, `salaryStatsChCantonPages.ts`, la stessa trappola
 * l'aveva gia' chiusa a modo suo (candidato `${h1} · 2026`, col commento che
 * la spiega): li' non c'e' niente da fare.
 *
 * ─── Il gemello: profession-CITY ha lo stesso difetto, spento ───────────
 *
 * `professionCityLandings.ts` ha la stessa cascata e la stessa collisione
 * (`${r} jobs in ${c}` / `${r}-Stellen in ${c}` sono h1 E bridge title). Oggi
 * l'audit misura zero offender li' — non perche' il difetto manchi, ma perche'
 * il `metaTitle` piu' lungo dell'intera famiglia e' di **59 caratteri su 66**
 * (misurato su tutte le combinazioni: «Emploi Technicien radiologie
 * Bellinzona — offres et salaire»). Sette caratteri di margine.
 *
 * Conseguenza da dichiarare, non da nascondere: sul gemello per citta'
 * l'assert COMPORTAMENTALE e' oggi vacuo — togliere la differenziazione dal
 * renderer non fa arrossire niente, verificato per mutazione. Per questo il
 * cablaggio di quella meta' e' pinnato sul SORGENTE finche' non e'
 * osservabile sull'output; il perche' sta accanto a quell'assert.
 *
 * ─── Come questo file si comporta da ratchet ────────────────────────────
 *
 * `data/h1-title-duplicates-baseline.json` e' un ratchet SUL TASSO, e la sua
 * procedura corretta (#5312 §1) e' rigenerarlo con `seed-title-baselines.yml`
 * su un dist reidratato: i denominatori `scanned` devono essere full-corpus,
 * quindi scriverli a mano da un campione al 25 % sarebbe proprio l'errore che
 * quella procedura vieta. Questo test copre l'altra meta', quella che un
 * ratchet non copre mai: non «quanti ce ne sono» ma «da questi tre produttori
 * non ne puo' nascere nessuno», su TUTTO lo spazio delle combinazioni e non
 * su un campione.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderProfessionCantonPage } from '../build-plugins/professionCantonLandings';
import { renderProfessionCityPage } from '../build-plugins/professionCityLandings';
import { renderSalaryProfessionCantonPage } from '../build-plugins/salaryProfessionCantonPages';
import { SALARY_PROFESSION_ELIGIBLE_IDS } from '../build-plugins/salaryProfessionCantonData';
import medians from '../data/profession-salary-medians.json' with { type: 'json' };
import {
  PROFESSION_CANTON_KEYS,
  buildProfessionCantonPath,
} from '../build-plugins/professionCantonData';
import { PROFESSION_CITY_KEYS } from '../build-plugins/professionCityData';
import {
  PROFESSION_IDS,
  PROFESSION_LOCALES,
  ALL_CANTON_PROFESSION_IDS,
  type ProfessionLocale,
} from '../build-plugins/professionLandingsData';
import { PROFESSION_BRIDGE_COPY, professionLabel } from '../build-plugins/shared/professionJobsFloor';
import { getCantonDisplayName } from '../build-plugins/shared/cantonDisplay';

/** Snapshot fittizio, identico per forma a quello di profession-canton-landings.test.ts. */
const SNAP = {
  liveCount: 12,
  fresh30Count: 5,
  medianSalaryChf: 84000,
  featured: [],
  topEmployers: [
    { name: 'Ospedale Regionale', count: 6 },
    { name: 'Clinica Privata SA', count: 3 },
  ],
};

/** Estrae `<title>` e il primo `<h1>`, normalizzati come li normalizza l'audit. */
function titleAndH1(html: string): { title: string; h1: string } {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const h = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const norm = (s: string) =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  return { title: norm(t?.[1] ?? ''), h1: norm(h?.[1] ?? '') };
}

/**
 * L'audit confronta il `<title>` SENZA il suffisso di brand, perche' il
 * suffisso e' l'unica cosa che distingueva title e h1 sui template che
 * spediscono la stessa stringa come entrambi (vedi il docblock di
 * `differentiateH1FromTitle`).
 */
const stripBrand = (s: string) => s.replace(/\s*[|·]\s*frontaliere ticino\s*$/i, '').trim();

describe('il difetto e\' nei template, non nella copy di una pagina', () => {
  /**
   * Su una coppia CORTA il `metaTitle` sta nei 66 caratteri, il fallback non
   * viene mai raggiunto e `differentiateH1FromTitle` e' un no-op: l'H1 emesso
   * e' quindi il template nudo. Confrontarlo col bridge title della stessa
   * coppia mostra la collisione senza doverla dedurre dal sorgente.
   */
  const bareH1 = (locale: ProfessionLocale) =>
    titleAndH1(
      renderProfessionCantonPage({
        locale, cantonKey: 'ZH', id: 'cuoco', snapshot: SNAP, distDir: '',
      }).html,
    ).h1;

  const bridge = (locale: ProfessionLocale) => {
    const role = professionLabel(locale, 'cuoco');
    const canton = getCantonDisplayName('ZH', locale as Parameters<typeof getCantonDisplayName>[1]);
    return PROFESSION_BRIDGE_COPY[locale].title(role, canton).toLowerCase();
  };

  it('de ed en hanno bridge title === h1: sono i due locali che collidono', () => {
    for (const locale of ['de', 'en'] as const) {
      expect(bridge(locale)).toBe(bareH1(locale));
    }
  });

  it('it e fr NON collidono — ed e\' il motivo per cui gli offender misurati sono due, non quattro', () => {
    for (const locale of ['it', 'fr'] as const) {
      expect(bridge(locale)).not.toBe(bareH1(locale));
    }
  });
});

describe('profession-CANTON — nessuna pagina puo\' avere <title> === <h1>', () => {
  it(`copre tutte le combinazioni cantone × professione × locale`, () => {
    const dupes: string[] = [];
    let rendered = 0;
    for (const cantonKey of PROFESSION_CANTON_KEYS) {
      for (const id of ALL_CANTON_PROFESSION_IDS) {
        for (const locale of PROFESSION_LOCALES as readonly ProfessionLocale[]) {
          const { html } = renderProfessionCantonPage({
            locale, cantonKey, id, snapshot: SNAP, distDir: '',
          });
          rendered += 1;
          const { title, h1 } = titleAndH1(html);
          if (h1 && stripBrand(title) === h1) {
            dupes.push(`${buildProfessionCantonPath(locale, cantonKey, id)}  «${h1}»`);
          }
        }
      }
    }
    // Copertura piena, non campionaria: e' il punto di questo test rispetto
    // al gate, che gira al 25 %.
    expect(rendered).toBe(
      PROFESSION_CANTON_KEYS.length * ALL_CANTON_PROFESSION_IDS.length * PROFESSION_LOCALES.length,
    );
    expect(dupes).toEqual([]);
  });

  it('la coppia misurata (SH × ottico, de/en) e\' differenziata, non troncata', () => {
    for (const locale of ['de', 'en'] as const) {
      const { html } = renderProfessionCantonPage({
        locale, cantonKey: 'SH', id: 'ottico-optometrista', snapshot: SNAP, distDir: '',
      });
      const { title, h1 } = titleAndH1(html);
      expect(stripBrand(title)).not.toBe(h1);
      // Il `<title>` tiene le sue keyword: la differenziazione tocca l'H1.
      expect(title).toContain('schaffhausen');
      expect(h1).toContain('schaffhausen');
      // Mai un troncamento con ellissi (titleSuffix.ts lo vieta).
      expect(title).not.toContain('…');
      expect(h1).not.toContain('…');
    }
  });
});

describe('profession-CITY — il gemello latente resta chiuso', () => {
  /**
   * ONESTA': l'assert comportamentale qui sotto e' oggi VACUO sul gemello, e
   * lo dico invece di lasciarlo credere il contrario.
   *
   * Misurato su tutto lo spazio citta' × professione × locale, il `metaTitle`
   * piu' lungo e' di **59 caratteri** su 66 disponibili
   * («Emploi Technicien radiologie Bellinzona — offres et salaire»): ZERO
   * combinazioni raggiungono oggi il fallback, quindi togliere la
   * differenziazione dal renderer non fa arrossire nessuna asserzione
   * comportamentale — provato per mutazione, 0 test rossi.
   *
   * Sette caratteri di margine non sono una difesa: bastano un nome di citta'
   * piu' lungo o un'etichetta di professione piu' lunga (sul gemello per
   * cantone lo stesso margine si e' gia' chiuso, e infatti li' il difetto e'
   * misurato). Quindi il cablaggio va pinnato dove e' osservabile — nel
   * sorgente — finche' non e' osservabile nell'output.
   */
  it('il renderer applica davvero il differenziatore (guard sul cablaggio, non sull\'output)', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'build-plugins', 'professionCityLandings.ts'),
      'utf-8',
    );
    // Il `<h1>` interpola `h1Display`, non il template nudo.
    expect(src).toMatch(/<h1[^>]*>\$\{esc\(h1Display\)\}<\/h1>/);
    expect(src).not.toMatch(/<h1[^>]*>\$\{esc\(c\.h1\(/);
    // …e `h1Display` nasce dal titolo EFFETTIVO, non da `c.metaTitle(...)`:
    // confrontare col metaTitle compilerebbe e non scatterebbe mai, perche' il
    // caso che collide e' proprio quello in cui il metaTitle viene scartato.
    expect(src).toMatch(/const h1Display = differentiateH1FromTitle\(\s*c\.h1\([^)]*\),\s*pageTitle,\s*locale\s*\)/);
    expect(src).toMatch(/title: pageTitle,/);
  });

  it('copre tutte le combinazioni citta\' × professione × locale', () => {
    const dupes: string[] = [];
    let rendered = 0;
    for (const cityKey of PROFESSION_CITY_KEYS) {
      for (const id of PROFESSION_IDS) {
        for (const locale of PROFESSION_LOCALES as readonly ProfessionLocale[]) {
          const { html } = renderProfessionCityPage({
            locale, cityKey, id, snapshot: SNAP, distDir: '',
          });
          rendered += 1;
          const { title, h1 } = titleAndH1(html);
          if (h1 && stripBrand(title) === h1) dupes.push(`${locale}/${cityKey}/${id}  «${h1}»`);
        }
      }
    }
    expect(rendered).toBe(
      PROFESSION_CITY_KEYS.length * PROFESSION_IDS.length * PROFESSION_LOCALES.length,
    );
    expect(dupes).toEqual([]);
  });
});

describe('salary-profession-canton — la TERZA istanza, trovata dal sibling-check', () => {
  /**
   * Non l'avevo vista: l'ha alzata `check-sibling-patterns.mjs` sul diff di
   * questa PR, ed e' la ragione per cui quel controllo esiste. Qui la
   * collisione e' PEGGIORE che sui due gemelli — `BRIDGE_COPY[locale].title`
   * coincide con `COPY[locale].h1` su **tre** locali su quattro (en/de/fr;
   * solo `it` differisce, per un «nel») — e il `metaTitle` di questa famiglia
   * e' il piu' lungo di tutte («— lordo {grossYear} e netto»), quindi e'
   * anche quella che raggiunge il fallback piu' spesso.
   *
   * Il gemello `salaryStatsChCantonPages.ts` la stessa trappola l'aveva gia'
   * chiusa a modo suo (candidato `${h1} · 2026`, con il commento che la
   * spiega); questo file era rimasto indietro.
   */
  const presets = new Map(
    (medians as { presets: Array<{ id: string; label: Record<string, string>; medianSalaryChf: number }> })
      .presets.map((p) => [p.id, p]),
  );

  it('copre tutte le combinazioni cantone × professione-eleggibile × locale', () => {
    const dupes: string[] = [];
    let rendered = 0;
    for (const cantonKey of PROFESSION_CANTON_KEYS) {
      for (const id of SALARY_PROFESSION_ELIGIBLE_IDS) {
        const preset = presets.get(id);
        if (!preset) continue;
        for (const locale of PROFESSION_LOCALES as readonly ProfessionLocale[]) {
          const { html } = renderSalaryProfessionCantonPage({
            locale, cantonKey, id, preset: preset as never, snapshot: SNAP, distDir: '',
          });
          rendered += 1;
          const { title, h1 } = titleAndH1(html);
          if (h1 && stripBrand(title) === h1) dupes.push(`${locale}/${cantonKey}/${id}  «${h1}»`);
        }
      }
    }
    expect(rendered).toBeGreaterThan(0);
    expect(dupes).toEqual([]);
  });
});
