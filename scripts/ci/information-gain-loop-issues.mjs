#!/usr/bin/env node
/**
 * information-gain-loop-issues.mjs — the acting half of the self-improving
 * Information-Gain loop (issue #5002).
 *
 * Reads the verdict of `information-gain-live-scan.mjs` and turns it into work
 * the EXISTING autonomous loop can pick up: `issue-triage` routes the issue,
 * `issue-fix` implements it, `pr-review-loop` reviews it,
 * `auto-merge-on-lgtm` merges it, the next scan re-measures and this script
 * resolves the issue. Nothing here implements a fix — that would be a second
 * fixer competing with the one the repo already has.
 *
 * WHY ISSUES AND NOT A RED CRON
 * ---------------------------------------------------------------------------
 * A cron that goes red on a content metric is a cron somebody mutes: no PR can
 * turn it green, so its red is permanent furniture. An issue carrying the
 * measurement is the unit this repo's loop consumes, and it disappears on its
 * own when the number moves.
 *
 * THE THREE TITLES ARE STABLE BY DESIGN
 * ---------------------------------------------------------------------------
 * `createGithubIssue` dedups on the first 60 characters of the title, so:
 *   - the COHORT LABEL comes first (it is the discriminant: two families must
 *     never dedup into each other);
 *   - no percentage appears in the title (a number in the title changes every
 *     run and every run would open a new issue).
 * The measurement lives in the body, where it belongs — and it is re-stated on
 * every occurrence, because a stale figure in an issue is how the loop ends up
 * working from a number that is no longer true.
 *
 * DEPLOY LATENCY IS NOT A REGRESSION
 * ---------------------------------------------------------------------------
 * Regression issues carry `consecutiveGate: 2`: the first observation lands as
 * a breadcrumb, only the second consecutive one escalates. Between a merge and
 * the pages being served there is a full deploy, so a single scan seeing the
 * old HTML is the normal state right after a fix — reporting it as a
 * regression would make the loop chase its own tail.
 *
 * Usage:
 *   node scripts/ci/information-gain-loop-issues.mjs --verdict=verdict.json
 *   node scripts/ci/information-gain-live-scan.mjs --json | node scripts/ci/information-gain-loop-issues.mjs
 */

import { readFileSync } from 'node:fs';
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';

const WORKFLOW = process.env.GITHUB_WORKFLOW ?? 'Information Gain Scan';
const RUN_URL =
  process.env.GITHUB_RUN_URL ??
  (process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '');
const DRY_RUN = process.argv.includes('--dry-run');

const pct = (v) => `${Number(v).toFixed(1).replace('.', ',')} %`;

const titles = {
  regression: (label) => `${label} — information gain sotto il floor`,
  ratchet: (label) => `${label} — inventario information gain da togliere`,
  opportunity: (label) => `${label} — information gain sotto il target del 40%`,
};

const worstList = (worst = []) =>
  worst.length === 0
    ? '_(nessuna pagina campionata)_'
    : worst.map((p) => `- \`${p.urlPath}\` — ${pct(p.igs)}`).join('\n');

const METHOD_NOTE = `Metrica, maschere e procedura per rimisurare: \`docs/INFORMATION-GAIN.md\`.
Comando: \`node scripts/ci/information-gain-live-scan.mjs --per-family=12\`.`;

