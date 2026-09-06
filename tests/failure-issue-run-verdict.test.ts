import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stepBlocks, WORKFLOWS_DIR } from '../scripts/ci/failure-issue-inventory.mjs';

/**
 * Chi apre `Workflow|Crawler|CI Failure: <nome>` da un run che resta VERDE
 * scollega la issue dal suo unico chiuditore (issue #7379, item 3).
 *
 * `close-recovered-failure-issues.yml` chiude questi titoli su una premessa
 * sola: «l'ultimo run completato del workflow e' `success` ed e' partito dopo
 * l'apertura della issue». La premessa presume che il run che ha aperto la
 * issue fosse ROSSO. Uno step che apre la issue e poi esce 0 — tipico di un
 * monitor con `continue-on-error: true` sullo step di detection, dove
 * `if: failure()` non si valuta mai vero — la rompe in tutti e due i versi:
 *
 *   - il run che apre e' verde ma e' partito PRIMA della issue → nessuna
 *     chiusura, e la issue `priority:high` resta appesa (una settimana su un
 *     cron settimanale, mesi se il guasto e' intermittente);
 *   - il giro DOPO e' verde per costruzione anche se il guasto e' ancora li'
 *     → la issue si chiude come «recuperata» mentre lo script e' ancora morto.
 *     Questo e' il caso peggiore: e' l'osservatore che si zittisce da solo.
 *
 * L'idiom corretto e' gia' nel repo (`job-description-locale-audit.yml`,
 * `job-title-locale-audit.yml`, `location-quality-audit.yml`): la issue la apre
 * uno step che DEVE poter girare, e un secondo step mette il rosso del run.
 * `pharmacy-data-health-monitor.yml` era l'unico che usciva 0.
 *
 * NON copre: che il chiuditore esista (quello e' `failure-issue-closers.test.ts`),
 * ne' i titoli di CONDIZIONE aperti su un run verde di proposito — quelli non
 * ricadono nel pattern `Workflow|Crawler|CI Failure:` del reconciler e hanno un
 * ciclo di vita diverso. La scansione e' per FILE, non per job: due job nello
 * stesso file che si passassero il testimone non verrebbero distinti.
 */

const RECONCILER_TITLE = /--title\s+"(?:Workflow|Crawler|CI) Failure:/;
/** Gate su un OUTCOME di step: il job e' vivo (continue-on-error), non in `failure()`. */
const OUTCOME_GATE = /\bsteps\.([A-Za-z0-9_-]+)\.outcome\b/;

function ifCondition(stepText: string): string {
  const m = stepText.match(/^\s+if:\s*(.+)$/m);
  return m ? m[1].trim() : '';
}

function stepId(stepText: string): string {
  const m = stepText.match(/^\s+id:\s*(\S+)\s*$/m);
  return m ? m[1] : '';
}

describe('issue di fallimento aperte da un run che resta verde', () => {
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml'));

  it('ogni opener gated su un outcome ha uno step che fa fallire il job', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const text = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
      const blocks = stepBlocks(text);

      blocks.forEach((block, index) => {
        if (!RECONCILER_TITLE.test(block.text)) return;
        if (!block.text.includes('github-issue-creator.mjs')) return;
        if (/--resolve\b/.test(block.text)) return;

        const cond = ifCondition(block.text);
        if (/failure\(\)/.test(cond)) return; // il job e' gia' rosso da se'
        const gated = cond.match(OUTCOME_GATE);
        if (!gated) return; // opener non condizionato a un outcome: fuori scope

        const openerId = stepId(block.text);
        const fails = blocks.slice(index + 1).some((later) => {
          if (!/(^|\n)\s+run:/.test(later.text)) return false;
          if (!/\bexit\s+[1-9]/.test(later.text)) return false;
          const laterCond = ifCondition(later.text);
          if (!laterCond) return false;
          return (
            laterCond.includes(`steps.${gated[1]}.outcome`) ||
            (openerId !== '' && laterCond.includes(`steps.${openerId}.outputs`))
          );
        });

        if (!fails) {
          offenders.push(
            `${file}:${block.line} — apre un titolo del reconciler sotto ` +
              `\`${cond}\` senza uno step che faccia fallire il job: il run resta ` +
              `verde e la chiusura su «prossimo verde» si scollega dal guasto.`,
          );
        }
      });
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('il monitor farmacie fa fallire il job quando il report non viene scritto', () => {
    const text = fs.readFileSync(path.join(WORKFLOWS_DIR, 'pharmacy-data-health-monitor.yml'), 'utf8');
    const blocks = stepBlocks(text);

    const opener = blocks.find((b) => RECONCILER_TITLE.test(b.text) && b.text.includes('report_missing=true'));
    expect(opener, 'lo step che apre la issue deve segnalare il report mancante').toBeDefined();
    expect(stepId(opener!.text)).toBe('open-issue');

    const failStep = blocks.find(
      (b) => ifCondition(b.text).includes("steps.open-issue.outputs.report_missing == 'true'") && /\bexit 1\b/.test(b.text),
    );
    expect(failStep, 'serve uno step che porti il run a rosso dopo aver aperto la issue').toBeDefined();

    // Nessun doppione: il reporter finale non ri-apre lo stesso titolo su quel ramo.
    const finalReporter = blocks.find((b) => b.text.includes('Report unexpected failure to GitHub Issues'));
    expect(ifCondition(finalReporter!.text)).toContain("steps.open-issue.outputs.report_missing != 'true'");
  });
});
