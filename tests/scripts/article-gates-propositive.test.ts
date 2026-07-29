import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Pins the "gates must PROPOSE the fix, not just block" contract (2026-07-29).
//
// Run 30442955458 generated 48 full articles across 8 headlines and published
// none. Every rejection came from the same three blocking gates, and the loop
// never converged because the gates were an open loop: the writer was told the
// PRECISION rule ("only use facts from the source") but never the RECALL rule
// the gates actually enforce ("keep these specific facts"), so it learned
// nothing between attempts — recall went 38% → 13% → 0% → 0%. Worse, the one
// piece of feedback it did get for date anchors was unsatisfiable: the gate
// asked for "2023-07-17" while the matcher only ever accepts "17 luglio 2023".

const gates = (await import('../../scripts/lib/article-factuality-gates.mjs')) as unknown as {
  buildSourceContract: (p: Record<string, unknown>) => string;
  renderAnchorForPrompt: (a: string) => string;
  anchorEvidence: (sourceText: string, anchor: string) => string;
  extractSourceAnchors: (s: string) => Set<string>;
  matchedAnchors: (article: string, anchors: Set<string>) => Set<string>;
  checkSourceFidelity: (article: string, source: string, opts?: Record<string, unknown>) => Array<{ code: string; fix: string }>;
  checkSourceFreshness: (p: Record<string, unknown>) => Array<{ code: string; severity: string; fix: string }>;
  runFactualityGates: (p: Record<string, unknown>) => { issues: Array<{ code: string; fix: string }> };
};

const SOURCE = [
  'Il rimborso spetta nella misura del 80% della spesa sostenuta dal lavoratore.',
  'In Italia si applica invece l\'imposta sostitutiva del 25% sul reddito estero.',
  'Restano frontalieri i residenti entro 20 km dal confine.',
  'Gli obblighi AVS e LPP non cambiano per chi mantiene il rapporto in Svizzera.',
  'La circolare del 17 luglio 2023 ha chiarito il criterio applicabile.',
].join(' ');

describe('source contract is satisfiable by construction', () => {
  it('lists every anchor in the literal form the recall matcher accepts', () => {
    const contract = gates.buildSourceContract({ sourceText: SOURCE });
    const anchors = gates.extractSourceAnchors(SOURCE);

    // The decisive property: an article that quotes exactly what the contract
    // asked for must pass the gate that the contract is quoting. Before
    // renderAnchorForPrompt, date anchors failed this — the instruction named
    // a string the matcher could never find.
    const articleFromContract = contract;
    const found = gates.matchedAnchors(articleFromContract, anchors);
    expect(found.size).toBe(anchors.size);
    expect(gates.checkSourceFidelity(articleFromContract, SOURCE)).toEqual([]);
  });

  it('renders a date anchor the way the matcher reads it, not as the raw key', () => {
    expect(gates.renderAnchorForPrompt('date:2023-07-17')).toBe('17 luglio 2023');
    expect(gates.renderAnchorForPrompt('pct:80')).toBe('80%');
    expect(gates.renderAnchorForPrompt('km:20')).toBe('20 km');
    expect(gates.renderAnchorForPrompt('org:AVS')).toBe('AVS');
  });

  it('states the exact month-year stamp that clears a stale source', () => {
    const contract = gates.buildSourceContract({
      sourceText: SOURCE,
      sourceDate: '2026-04-23',
      publishedAt: '2026-07-29',
    });
    expect(contract).toContain('aprile 2026');

    // 97 days is past maxAgeDays*3, i.e. `critical`/blocking — unless the text
    // dates the fact. Writing the stamp the contract demanded must be enough.
    const dated = gates.checkSourceFreshness({
      sourceDate: '2026-04-23',
      publishedAt: '2026-07-29',
      text: 'Secondo quanto comunicato nel aprile 2026 la misura era già operativa.',
    });
    expect(dated.every((i) => i.severity !== 'critical')).toBe(true);

    const undated = gates.checkSourceFreshness({
      sourceDate: '2026-04-23',
      publishedAt: '2026-07-29',
      text: 'La misura è operativa da subito.',
    });
    expect(undated.some((i) => i.code === 'stale-source' && i.severity === 'critical')).toBe(true);
  });

  it('stays silent when the source carries too few anchors to gate on', () => {
    expect(gates.buildSourceContract({ sourceText: 'Una notizia senza dati verificabili.' })).toBe('');
  });
});

