#!/usr/bin/env node

/**
 * check-main-ruleset-invariants.mjs — verifica che il Ruleset di `main` imponga
 * ancora il check `vitest (unit + integration)` come required status check.
 *
 * PERCHÉ ESISTE (follow-up #6590 di #6584)
 * ----------------------------------------
 * La protezione «un merge non può bypassare test rossi» non vive nel repo: vive
 * in una impostazione GitHub (il Ruleset su `refs/heads/main`). Il codice non la
 * vede, nessun test la copre, e se qualcuno disattiva il ruleset, ne cambia il
 * target o rimuove il context dall'elenco dei required checks, il ciclo
 * autonomo continua a mergiare come prima — solo che da quel momento
 * `auto-merge-on-lgtm` può portare su `main` una PR con il check vitest rosso, e
 * nessuno se ne accorge finché la produzione non si rompe.
 *
 * Il ruleset ATTIVO al 2026-09-03 (`main required CI checks`, id 21626297)
 * soddisfa l'invariante. Questo script la trasforma da stato osservato una volta
 * a stato OSSERVATO IN CONTINUO: è l'osservatore che manca a una configurazione
 * repo-level, ed è ciò che rende reversibile-e-sorvegliata la protezione (VISION
 * D1).
 *
 * Il nome del check NON è un literal qui: arriva da `VITEST_CHECK_NAME` in
 * `scripts/ci/lib/constants.mjs`, la stessa const che `auto-merge-eval.mjs` e
 * `pr-autorebase.mjs` consumano e che `tests/ci-vitest-check-name.test.ts` tiene
 * allineata al `name:` del job in `tests.yml`. Rinominare il job senza
 * aggiornare il Ruleset diventa quindi un allarme, non un silenzio.
 *
 * Read-only: nessuna scrittura, nessuna modifica alle impostazioni del repo.
 *
 * Usage:
 *   node scripts/ci/check-main-ruleset-invariants.mjs
 *   node scripts/ci/check-main-ruleset-invariants.mjs --json
 *   GH_REPO=owner/repo node scripts/ci/check-main-ruleset-invariants.mjs
 *
 * Exit code: 0 invariante rispettata · 1 violata · 2 impossibile determinare
 * (rete/credenziale) — un dubbio non è una violazione e non deve aprire alert.
 */

import { VITEST_CHECK_NAME } from './lib/constants.mjs';

/** Ref di `main` nelle `conditions.ref_name.include` di un ruleset branch. */
const MAIN_REFS = new Set(['refs/heads/main', '~DEFAULT_BRANCH', '~ALL']);

/**
 * Un ruleset protegge `main` se è attivo, ha target `branch`, include un ref di
 * `main` e non lo ri-esclude. `exclude` vince su `include` lato GitHub, quindi
 * un ruleset che include `~ALL` ma esclude `refs/heads/main` NON protegge nulla.
 */
export function rulesetGuardsMain(ruleset) {
  if (!ruleset || ruleset.enforcement !== 'active') return false;
  if ((ruleset.target ?? 'branch') !== 'branch') return false;
  const refName = ruleset.conditions?.ref_name ?? {};
  const include = Array.isArray(refName.include) ? refName.include : [];
  const exclude = Array.isArray(refName.exclude) ? refName.exclude : [];
  if (exclude.some((ref) => MAIN_REFS.has(ref))) return false;
  return include.some((ref) => MAIN_REFS.has(ref));
}

/** I context richiesti da un ruleset, tutti i suoi `required_status_checks`. */
export function requiredContexts(ruleset) {
  const rules = Array.isArray(ruleset?.rules) ? ruleset.rules : [];
  return rules
    .filter((rule) => rule?.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    .map((check) => check?.context)
    .filter((context) => typeof context === 'string');
}

/**
 * Valuta l'invariante sull'elenco COMPLETO dei ruleset (già espansi: la lista
 * `GET /rulesets` non contiene `rules`, serve il dettaglio per id).
 *
 * Il match sul context è byte-per-byte voluto: GitHub confronta il nome del
 * check-run alla lettera, quindi un match tollerante qui direbbe «protetto» su
 * una configurazione che non protegge niente.
 */
export function evaluateRulesets(rulesets) {
  const guarding = (Array.isArray(rulesets) ? rulesets : []).filter(rulesetGuardsMain);
  if (guarding.length === 0) {
    return {
      ok: false,
      reason: 'no-active-ruleset',
      message:
        'Nessun Ruleset ATTIVO con target `branch` protegge `refs/heads/main`: ' +
        'su `main` non è richiesto alcun status check, quindi un merge può ' +
        'atterrare con il check vitest rosso.',
      contexts: [],
    };
  }
  const contexts = [...new Set(guarding.flatMap(requiredContexts))];
  if (!contexts.includes(VITEST_CHECK_NAME)) {
    return {
      ok: false,
      reason: 'missing-required-check',
      message:
        `Il check \`${VITEST_CHECK_NAME}\` NON è fra i required status checks di ` +
        `\`main\`. Required attuali: ${contexts.length ? contexts.map((c) => `\`${c}\``).join(', ') : '(nessuno)'}.`,
      contexts,
    };
  }
  return {
    ok: true,
    reason: 'ok',
    message: `\`${VITEST_CHECK_NAME}\` è un required status check di \`main\`.`,
    contexts,
  };
}

async function ghJson(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'check-main-ruleset-invariants',
    },
  });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const asJson = process.argv.includes('--json');
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  if (!repo || !token) {
    console.error('::warning::GH_REPO o token assenti — invariante non verificabile, nessun verdetto.');
    process.exit(2);
  }

  let verdict;
  try {
    const list = await ghJson(`/repos/${repo}/rulesets`, token);
    const details = await Promise.all(
      list.map((ruleset) => ghJson(`/repos/${repo}/rulesets/${ruleset.id}`, token)),
    );
    verdict = evaluateRulesets(details);
  } catch (err) {
    // Rete o permesso: NON è una violazione. Un alert su un 5xx transitorio
    // insegnerebbe solo a ignorare l'alert.
    console.error(`::warning::Lettura dei ruleset fallita — ${err.message}`);
    process.exit(2);
  }

  if (asJson) console.log(JSON.stringify(verdict, null, 2));
  else console.log(verdict.ok ? `✅ ${verdict.message}` : `❌ ${verdict.message}`);
  process.exit(verdict.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
