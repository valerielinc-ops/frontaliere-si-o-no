import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  ARM_NO_THINKING,
  ARM_THINKING,
  applyThinkingArm,
  assignThinkingArm,
  isThinkingAbEnabled,
  runSalt,
  summarizeThinkingAb,
  THINKING_ENV_VAR,
} from '../scripts/lib/thinking-ab.mjs';

// L'esperimento nasce da una misura: sulla run 33718515481 del corpus la
// chiamata media di claude-cli/haiku dura 87,1s e il 77,5% e' tempo al primo
// token, con i token di thinking al 73,4% dell'output. Spegnere il thinking
// comprime quel 77%, ma e' una scelta di qualita' e va misurata, non dedotta.

describe('interruttore dell esperimento', () => {
  it('e spento se nessuno lo accende', () => {
    expect(isThinkingAbEnabled({})).toBe(false);
    expect(isThinkingAbEnabled({ TRANSLATION_THINKING_AB: '' })).toBe(false);
    expect(isThinkingAbEnabled({ TRANSLATION_THINKING_AB: '0' })).toBe(false);
  });

  it('si accende solo con un valore esplicito', () => {
    for (const v of ['1', 'on', 'true', 'YES']) {
      expect(isThinkingAbEnabled({ TRANSLATION_THINKING_AB: v }), v).toBe(true);
    }
  });
});

describe('assegnazione del braccio', () => {
  it('e deterministica per la stessa coppia azienda/run', () => {
    expect(assignThinkingArm('coop-ticino', 'run-1')).toBe(assignThinkingArm('coop-ticino', 'run-1'));
  });

  it('cambia fra run, cosi la stessa azienda vede entrambi i bracci', () => {
    // Con un sale fisso ogni azienda resterebbe per sempre sullo stesso
    // braccio, e le differenze fra bracci sarebbero indistinguibili dalle
    // differenze fra aziende.
    const salts = Array.from({ length: 40 }, (_, i) => `run-${i}`);
    const arms = new Set(salts.map((s) => assignThinkingArm('coop-ticino', s)));
    expect(arms.size).toBe(2);
  });

  it('divide le aziende in modo bilanciato, non a caso', () => {
    const companies = Array.from({ length: 200 }, (_, i) => `azienda-${i}`);
    const assigned = companies.map((c) => assignThinkingArm(c, 'run-fisso'));
    const noThinking = assigned.filter((a) => a === ARM_NO_THINKING).length;
    // Parita' di un digest: attesa 100, tollerati 30 punti di scarto — molto
    // piu' stretto di quanto un Math.random() garantisca su 200 estrazioni.
    expect(noThinking).toBeGreaterThan(70);
    expect(noThinking).toBeLessThan(130);
  });

  it('rende sempre uno dei due bracci dichiarati', () => {
    for (let i = 0; i < 50; i += 1) {
      expect([ARM_THINKING, ARM_NO_THINKING]).toContain(assignThinkingArm(`c-${i}`, 's'));
    }
  });
});

