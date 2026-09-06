/**
 * Il gate deterministico in ingresso sul conio delle follow-up.
 *
 * Il difetto sorvegliato. `post-merge-followup.yml` conia una issue aggregata per PR
 * mergiata; il divieto di mintare item senza condizione di accettazione falsificabile
 * esisteva solo nel prompt Claude. Misurato il 2026-09-06 sul sito, ultimi 7 giorni:
 * 164 aggregate coniate, 91 (55%) strutturalmente immortali — 76 senza nemmeno un item
 * falsificabile. Una `no-valid-item` non si chiude MAI: `aggregateCloseGate()` la blocca
 * per costruzione (chiuderla sarebbe chiudere su evidenza assente, incidente #5849).
 *
 * PERCHE' ANCHE I PIN SUL SORGENTE, e non solo i casi comportamentali. Su #7577 e #7587
 * i test comportamentali restavano VERDI anche reintroducendo il difetto, perche'
 * esercitavano l'helper in isolamento: un gate che reimplementa in casa il proprio
 * predicato di ammissione supera tutti i casi qui sotto e intanto divergere
 * dall'oracolo di chiusura — che e' esattamente la coda immortale che questo modulo
 * esiste per chiudere (#7587: UN oracolo, i due lati). Allo stesso modo, uno step
 * rimosso dal workflow non fa fallire nessun test comportamentale: il gate semplicemente
 * non gira piu'. I due pin sotto guardano quelle due direzioni.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decideMintGate,
  partitionMintedItems,
  rebuildBody,
  retitle,
  itemHeadline,
} from '../scripts/ci/gate-minted-followups.mjs';

const GATE_SRC = fileURLToPath(new URL('../scripts/ci/gate-minted-followups.mjs', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../.github/workflows/post-merge-followup.yml', import.meta.url));

const HEAD = `## Origine
- PR: #7600 titolo (merged 2026-09-06)

## Item
`;

const itemValido = ` la soglia va letta da env
- Source: PR body Non implementato
- Stato dichiarato nella PR: \`blocked: manca il dato\`
- Original text: > la soglia e' hardcoded
- Suggested action: sostituisci il letterale con \`intFromEnv('MAX_ITEMS', 10)\` in \`scripts/ci/foo.mjs\`
`;

// La classe dominante: un rischio in prosa sollevato in `## Adversarial check`. Non cita
// nulla che un check possa cercare verbatim, quindi nessuna evidenza potra' mai provarlo
// affrontato — entra in coda e non ne esce piu'.
const itemProsa = ` nessun gate impedisce un drift futuro
- Source: reviewer \`## Adversarial check\`
- Stato dichiarato nella PR: nessuno
- Original text: > il valore potrebbe divergere col tempo
- Suggested action: valutare se serve un campo esplicito
`;

const aggregata = (...items: string[]) =>
  HEAD + items.map((it, i) => `### ${i + 1}.${it}`).join('\n');

describe('gate sul conio — comportamento', () => {
  it('sopprime l\'aggregata in cui NESSUN item porta una condizione falsificabile', () => {
    const d = decideMintGate({ body: aggregata(itemProsa, itemProsa), createdAt: new Date().toISOString() });
    expect(d.action).toBe('suppress');
    expect(d.reason).toBe('no-valid-item');
    expect(d.demoted).toHaveLength(2);
  });

  it('demota i soli item non falsificabili e ricompone il corpo coi superstiti rinumerati', () => {
    const d = decideMintGate({ body: aggregata(itemProsa, itemValido, itemProsa), createdAt: new Date().toISOString() });
    expect(d.action).toBe('demote');
    expect(d.valid).toHaveLength(1);
    expect(d.demoted).toHaveLength(2);
    // Il superstite diventa `### 1.` (formato uniforme, parsabile dal fixer) e la prosa sparisce.
    expect(d.body).toContain('### 1. la soglia va letta da env');
    expect(d.body).not.toContain('nessun gate impedisce un drift futuro');
    expect(d.body).not.toMatch(/^### 2\./m);
    // Il corpo ricostruito e' ancora leggibile dallo stesso oracolo: 1 item, valido.
    const p = partitionMintedItems(d.body as string);
    expect(p.valid).toHaveLength(1);
    expect(p.demoted).toHaveLength(0);
  });

  it('non tocca l\'aggregata in cui ogni item e\' gia\' falsificabile', () => {
    const d = decideMintGate({ body: aggregata(itemValido, itemValido), createdAt: new Date().toISOString() });
    expect(d.action).toBe('keep');
  });

  it('IL VERSO SICURO: un corpo senza struttura a item non viene MAI soppresso', () => {
    // «Non so leggerlo» non e' «e' vuoto» — stessa regola di `aggregateCloseGate`.
    // Sopprimere qui cancellerebbe lavoro vero che il conio ha solo formattato male.
    const d = decideMintGate({ body: 'testo libero senza nessuna sezione item', createdAt: new Date().toISOString() });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('aggregate-unparsed');
  });

  it('non riscrive una issue che non e\' appena stata coniata', () => {
    // Un backfill via workflow_dispatch su una PR vecchia non deve poter riscrivere
    // una issue che nel frattempo un umano ha curato.
    const vecchia = new Date(Date.now() - 30 * 864e5).toISOString();
    expect(decideMintGate({ body: aggregata(itemProsa), createdAt: vecchia }).action).toBe('skip');
    expect(decideMintGate({ body: aggregata(itemProsa), createdAt: vecchia }).reason).toBe('not-freshly-minted');
  });

  it('riallinea il conteggio nel titolo e sa estrarre la riga dell\'item demoto', () => {
    expect(retitle('follow-up(#7600): 4 item deferred — foo', 1)).toBe('follow-up(#7600): 1 item deferred — foo');
    expect(itemHeadline(itemProsa)).toBe('nessun gate impedisce un drift futuro');
  });

  it('rebuildBody non perde la testa della issue (origine + PR di provenienza)', () => {
    const b = rebuildBody(HEAD, [itemValido]);
    expect(b).toContain('- PR: #7600');
    expect(b).toContain('### 1.');
  });
});

describe('gate sul conio — pin sul sorgente', () => {
  it('PIN: il criterio di ingresso E\' l\'oracolo di uscita, importato — mai reimplementato', () => {
    const src = readFileSync(GATE_SRC, 'utf-8');
    // Direzione 1 del difetto: il gate si scrive un predicato proprio. I casi
    // comportamentali sopra resterebbero verdi (un clone si comporta uguale... finche'
    // uno dei due non cambia), e i due lati tornerebbero a divergere — #7587.
    expect(src).toMatch(/import\s*\{[^}]*hasFalsifiableAcceptance[^}]*\}\s*from\s*'\.\/followup-resolution-match\.mjs'/s);
    expect(src).toMatch(/import\s*\{[^}]*splitFollowupItems[^}]*\}\s*from\s*'\.\/followup-resolution-match\.mjs'/s);
    // Nessuna copia locale dell'oracolo: ne' una funzione omonima, ne' la regione
    // `Suggested action` riconosciuta a mano, ne' una soglia di token propria.
    expect(src).not.toMatch(/function\s+hasFalsifiableAcceptance/);
    expect(src).not.toMatch(/function\s+isDistinctiveToken/);
    expect(src).not.toMatch(/\/suggested action\/i/i);
    expect(src).not.toMatch(/ACCEPTANCE_CONDITION\s*=/);
  });

  it('PIN: lo step gira nel workflow, zero-Claude, DOPO il conio e senza poterlo far cadere', () => {
    const wf = readFileSync(WORKFLOW, 'utf-8');
    // Direzione 2: lo step viene tolto o spostato prima del conio. Nessun test
    // comportamentale se ne accorge — il gate semplicemente non gira piu'.
    const gate = wf.indexOf('node scripts/ci/gate-minted-followups.mjs');
    const conio = wf.indexOf('uses: anthropics/claude-code-action');
    expect(gate).toBeGreaterThan(-1);
    expect(conio).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(conio);
    // Deve girare anche se il conio e' morto in timeout DOPO aver creato la issue,
    // e non deve poter far fallire il triage.
    const step = wf.slice(wf.lastIndexOf('- name:', gate), gate);
    expect(step).toContain('if: always()');
    expect(step).toContain('continue-on-error: true');
    // Zero-Claude: nessun token/OAuth in questo step.
    expect(step).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});
