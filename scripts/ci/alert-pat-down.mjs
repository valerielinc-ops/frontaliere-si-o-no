/**
 * alert-pat-down.mjs — inline alert deterministico (zero-Claude) per il
 * degrado "GITHUB_PAT non caricato da Remote Config".
 *
 * Root cause: i workflow del loop autonomo (followup-drainer, auto-merge,
 * issue-triage, pr-autorebase, recycle-stale-prs) a PAT mancante degradano
 * SILENZIOSAMENTE — merge senza cascade deploy/followup, coda follow-up
 * congelata, routing inerte, PR chiuse senza re-queue — con un semplice
 * ::warning che nessuno legge. Il monitor daily `gh-pat-expiry-monitor.yml`
 * copre il caso ma con latenza fino a ~24h (cron 06:30): un PAT-down alle
 * 07:00 lascia il loop degradato quasi un giorno intero.
 *
 * Questo script chiude la finestra: ogni workflow consumer lo invoca inline
 * nel momento in cui rileva `env.GITHUB_PAT` vuoto (unico segnale affidabile:
 * `load-rc-env.mjs` esce SEMPRE 0 by-design). Il titolo è IDENTICO a quello
 * del monitor → il dedup di github-issue-creator converge sull'issue canonica
 * e l'auto-close-on-recovery del monitor resta l'unico punto di chiusura.
 *
 * ⚠ Tenere PAT_DOWN_TITLE in sync con LOAD_FAIL_TITLE in
 * .github/workflows/gh-pat-expiry-monitor.yml (literal duplicato lì perché il
 * monitor è bash-in-YAML; questo modulo è la copia canonica lato code).
 *
 * Uso (da workflow step, GH_TOKEN=GITHUB_TOKEN — NON il PAT: è la cosa rotta):
 *   node scripts/ci/alert-pat-down.mjs --workflow "<nome>" --run-url "<url>"
 *
 * Mai label `follow-up` (il triage la instraderebbe in coda fixer: il fixer
 * non può fixare un outage di Remote Config). Solo `automation` + urgent.
 */
import { createGithubIssue } from '../lib/github-issue-creator.mjs';

export const PAT_DOWN_TITLE = 'Agent loop down: GITHUB_PAT failed to load';

const argv = process.argv.slice(2);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : '';
};

if (process.argv[1]?.endsWith('alert-pat-down.mjs')) {
  const workflow = opt('--workflow') || 'unknown-workflow';
  const runUrl = opt('--run-url') || '';
  const description =
    `Rilevato INLINE da \`${workflow}\`${runUrl ? ` (${runUrl})` : ''}: ` +
    '`env.GITHUB_PAT` vuoto dopo `scripts/load-rc-env.mjs` (che esce sempre 0 — ' +
    'il segnale è solo l\'env vuoto). Il workflow ha degradato al suo percorso ' +
    'inerte/fallback: cascade merge→deploy→followup, drain della coda follow-up, ' +
    'routing triage e re-queue recycle sono FERMI finché il PAT non torna.\n\n' +
    'Cause probabili: Remote Config outage · `FIREBASE_SERVICE_ACCOUNT_JSON` ' +
    'assente/ruotato · param `GITHUB_PAT` cancellato da RC · PAT revocato.\n\n' +
    'Recovery: l\'issue si auto-chiude al prossimo run verde di ' +
    '`gh-pat-expiry-monitor.yml` (stesso titolo canonico → dedup).';
  createGithubIssue({
    title: PAT_DOWN_TITLE,
    description,
    priority: 1,
    labels: ['automation'],
    workflow,
  }).then(
    () => console.log('PAT-down alert emesso (o recurrence commentata sull\'issue canonica).'),
    (e) => {
      // Best-effort: l'alert non deve mai rompere il workflow chiamante.
      console.log(`::warning::alert-pat-down fallito: ${String(e).slice(0, 200)}`);
    },
  );
}