function regressionBody(r, verdict) {
  const cause =
    r.reason === 'regressed-vs-inventory'
      ? `La coorte è **nell'inventario** \`KNOWN_LOW_GAIN_COHORTS\` con ${pct(r.recorded)} ed è scesa a ${pct(r.medianIgs)}, oltre la tolleranza di 1,5 punti.`
      : `La coorte **non è nell'inventario** e sta sotto il floor di ${pct(verdict.floor)}.`;

  return `## Misura

${cause}

| | valore |
|---|---|
| coorte | \`${r.label}\` |
| median information gain | **${pct(r.medianIgs)}** |
| pagine campionate | ${r.pages} |
| pagine che non aggiungono **niente** alle sorelle | **${r.zeroGainPages}** |
| floor del gate | ${pct(verdict.floor)} |
| misurato il | ${verdict.ranAt} |

Le peggiori del campione:

${worstList(r.worst)}

## Cosa significa

Su queste pagine la prosa è quella delle sorelle con il nome dell'entità e
qualche cifra sostituiti. Togliendole dall'indice il corpus non sarebbe meno
completo: è la definizione di gain zero. \`audit-content-duplicates\` resta verde
su tutte, perché una cifra diversa basta a rompere uno SHA-256.

## Come si chiude

Dare alle pagine un elemento che **solo quella pagina** può avere, costruito da
dati che già possediamo. Nell'ordine, dal più efficace:

1. un payload proprio (offerte reali, snapshot di dati nostri, il confronto con
   i vicini — è quello che porta i profili datore al 50 %);
2. togliere i blocchi identici su ogni pagina (contano nel denominatore e non
   nel numeratore: rimuoverne uno alza il gain due volte);
3. far dire alla prosa i numeri della pagina, con i nomi delle entità coinvolte.

Il modello già in produzione è
\`build-plugins/shared/nearestMunicipalityComparison.ts\` (#5002): i vicini di
un'entità sono unici di quell'entità, quindi il blocco è page-specific per
costruzione e non per scrittura.

**Non funziona**, ed è il motivo per cui la metrica maschera i numeri: allungare
il testo, riscrivere le stesse informazioni con parole diverse, aggiungere una
sezione uguale su tutte le pagine.

**Criterio di chiusura:** la coorte torna sopra ${pct(verdict.floor)} nel prossimo
scan, che chiude questa issue da sé.

${METHOD_NOTE}`;
}

function ratchetBody(r, verdict) {
  return `## Misura

La coorte \`${r.label}\` è registrata in \`KNOWN_LOW_GAIN_COHORTS\`
(\`scripts/audit-information-gain.mjs\`) con ${pct(r.recorded)}, ma oggi misura
**${pct(r.medianIgs)}**, sopra il floor di ${pct(verdict.floor)}.

Misurato il ${verdict.ranAt}.

## Cosa serve

Togliere la riga \`['${r.label}', ${r.recorded}]\` da \`KNOWN_LOW_GAIN_COHORTS\`.

L'inventario è un ratchet che può solo **scendere**: finché la riga c'è, il gate
protegge quella coorte da un peggioramento ma non le chiede più di stare sopra
il floor come a tutte le altre. Toglierla è ciò che stringe il gate — ed è
l'unico modo in cui si stringe.

Nessun altro cambiamento: il floor, la tolleranza e le altre righe restano come
sono.

**Criterio di chiusura:** la riga non c'è più e \`npm test\` è verde. Lo scan
successivo non riapre nulla perché la coorte non è più nell'inventario.

${METHOD_NOTE}`;
}

function opportunityBody(o, verdict) {
  return `## Misura

È la coorte **più bassa fra quelle sane**: sta sopra il floor, quindi nessun
gate la blocca, ma resta lontana dal target del ${verdict.target} % che #5002 si
era dato.

| | valore |
|---|---|
| coorte | \`${o.label}\` |
| median information gain | **${pct(o.medianIgs)}** |
| pagine campionate | ${o.pages} |
| target | ${verdict.target} % |
| misurato il | ${verdict.ranAt} |

Le pagine che contribuiscono meno:

${worstList(o.worst)}

Per confronto, nella stessa run la coorte migliore del sito — i profili datore,
stesso shell e stessa nav, ma un payload per pagina reale — sta intorno al 50 %.

## Perché è una issue e non un rosso

Il gate misura «l'emissione si è rotta». Questa non è rotta: aggiunge poco. Ne
esce una alla volta, la peggiore, perché è una **coda di miglioramento** e una
coda che apre dieci issue al giorno viene silenziata.

## Come si chiude

Le stesse tre leve della sezione «Come si chiude» delle regressioni, in ordine
di efficacia: un payload proprio, la rimozione dei blocchi identici, la prosa
che dice i numeri della pagina. Il modello è
\`build-plugins/shared/nearestMunicipalityComparison.ts\`.

**Criterio di chiusura:** la coorte arriva a ${verdict.target} % — o, se il
dataset di quella famiglia non contiene niente di più che sia per-pagina, la
issue si chiude con la spiegazione di **quale fatto mancherebbe**, che è
un'informazione utile quanto la fix.

${METHOD_NOTE}`;
}

