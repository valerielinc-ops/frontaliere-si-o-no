import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_FAQ_HUB } from '../data/faq-hub';

/**
 * Frasi fiscali false o non verificabili che non devono tornare nelle FAQ, nei
 * plugin SEO, nelle traduzioni, nei prompt editoriali e nelle sorgenti llms.
 *
 * Ogni voce nasce da un controllo sui testi primari (Accordo CH-IT del 23/12/2020,
 * L. 83/2023, D.Lgs. 117/2026, Protocollo RU 2026 104): la regola corretta sta nel
 * campo `why`. La smentita esplicita resta ammessa: la voce FAQ
 * `fisco-deduzione-sanitaria-3000` risponde «no» e viene esclusa dalla scansione.
 *
 * `packages/articles/content` non e' coperto: il corpus ha una bonifica propria.
 */
const ROOT = path.resolve(__dirname, '..');

const SCAN_DIRS = ['data/faq-hub', 'build-plugins', 'services/locales', 'services/seo', 'components'];
const SCAN_FILES = [
  'services/calculationService.ts',
  'scripts/create-article.mjs',
  'data/authors.ts',
  'public/llms.txt',
  'public/llms-full.txt',
  'public/en/llms.txt',
  'public/en/llms-full.txt',
  'public/de/llms.txt',
  'public/fr/llms.txt',
];

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /38[,.]8\s?%/, why: 'Accordo 2020 art. 9: la cifra normativa e\' 40%' },
  { pattern: /CHF 3[.,' ]104\b/, why: 'era il 38,8% di CHF 8.000: l\'Accordo prevede il 40% dell\'imposta lorda art. 9' },
  { pattern: /bleibt die Steuer vollstaendig in der Schweiz|l.imposta resta integralmente trattenuta in Svizzera/, why: 'oltre 20 km l\'Italia tassa con credito' },
  { pattern: /\b(?:art\.?|Art\.)\s?66\b[^.\n]{0,30}(?:83\/2023|L\. 83)/, why: 'la L. 83/2023 ha 15 articoli' },
  { pattern: /83\/2023[^.\n]{0,12}\bart\.?\s?66\b/i, why: 'la L. 83/2023 ha 15 articoli' },
  {
    pattern: /credito d.imposta[^.\n]{0,40}fino all.80|tax credit up to 80|foreign tax credit up to 80|Steuergutschrift bis (?:zu )?80|Anrechnung bis 80|crédit d.impôt[^.\n]{0,30}jusqu.à 80/i,
    why: 'l\'80% limita il prelievo svizzero, non il credito italiano',
  },
  { pattern: /con tetto 80\s?%|capped at 80\s?%|Obergrenze 80\s?%|plafonnée à 80\s?%|credito 80\s?%|crédit 80\s?%/i, why: 'nessun tetto dell\'80% al credito' },
  {
    pattern: /deduzione forfetaria sanitaria|deduzione sanitaria|forfait sanitario|flat healthcare|Gesundheits-?Pauschal|pauschalen Gesundheitsabzug|Gesundheitsabzug|déduction santé/i,
    why: 'nessuna deduzione sanitaria di 3.000 € nelle fonti lette',
  },
  { pattern: /aliquota piena|at full rate|au taux plein/i, why: 'i nuovi frontalieri pagano al massimo l\'80%' },
  { pattern: /sale a 10\.000|rises to €10,000|passe à 10 000 €/i, why: 'la franchigia e\' 10.000 € dal 2024' },
  { pattern: /franchigia 70\s?%/i, why: 'nessuna fonte' },
  {
    pattern: /(?:esenzione|franchigia|exemption)[^.\n]{0,12}(?:€|EUR )\s?7['.,]500[^.\n]{0,40}(?:2033|vecchi)|Vecchi frontalieri[^.\n]{0,40}(?:esenzione|franchigia)[^.\n]{0,12}(?:€|EUR )\s?7['.,]500/i,
    why: 'nessuna esenzione di 7.500 € per i vecchi frontalieri',
  },
  {
    pattern: /(?:20\s?%|il restante)[^.\n]{0,30}(?:viene retrocess|vengono retrocess|va al comune|to the Italian municipality|à la commune italienne)|(?<!not an )\b80\/20 split|(?<!un )partage 80\/20|returned to IT\b/i,
    why: 'il restante 20% non e\' prelevato ne\' trasferito',
  },
  {
    pattern: /Accordo[^.\n]{0,90}in vigore dal 1° gennaio 2024|Agreement[^.\n]{0,90}in force since 1 January 2024|Abkommen[^.\n]{0,90}in Kraft seit dem 1\. Januar 2024|Accord[^.\n]{0,90}en vigueur depuis le 1er janvier 2024|è in vigore dal 1° gennaio 2024/,
    why: 'entrata in vigore 17/07/2023, applicazione dal 1/1/2024',
  },
  { pattern: /(?:regola|rule|Regel|règle)[^.\n]{0,30}45[ -](?:minuti|minutes|Minuten)[^.\n?]{0,50}2004/i, why: 'data e regola non verificate' },
  { pattern: /\b180 (?:Comuni|municipalities|Gemeinden|communes)\b/, why: 'numero non verificato' },
  { pattern: /DM 10\/10\/2023|Decree 10 October 2023|DM 10 ottobre 2023/, why: 'decreto non verificato' },
  {
    pattern: /tassazione esclusiva italiana|exclusive Italian taxation|ausschliesslich italienische[rn]? Besteuerung|imposition exclusivement italienne/i,
    why: 'il Protocollo non prevede questa conseguenza',
  },
  { pattern: /\b52 (?:giorni|working days|Arbeitstage|jours)\b/, why: 'non presente nel Protocollo' },
  {
    pattern: /Accordo integrativo|Supplementary Agreement|Zusatzabkommen|Accord additionnel/,
    why: 'e\' il Protocollo di modifica, in vigore dal 9/2/2026',
  },
  { pattern: /in vigore un Accordo[^.\n]{0,30}6 giugno 2024|Dal 6 giugno 2024/, why: 'il 6/6/2024 e\' una data di firma' },
  { pattern: /contributo di solidariet|Solidaritätsbeitrag|solidarity contribution|contribution de solidarité/i, why: 'nessun contributo AD sopra il tetto' },
  { pattern: /Circolare 25\/E, 2024|Circular 25\/E, 2024|Rundschreiben 25\/E, 2024|Circulaire 25\/E, 2024/, why: 'la circolare e\' del 18/8/2023' },
  {
    pattern: /ristorni[^.\n]{0,60}(?:€\s?\d+ ?(?:milioni|million|Mio)|\d+ (?:milioni|million|millions|Millionen)[^.\n]{0,12}(?:€|euro))|(?:supera i|exceeds €?|übersteigt |dépasse )90 (?:milioni|million|Millionen|millions)/i,
    why: 'gli importi versati non sono verificati',
  },
  { pattern: /tetto del 100|tassazione esclusiva svizzera[^.\n]{0,60}oltre 20 km|oltre 20 km[^.\n]{0,120}\*\*tassazione esclusiva svizzera/i, why: 'oltre 20 km l\'Italia tassa con credito' },
];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile() && /\.(ts|tsx|mjs|txt)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const scanned = [
  ...SCAN_DIRS.flatMap((dir) => listFiles(path.join(ROOT, dir))),
  ...SCAN_FILES.map((file) => path.join(ROOT, file)),
]
  .map((file) => path.relative(ROOT, file).split(path.sep).join('/'));

