import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { REDFLAG_IMPORTANT_RE } from '../scripts/ci/lib/constants.mjs';

// Locks the markdown-tolerant 🔴-Important detector shared by the JS auto-merge gate.
// The brittle literal `'🔴 Important'` missed the reviewer's bold form
// `🔴 **Important —` (PR #2211 round-2) → redflag-fixer skipped + PR stalled.
// pr-redflag-fixer.yml greps the SAME shape in bash; keep the two equivalent.
//
// Requires a delimiter (`:`, `—`, or `-`) right after "Important" — added after
// PR #3330 false-positived on the reviewer's own negation prose "zero 🔴
// Important findings (both nits are non-blocking)": bare `Important` with no
// delimiter is prose describing an ABSENCE of findings, not the marker itself.
describe('REDFLAG_IMPORTANT_RE (markdown-tolerant 🔴 Important detector)', () => {
  it('matches the plain literal form', () => {
    expect(REDFLAG_IMPORTANT_RE.test('🔴 Important: missing canonical')).toBe(true);
  });

  it('matches the bolded form that broke the literal gate (PR #2211 round-2)', () => {
    expect(REDFLAG_IMPORTANT_RE.test('🔴 **Important —** sibling not swept')).toBe(true);
  });

  it('matches with no space and double-bold', () => {
    expect(REDFLAG_IMPORTANT_RE.test('🔴**Important**: regression')).toBe(true);
  });

  it('matches inside a real multi-finding review body', () => {
    const body = '## Findings (Important: 1, Nit: 2)\n🔴 **Important — ** `x.mjs:L1`: bug\n🟡 **Nit** — tidy';
    expect(REDFLAG_IMPORTANT_RE.test(body)).toBe(true);
  });

  it('does NOT match a decorative 🔴 not followed by Important', () => {
    expect(REDFLAG_IMPORTANT_RE.test('Nessun 🔴 trovato — tutto pulito. ## LGTM')).toBe(false);
  });

  it('does NOT match the count header alone (Important without a 🔴 before it)', () => {
    expect(REDFLAG_IMPORTANT_RE.test('## Findings (Important: 0, Nit: 1)\n🟡 Nit — minor')).toBe(false);
  });

  it('does NOT match a clean LGTM review with no 🔴', () => {
    expect(REDFLAG_IMPORTANT_RE.test('Looks correct, tests cover it.\n\n## LGTM')).toBe(false);
  });

  it('does NOT match the PR #3330 false-positive: negation prose with no delimiter after Important', () => {
    const body =
      'Correction to my prior review: zero 🔴 Important findings (both nits are non-blocking).\n\n## LGTM';
    expect(REDFLAG_IMPORTANT_RE.test(body)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Terza variante della stessa classe (corpus#909, 2026-09-05): il marker CITATO.
//
// `## Findings (Important: 0, Nit: 3)` + `## LGTM` regolari, ma dentro il testo di
// un nit la review riportava un marker fra virgolette. Il marker citato porta i due
// punti esattamente come quello vero → il rimedio di #3330 (pretendere la
// punteggiatura) non lo vede → il review gate di tests.yml rendeva ROSSA una PR
// approvata. La discriminante non è il vocabolario ma la POSIZIONE: un marker APRE
// la riga del proprio finding; una citazione sta dentro la riga di un ALTRO finding
// o dentro un code span.
//
// Il gate deve continuare a rendere rosso un 🔴 vero: ogni caso "citazione → verde"
// qui sotto ha il suo gemello "marker vero → rosso", perché una fix che spegne il
// gate sarebbe peggio del falso positivo che chiude.
describe('REDFLAG_IMPORTANT_RE — marker vero contro marker citato (posizione)', () => {
  // Verbatim dalla review di `nanakokyobashi-rgb/frontaliere-articles#909`
  // (commit de11cb7c): tre occorrenze, tutte dentro la riga di un 🟡 Nit.
  const REVIEW_909 = [
    '## Findings (Important: 0, Nit: 3)',
    '',
    "`scripts/ci/harvest-agent-lessons.mjs:L276: 🟡 Nit: il gap `(?:\\s+\\S+){0,3}?` fa scattare il ramo A anche quando la negazione porta su un PARTICIPIO e non sul verbo di impatto, e li' la frase e' un difetto vero. Verificato: «🔴 Important: il path non gestito raggiunge `parsePath` e il router.» → stripped resta vuoto.",
    '',
    '## LGTM',
  ].join('\n');

  it('NON matcha il marker citato dentro la riga di un altro finding (corpus#909)', () => {
    expect(REDFLAG_IMPORTANT_RE.test(REVIEW_909)).toBe(false);
  });

  it('matcha il marker vero a inizio riga', () => {
    const body = '## Findings (Important: 1, Nit: 0)\n\n🔴 Important: `/de/blog/null` finisce nel canonical e nella sitemap.\n\n## LGTM';
    expect(REDFLAG_IMPORTANT_RE.test(body)).toBe(true);
  });

  it('matcha il marker vero dopo una location label, con o senza bullet', () => {
    expect(REDFLAG_IMPORTANT_RE.test('`scripts/x.mjs:L1053: 🔴 Important: guard mancante')).toBe(true);
    expect(REDFLAG_IMPORTANT_RE.test('- `scripts/ci/run-related-tests.mjs:L184`: 🔴 Important: shard non coperto')).toBe(true);
  });

  it('NON matcha il marker dentro un code span (testo riportato, non verdetto)', () => {
    expect(REDFLAG_IMPORTANT_RE.test('Il test pinna la stringa `🔴 Important: x` come fixture.')).toBe(false);
    expect(REDFLAG_IMPORTANT_RE.test('- `constants.mjs:L69`: 🟡 Nit: il pattern `🔴 Important:` va documentato.')).toBe(false);
  });

  it('NON matcha la prosa di negazione già chiusa da #3330 (nessuna regressione)', () => {
    expect(REDFLAG_IMPORTANT_RE.test('Correction to my prior review: zero 🔴 Important findings (both nits are non-blocking).\n\n## LGTM')).toBe(false);
    expect(REDFLAG_IMPORTANT_RE.test('Nessun 🔴 trovato — tutto pulito.\n\n## LGTM')).toBe(false);
  });

  it('un 🔴 decorativo prima del marker NON lo nasconde (si sbaglia in direzione rossa)', () => {
    // `🔴` è deliberatamente FUORI dalla classe negata del lead: se lo escludessimo,
    // una riga che apre con un 🔴 non-marker spegnerebbe il gate sul marker che segue.
    expect(REDFLAG_IMPORTANT_RE.test('🔴 blocca il merge — 🔴 Important: canonical rotto')).toBe(true);
  });

  it('una riga citante non spegne il marker vero che sta su UN ALTRA riga', () => {
    const body = [
      '## Findings (Important: 1, Nit: 1)',
      '',
      '`a.mjs:L1`: 🟡 Nit: la review precedente diceva «🔴 Important: falso allarme».',
      '`b.mjs:L2`: 🔴 Important: la sitemap perde gli slug `de`.',
      '',
      '## LGTM',
    ].join('\n');
    expect(REDFLAG_IMPORTANT_RE.test(body)).toBe(true);
  });
});

// Il conteggio dichiarato NON è un ingresso del gate (può solo spostare un verdetto
// da rosso a verde, cioè nella direzione che spegnerebbe il gate) — è però un
// ORACOLO INDIPENDENTE: su una review ben formata `Important: N > 0` ⇔ esiste un
// marker vero. Le due direzioni della coerenza sono il test che una fix "che spegne
// il gate" non passerebbe.
describe('REDFLAG_IMPORTANT_RE — coerenza col conteggio dichiarato', () => {
  const declared = (body: string) => {
    const header = body.match(/^#{1,4}\s*Findings\b[^\n]*/m);
    const n = header?.[0].match(/Important:\s*(\d+)/i);
    return n ? Number(n[1]) : null;
  };

  const CASES: Array<[string, string]> = [
    [
      'Important: 0 con un marker citato → verde',
      '## Findings (Important: 0, Nit: 1)\n\n`x.mjs:L1`: 🟡 Nit: la review diceva «🔴 Important: y».\n\n## LGTM',
    ],
    [
      'Important: 1 con un marker vero → rosso',
      '## Findings (Important: 1, Nit: 0)\n\n`x.mjs:L1`: 🔴 Important: canonical rotto.\n',
    ],
    [
      'Important: 0 senza alcun 🔴 → verde',
      '## Findings (Important: 0, Nit: 2)\n\n🟡 Nit: naming.\n🟡 Nit: commento stale.\n\n## LGTM',
    ],
    [
      'Important: 2 con due marker veri → rosso',
      '## Findings (Important: 2, Nit: 0)\n\n- `a.mjs:L1`: 🔴 Important: uno.\n- `b.mjs:L2`: 🔴 **Important —** due.\n',
    ],
  ];

  for (const [name, body] of CASES) {
    it(name, () => {
      const n = declared(body);
      expect(n).not.toBeNull();
      expect(REDFLAG_IMPORTANT_RE.test(body)).toBe((n as number) > 0);
    });
  }
});

// Il difetto è stato riparato tre volte perché la logica vive in TRE copie: questa
// regex e i due `grep -qP` bash (un `if:`/`run:` YAML non può importare un modulo
// JS). Il guard deriva il pattern atteso dalla `.source` — grep è già orientato alla
// riga, quindi l'unica differenza legittima è il `\n` nella classe negata — e lo
// pretende verbatim in entrambi i workflow: una quarta variante applicata a una sola
// copia rende rosso qui invece di restare in silenzio per mesi.
describe('REDFLAG_IMPORTANT_RE — le copie bash non possono divergere', () => {
  const bashPattern = REDFLAG_IMPORTANT_RE.source.replace('[^\\n', '[^');

  it('la sola differenza fra la source JS e il pattern bash è il `\\n` della classe negata', () => {
    expect(REDFLAG_IMPORTANT_RE.source).toContain('[^\\n');
    expect(bashPattern).not.toContain('\\n');
    expect(bashPattern).toBe(REDFLAG_IMPORTANT_RE.source.replace('\\n', ''));
  });

  for (const wf of ['pr-redflag-fixer.yml', 'stale-pr-rescuer.yml']) {
    it(`${wf} grepa esattamente quel pattern`, () => {
      const yaml = readFileSync(new URL(`../.github/workflows/${wf}`, import.meta.url), 'utf8');
      expect(yaml).toContain(`grep -qP '${bashPattern}'`);
    });
  }
});