describe('gates propose the correction, not just the verdict', () => {
  it('hands back the source sentence carrying each dropped fact', () => {
    const stripped = 'Il tema riguarda i frontalieri e le regole applicabili in generale.';
    const issues = gates.checkSourceFidelity(stripped, SOURCE);
    const fidelity = issues.find((i) => i.code === 'source-fidelity-low');
    expect(fidelity).toBeDefined();
    // Not just "you dropped 80%" — the source's own wording, ready to reuse.
    expect(fidelity!.fix).toContain('la fonte dice:');
    expect(fidelity!.fix).toContain('80% della spesa sostenuta');
    // And the date is named in the form that can actually satisfy the check.
    expect(fidelity!.fix).toContain('17 luglio 2023');
    expect(fidelity!.fix).not.toContain('2023-07-17');
  });

  it('locates the evidence sentence for each anchor kind', () => {
    expect(gates.anchorEvidence(SOURCE, 'pct:25')).toContain('imposta sostitutiva del 25%');
    expect(gates.anchorEvidence(SOURCE, 'org:LPP')).toContain('AVS e LPP');
    expect(gates.anchorEvidence(SOURCE, 'date:2023-07-17')).toContain('17 luglio 2023');
    expect(gates.anchorEvidence(SOURCE, 'pct:99')).toBe('');
  });

  // The rule, made structural: a gate that blocks without proposing a repair
  // is a dead end for the retry loop. Static scan so it also covers gates this
  // suite never triggers — a new one added without a fix fails here.
  it('every issue() call site in the module supplies a remediation', () => {
    const src = readFileSync(new URL('../../scripts/lib/article-factuality-gates.mjs', import.meta.url), 'utf8');
    const offenders: string[] = [];
    for (const m of src.matchAll(/\bissue\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1; // index of the '('
      let depth = 0;
      let j = open;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') { depth--; if (depth === 0) break; }
      }
      const call = src.slice(open + 1, j);
      const parts: string[] = [];
      let cur = '';
      let d = 0;
      let quote: string | null = null;
      for (let k = 0; k < call.length; k++) {
        const c = call[k];
        if (quote) {
          if (c === '\\') { cur += call.slice(k, k + 2); k++; continue; }
          if (c === quote) quote = null;
        } else if (c === '\'' || c === '"' || c === '`') quote = c;
        else if ('([{'.includes(c)) d++;
        else if (')]}'.includes(c)) d--;
        else if (c === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
        cur += c;
      }
      parts.push(cur);
      const fix = (parts[4] || '').trim();
      if (!fix || fix === "''" || fix === '""' || fix === '``') {
        offenders.push(parts[0]?.trim() || '(unknown)');
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runFactualityGates never emits an issue without a fix', () => {
    const result = gates.runFactualityGates({
      sections: {
        body1: 'Il rimborso è generico e non cita cifre.',
        body2: 'Nessun dato verificabile viene riportato (parentesi non chiusa.',
        body3: 'La misura è operativa da subito.',
      },
      sourceText: SOURCE,
      sourceDate: '2026-04-23',
      publishedAt: '2026-07-29',
    });
    expect(result.issues.length).toBeGreaterThan(0);
    for (const i of result.issues) {
      expect(i.fix, `gate ${i.code} blocca senza proporre una correzione`).toBeTruthy();
    }
  });
});