/** La voce di smentita nomina la deduzione per negarla: e' l'unica eccezione. */
function withoutDebunkEntry(file: string, text: string): string {
  if (file !== 'data/faq-hub/category-fisco.ts') return text;
  const start = text.indexOf("id: 'fisco-deduzione-sanitaria-3000'");
  const end = text.indexOf("id: 'fisco-credito-imposta-80-percento'");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(0, start) + text.slice(end);
}

describe('frasi fiscali vietate', () => {
  it('copre davvero le superfici dichiarate', () => {
    expect(scanned).toContain('data/faq-hub/category-fisco.ts');
    expect(scanned).toContain('build-plugins/jobsSeoPagesPlugin.ts');
    expect(scanned).toContain('services/locales/de-fisco.ts');
    expect(scanned.length).toBeGreaterThan(100);
  });

  for (const { pattern, why } of FORBIDDEN) {
    it(`assente: ${pattern.source.slice(0, 50)}`, () => {
      const hits: string[] = [];
      for (const file of scanned) {
        const text = withoutDebunkEntry(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
        const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
        for (const match of text.matchAll(global)) {
          const line = text.slice(0, match.index).split('\n').length;
          hits.push(`${file}:${line}: ${match[0].slice(0, 100)}`);
        }
      }
      expect(hits, why).toEqual([]);
    });
  }
});

describe('citazioni valide anche dal 1/1/2027', () => {
  // D.Lgs. 117/2026 art. 376-377: artt. 4-6 e 8 L. 83/2023 e art. 165 TUIR sono abrogati dal 1/1/2027.
  const CITES_ABROGATED = /(?:L\.|Law|Gesetz|loi) 83\/2023,? (?:art\.|Art\.) ?[456]\b|art\. 165 TUIR|TUIR art\. 165|TUIR-Art\. 165/;

  for (const entry of ALL_FAQ_HUB) {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const answer = entry.answer[locale];
      if (!CITES_ABROGATED.test(answer)) continue;
      it(`${entry.id} (${locale}) cita anche il D.Lgs. 117/2026`, () => {
        expect(answer).toMatch(/117\/2026/);
      });
    }
  }
});

describe('fatti corretti nelle FAQ fisco', () => {
  const answers = (id: string) => {
    const entry = ALL_FAQ_HUB.find((candidate) => candidate.id === id);
    expect(entry, id).toBeDefined();
    return entry!.answer;
  };

  it('la smentita sulla deduzione sanitaria risponde no in ogni lingua', () => {
    const answer = answers('fisco-deduzione-sanitaria-3000');
    expect(answer.it).toMatch(/^No,/);
    expect(answer.en).toMatch(/^No,/);
    expect(answer.de).toMatch(/^Nein,/);
    expect(answer.fr).toMatch(/^Non,/);
  });

  it('i ristorni riportano il 40% fino al 2033 in ogni lingua', () => {
    for (const text of Object.values(answers('fisco-ristorni-comuni-confine'))) {
      expect(text).toMatch(/40\s?%/);
      expect(text).toMatch(/2033/);
    }
  });

  it('il termine dei Redditi 2026 e\' il 2 novembre', () => {
    const answer = answers('fisco-dichiarazione-redditi-pf-2026');
    expect(answer.it).toContain('2 novembre 2026');
    expect(answer.en).toContain('2 November 2026');
    expect(answer.de).toContain('2. November 2026');
    expect(answer.fr).toContain('2 novembre 2026');
  });
});
