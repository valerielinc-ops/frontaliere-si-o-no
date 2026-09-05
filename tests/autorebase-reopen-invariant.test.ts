// La coppia `gh pr close` + `gh pr reopen` è la sola sezione non atomica di
// pr-autorebase: fra le due la PR è CHIUSA. Il codice lo sapeva e lo diceva —
// «mai uscire senza riaprirla» — ma il 2026-08-06, durante un `major_outage` di
// GitHub, entrambi i tentativi immediati sono falliti sulla stessa API
// degradata e #5269 è rimasta chiusa. Otto secondi dopo
// `delete-closed-unmerged` ne ha cancellato il branch: da lì il lavoro non era
// più raggiungibile da remoto, e la PR nemmeno riapribile (GitHub rifiuta il
// reopen di una PR il cui head ref non esiste più).
//
// Due lezioni, entrambe fissate qui:
//   1. due chiamate a millisecondi di distanza campionano lo stesso istante di
//      un'API che sta fallendo — servono tentativi DISTANZIATI;
//   2. la chiusura si recupera a mano, la perdita del branch no: quando la
//      riapertura fallisce va fermato il passo irreversibile, non solo loggato.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const script = readFileSync(resolve('scripts/ci/pr-autorebase.mjs'), 'utf8');
const janitor = readFileSync(resolve('.github/workflows/worktree-branch-janitor.yml'), 'utf8');
const LABEL = 'autorebase-reopen-failed';

describe('pr-autorebase: la PR non resta chiusa in silenzio', () => {
  it('ritenta la riapertura più di una volta, e con una pausa in mezzo', () => {
    // Due forme accettate, stessa soglia: il vecchio `Number(process.env.X || N)`
    // e `intFromEnv('X', N)` (scripts/lib/int-from-env.mjs), in cui il default e'
    // il SECONDO argomento. Il pin resta sul valore — almeno 4 tentativi — non
    // sulla forma sintattica: fissare solo `Number(` rendeva il test rosso per un
    // refactor che non tocca il comportamento difeso.
    expect(script).toMatch(
      /REOPEN_ATTEMPTS\s*=\s*(?:Number\([^)]*\|\|\s*(?:[4-9]|\d{2,})\s*\)|intFromEnv\(\s*[^,]+,\s*(?:[4-9]|\d{2,})\s*[,)])/,
    );
    const fn = script.slice(script.indexOf('function reopenToRetrigger'), script.indexOf('function reopenToRetrigger') + 2600);
    expect(fn).toContain('REOPEN_RETRY_SLEEP_S');
    expect(fn).toContain('REOPEN_ATTEMPTS');
  });

  it('etichetta la PR quando la riapertura fallisce davvero', () => {
    const start = script.indexOf('function reopenToRetrigger');
    const fn = script.slice(start, script.indexOf('\n}', script.indexOf('::error::', start)));
    expect(fn).toContain('--add-label');
    expect(script).toContain(LABEL);
  });

  it('riserva un budget DERIVATO dai tentativi, non un numero fisso', () => {
    // Un costo fisso diventa silenziosamente insufficiente appena si alzano i
    // tentativi — ed è così che il job muore a metà sezione critica.
    const m = /const REOPEN_COST_MS = (?:Number|intFromEnv)\(([\s\S]{0,400}?)\);/.exec(script);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('REOPEN_ATTEMPTS');
    expect(m![1]).toContain('REOPEN_RETRY_SLEEP_S');
  });
});

describe('branch janitor: davanti a quell\'etichetta non cancella', () => {
  // DUE job cancellano branch, non uno. `delete-closed-unmerged` reagisce
  // all'evento di chiusura; `sweep` gira a cron e rastrella i branch senza PR
  // aperta — ed è il secondo che ha ucciso il branch la SECONDA volta, dopo
  // che il primo era già passato. Proteggerne uno solo lascia la porta aperta.
  const jobs = ['delete-closed-unmerged', 'sweep'];

  it('sweep USA davvero la lista che costruisce, non la costruisce e basta', () => {
    // Senza questo, rinominare la sola variabile d'uso lascia il test verde e
    // il branch indifeso: la query c'è, la label c'è, e nessuno le collega.
    const start = janitor.indexOf('  sweep:');
    const body = janitor.slice(start, janitor.indexOf('  delete-closed-unmerged:'));
    // Cammino all'INDIETRO dalla riga `--label`: partire dall'inizio cattura
    // l'assegnazione precedente (`prs_open`) e il test misura la variabile
    // sbagliata.
    const labelIdx = body.indexOf('--label autorebase-reopen-failed');
    expect(labelIdx).toBeGreaterThan(-1);
    const before = body.slice(0, labelIdx);
    const assigns = [...before.matchAll(/(\w+)=\$\(/g)];
    expect(assigns.length).toBeGreaterThan(0);
    const last = assigns[assigns.length - 1];
    const varName = last[1];
    const guardZone = body.slice(last.index!, body.indexOf('-X DELETE'));
    expect(guardZone).toContain(`$${varName}`);
    expect(guardZone).toMatch(new RegExp(`\\$\\{?${varName}[\\s\\S]{0,500}?continue`));
  });

  it.each(jobs)('%s legge la label PRIMA di cancellare', (job) => {
    const start = janitor.indexOf(`  ${job}:`);
    expect(start).toBeGreaterThan(-1);
    const next = jobs.map((j) => janitor.indexOf(`  ${j}:`)).filter((i) => i > start).sort((a, b) => a - b)[0];
    const body = janitor.slice(start, next === undefined ? janitor.length : next);
    const labelIdx = body.indexOf(LABEL);
    const deleteIdx = body.indexOf('-X DELETE');
    expect(labelIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(labelIdx).toBeLessThan(deleteIdx); // o non guarda niente
  });

  it.each(jobs)('%s esce senza cancellare, e lo dice', (job) => {
    const start = janitor.indexOf(`  ${job}:`);
    const next = jobs.map((j) => janitor.indexOf(`  ${j}:`)).filter((i) => i > start).sort((a, b) => a - b)[0];
    const body = janitor.slice(start, next === undefined ? janitor.length : next);
    // La PRIMA occorrenza della label è dentro il commento che spiega perché;
    // la guardia vera è l'ULTIMA, subito prima della cancellazione.
    const guardIdx = body.lastIndexOf(LABEL, body.indexOf('-X DELETE'));
    expect(guardIdx).toBeGreaterThan(-1);
    // Un po' prima dell'occorrenza: il `::warning::` apre la riga che la contiene.
    const guard = body.slice(Math.max(0, guardIdx - 300), body.indexOf('-X DELETE'));
    expect(guard).toMatch(/exit 0|continue/);
    expect(guard).toMatch(/::warning::/);
  });

  it('tiene anche il guard originale sul close→reopen veloce', () => {
    // Il nuovo guard è additivo: la finestra dei ~2s resta coperta dal re-query.
    expect(janitor).toContain('sleep 8');
    expect(janitor).toContain('"$STATE" = "OPEN"');
  });
});