describe('sale della run', () => {
  it('usa l id della run quando c e', () => {
    expect(runSalt({ GITHUB_RUN_ID: '123' })).toBe('123');
    expect(runSalt({ GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' })).toBe('123#2');
  });

  it('in locale cambia comunque fra esecuzioni', () => {
    expect(runSalt({}, 1000)).not.toBe(runSalt({}, 2000));
  });
});

describe('applicazione del braccio', () => {
  it('il controllo non tocca l ambiente', () => {
    const env: Record<string, string | undefined> = {};
    const handle = applyThinkingArm(ARM_THINKING, env);
    expect(handle.applied).toBe(false);
    expect(env[THINKING_ENV_VAR]).toBeUndefined();
  });

  it('lo sperimentale spegne il thinking e poi ripristina', () => {
    const env: Record<string, string | undefined> = {};
    const handle = applyThinkingArm(ARM_NO_THINKING, env);
    expect(handle.applied).toBe(true);
    expect(env[THINKING_ENV_VAR]).toBe('0');
    handle.restore();
    expect(THINKING_ENV_VAR in env).toBe(false);
  });

  it('non sovrascrive un valore messo da fuori', () => {
    // Chi imposta MAX_THINKING_TOKENS in un workflow lo sta facendo apposta:
    // e' la stessa regola che claudeCliChildEnv() applica a se' stessa.
    const env: Record<string, string | undefined> = { [THINKING_ENV_VAR]: '4096' };
    const handle = applyThinkingArm(ARM_NO_THINKING, env);
    expect(handle.applied).toBe(false);
    handle.restore();
    expect(env[THINKING_ENV_VAR]).toBe('4096');
  });
});

describe('aggregazione', () => {
  const rows = [
    { arm: ARM_THINKING, companyKey: 'a', jobCount: 10, elapsedMs: 900_000, attempted: 10, cleared: 9 },
    { arm: ARM_NO_THINKING, companyKey: 'b', jobCount: 10, elapsedMs: 200_000, attempted: 10, cleared: 6 },
  ];

  it('rende tempo per job e tasso di accettazione per braccio', () => {
    const s = summarizeThinkingAb(rows);
    expect(s.arms[ARM_THINKING]).toMatchObject({ companies: 1, jobs: 10, msPerJob: 90_000, acceptRate: 0.9 });
    expect(s.arms[ARM_NO_THINKING]).toMatchObject({ companies: 1, jobs: 10, msPerJob: 20_000, acceptRate: 0.6 });
  });

  it('senza misure rende null, non zero', () => {
    // «Nessuna misura» e «zero» sono due cose diverse: confonderle e' il
    // difetto riparato in queue-alarm.mjs, e qui direbbe che un braccio non
    // accetta niente quando in realta' non ha lavorato.
    const s = summarizeThinkingAb([]);
    expect(s.arms[ARM_THINKING].msPerJob).toBeNull();
    expect(s.arms[ARM_THINKING].acceptRate).toBeNull();
  });

  it('entrambi i bracci compaiono anche se uno non ha righe', () => {
    const s = summarizeThinkingAb([rows[0]]);
    expect(Object.keys(s.arms).sort()).toEqual([ARM_NO_THINKING, ARM_THINKING].sort());
    expect(s.arms[ARM_NO_THINKING].companies).toBe(0);
  });
});

describe('innesto nel cascade', () => {
  const cascade = fs.readFileSync(
    path.join(process.cwd(), 'scripts/relocalize-pending-jobs.mjs'), 'utf8',
  );

  it('ripristina il braccio in finally, non dopo la chiamata', () => {
    // Se il crawler lancia, senza finally l'azienda successiva erediterebbe il
    // braccio sbagliato e l'esperimento misurerebbe un mix.
    expect(cascade).toMatch(/finally\s*\{\s*\n\s*if \(armHandle\) armHandle\.restore\(\);/);
  });

  it('il braccio avvolge SOLO la chiamata del crawler', () => {
    const start = cascade.indexOf('const armHandle');
    const end = cascade.indexOf('armHandle.restore()');
    expect(start).toBeGreaterThan(-1);
    expect(cascade.slice(start, end)).toContain('await runSharedCrawler');
  });

  it('non cambia niente quando l esperimento e spento', () => {
    // `thinkingArm` resta null e `applyThinkingArm` non viene mai chiamata.
    expect(cascade).toContain('const thinkingArm = thinkingAb ? assignThinkingArm(key, thinkingSalt) : null;');
    expect(cascade).toContain('const armHandle = thinkingArm ? applyThinkingArm(thinkingArm, process.env) : null;');
  });

  it('copre ENTRAMBI i punti in cui il cascade lancia il crawler', () => {
    // Il secondo e' il passaggio di retry. Senza il braccio anche li', una
    // azienda verrebbe ritentata con il thinking al default mentre
    // l'esperimento la conta nel braccio assegnato: la misura sarebbe un
    // miscuglio invece di due bracci.
    const chiamate = cascade.match(/await runSharedCrawler\(/g) || [];
    const ripristini = cascade.match(/Handle\.restore\(\)/g) || [];
    expect(chiamate.length).toBe(2);
    expect(ripristini.length).toBe(chiamate.length);
  });

  it('il retry usa lo stesso braccio del primo passaggio', () => {
    // assignThinkingArm e' deterministica sulla coppia (azienda, sale): la
    // stessa azienda non puo' cambiare braccio fra i due passaggi.
    expect(assignThinkingArm('coop-ticino', 'run-9')).toBe(assignThinkingArm('coop-ticino', 'run-9'));
    expect(cascade).toContain('const retryArm = thinkingAb ? assignThinkingArm(key, thinkingSalt) : null;');
  });

  it('scrive l artefatto nel RUNNER_TEMP, non fra i dati tracciati', () => {
    expect(cascade).toContain("process.env.RUNNER_TEMP");
    expect(cascade).toContain('translation-thinking-ab.json');
    expect(cascade).not.toContain("'data/translation-thinking-ab.json'");
  });
});