async function main() {
  const verdictArg = process.argv.find((a) => a.startsWith('--verdict='));
  const raw = verdictArg
    ? readFileSync(verdictArg.slice('--verdict='.length), 'utf8')
    : readFileSync(0, 'utf8');
  const verdict = JSON.parse(raw);

  const opened = [];
  const resolved = [];

  const open = async (title, description, { priority, labels, consecutiveGate = 0 }) => {
    if (DRY_RUN) {
      console.log(`[dry-run] APRIREI: ${title}`);
      opened.push(title);
      return;
    }
    const res = await createGithubIssue({
      title,
      description,
      priority,
      labels,
      workflow: WORKFLOW,
      consecutiveGate,
    });
    if (res) opened.push(title);
  };

  const resolve = (title) => {
    if (DRY_RUN) {
      console.log(`[dry-run] RISOLVEREI: ${title}`);
      resolved.push(title);
      return;
    }
    const res = resolveGithubIssue(title, { workflow: WORKFLOW, runUrl: RUN_URL });
    if (res) resolved.push(title);
  };

  for (const r of verdict.regressions ?? []) {
    // priority 2: è un difetto di contenuto su una famiglia intera, non un
    // incidente di produzione. consecutiveGate 2: vedi la nota sulla latenza
    // di deploy nell'header.
    await open(titles.regression(r.label), regressionBody(r, verdict), {
      priority: 2,
      labels: ['Bug', 'seo'],
      consecutiveGate: 2,
    });
  }

  for (const r of verdict.ratchets ?? []) {
    await open(titles.ratchet(r.label), ratchetBody(r, verdict), {
      priority: 3,
      labels: ['seo'],
    });
  }

  if (verdict.opportunity) {
    await open(titles.opportunity(verdict.opportunity.label), opportunityBody(verdict.opportunity, verdict), {
      priority: 3,
      labels: ['enhancement', 'seo'],
    });
  }

  // Auto-resolve: ogni coorte misurata in questa run che NON è nel rispettivo
  // bucket ha la sua condizione rientrata. È la metà che rende il ciclo chiuso
  // — senza, resterebbero issue che nessuno chiude (la classe di difetto di
  // #5437: un titolo che promette un auto-resolve inesistente).
  const regressed = new Set((verdict.regressions ?? []).map((r) => r.label));
  const ratcheting = new Set((verdict.ratchets ?? []).map((r) => r.label));
  const opportunityLabel = verdict.opportunity?.label ?? null;

  for (const cohort of verdict.cohorts ?? []) {
    if (!regressed.has(cohort.label)) resolve(titles.regression(cohort.label));
    // Il resolve del ratchet solo per le coorti che SONO nell'inventario: una
    // coorte che non c'è non può avere una issue «togli la riga», e ogni
    // resolve costa una ricerca `gh`. Con dodici coorti erano dodici ricerche
    // per chiudere niente.
    if (cohort.recorded !== null && !ratcheting.has(cohort.label)) {
      resolve(titles.ratchet(cohort.label));
    }
    // La issue di opportunità si chiude solo quando la coorte ha RAGGIUNTO il
    // target, non quando un'altra famiglia è diventata la peggiore: altrimenti
    // il lavoro in corso su questa verrebbe chiuso sotto i piedi di chi lo fa.
    if (cohort.medianIgs >= verdict.target && cohort.label !== opportunityLabel) {
      resolve(titles.opportunity(cohort.label));
    }
  }

  console.log(
    `[information-gain-loop-issues] aperte/aggiornate ${opened.length}, risolte ${resolved.length}` +
      (DRY_RUN ? ' (dry-run)' : ''),
  );
}

main().catch((err) => {
  console.error('[information-gain-loop-issues] fatal', err);
  process.exit(1);
});
