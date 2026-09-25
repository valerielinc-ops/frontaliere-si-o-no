#!/usr/bin/env node
/**
 * Misura riproducibile dei round del 🔴-fixer: su quante PR ha lavorato, a
 * quale round la review è tornata `## LGTM`, quante sono finite al round cap
 * e quanti round Codex sono stati spesi.
 *
 *   node scripts/ci/measure-redflag-rounds.mjs --repo owner/repo --since 2026-09-15 --until 2026-09-25
 *
 * Serve a decidere il round cap (`MAX_ROUNDS` in pr-redflag-fixer.yml) con un
 * numero ricalcolabile invece che con una stima scritta a mano, e a rimisurare
 * dopo ogni cambio del contratto review ↔ fixer.
 *
 * Fonte: i marker `<!-- REDFLAG_FIX_ROUND: N ... -->` che il fixer pubblica
 * all'avvio di ogni round (un round rimborsato cancella il suo marker, quindi
 * i marker presenti sono i round consumati), le review del bot e il marker di
 * escalation `<!-- NEEDS_HUMAN_ESCALATION: redflag -->`.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const ROUND_RE = /<!-- REDFLAG_FIX_ROUND: (\d+)\b/u;
const ESCALATION_MARKER = '<!-- NEEDS_HUMAN_ESCALATION: redflag';
const REVIEWER_RE = /^(?:claude(?:\[bot\])?|frontaliere-automation(?:\[bot\])?)$/iu;
const LGTM_RE = /^##\s*LGTM\b/mu;

/**
 * @param {{number:number, state:string, comments:{createdAt:string, body:string}[],
 *   reviews:{submittedAt:string, body:string, author:string}[], truncated?:boolean}} pr
 */
export function redflagRoundsOfPr(pr) {
  const markers = (pr.comments || [])
    .map((c) => ({ at: c.createdAt, round: Number(String(c.body || '').match(ROUND_RE)?.[1] || 0) }))
    .filter((m) => m.round > 0)
    .sort((a, b) => a.at.localeCompare(b.at));
  if (markers.length === 0) return null;
  const reviews = (pr.reviews || [])
    .filter((r) => REVIEWER_RE.test(r.author || ''))
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  let convergedAtRound = 0;
  for (const [i, marker] of markers.entries()) {
    const next = markers[i + 1]?.at ?? '￿';
    if (reviews.some((r) => r.submittedAt > marker.at && r.submittedAt < next && LGTM_RE.test(r.body || ''))) {
      convergedAtRound = marker.round;
      break;
    }
  }
  return {
    number: pr.number,
    merged: pr.state === 'MERGED',
    rounds: markers.length,
    maxRound: Math.max(...markers.map((m) => m.round)),
    convergedAtRound,
    escalated: (pr.comments || []).some((c) => String(c.body || '').includes(ESCALATION_MARKER)),
    truncated: Boolean(pr.truncated),
  };
}

/** Aggregato su tutte le PR con almeno un round del 🔴-fixer. */
export function summarizeRedflagRounds(prs, { cap = 2 } = {}) {
  const rows = prs.map(redflagRoundsOfPr).filter(Boolean);
  const attempts = {};
  const converged = {};
  for (const row of rows) {
    for (let k = 1; k <= row.maxRound; k += 1) attempts[k] = (attempts[k] || 0) + 1;
    if (row.convergedAtRound) converged[row.convergedAtRound] = (converged[row.convergedAtRound] || 0) + 1;
  }
  const totalAttempts = Object.values(attempts).reduce((a, b) => a + b, 0);
  const totalConverged = Object.values(converged).reduce((a, b) => a + b, 0);
  const perRound = totalAttempts ? totalConverged / totalAttempts : 0;
  const stuckAtCap = rows.filter((r) => r.maxRound >= cap && !r.convergedAtRound).length;
  return {
    prs: rows.length,
    roundsConsumed: rows.reduce((a, r) => a + r.rounds, 0),
    attempts,
    converged,
    notConverged: rows.filter((r) => !r.convergedAtRound).length,
    escalated: rows.filter((r) => r.escalated).length,
    merged: rows.filter((r) => r.merged).length,
    perRoundConvergence: perRound,
    stuckAtCap,
    // Con un round in più, le PR ferme al cap convergerebbero al tasso per
    // round osservato: è una stima, e il costo è un round Codex per ognuna.
    extraRoundEstimate: { extraCodexRounds: stuckAtCap, expectedConverged: stuckAtCap * perRound },
    truncated: rows.filter((r) => r.truncated).map((r) => r.number),
    rows,
  };
}

export function renderSummary(summary, { repo, since, until, cap }) {
  const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : 'n/d');
  const lines = [
    `Misura 🔴-fixer — ${repo}, PR create fra ${since} e ${until}, cap attuale ${cap}.`,
    '',
    '| Round | PR che lo hanno avviato | LGTM a quel round | Tasso |',
    '|---|---|---|---|',
  ];
  for (const k of Object.keys(summary.attempts).map(Number).sort((a, b) => a - b)) {
    const c = summary.converged[k] || 0;
    lines.push(`| ${k} | ${summary.attempts[k]} | ${c} | ${pct(c, summary.attempts[k])} |`);
  }
  lines.push(
    '',
    `- PR con almeno un round: ${summary.prs}; round Codex consumati: ${summary.roundsConsumed}.`,
    `- Convergite a \`## LGTM\` dopo un round: ${summary.prs - summary.notConverged}; non convergite: ${summary.notConverged}; escalate a \`needs-human\`: ${summary.escalated}; mergiate: ${summary.merged}.`,
    `- Tasso di convergenza per round: ${pct(summary.perRoundConvergence, 1)}.`,
    `- Ferme al cap senza LGTM: ${summary.stuckAtCap}. Con un round in più: +${summary.extraRoundEstimate.extraCodexRounds} round Codex, ~${summary.extraRoundEstimate.expectedConverged.toFixed(1)} PR convergite in più (stima al tasso per round).`,
  );
  if (summary.truncated.length) lines.push(`- Commenti troncati a 100 su: ${summary.truncated.map((n) => `#${n}`).join(', ')}.`);
  return lines.join('\n');
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function fetchPrs(repo, since, until) {
  const out = [];
  let after = null;
  for (;;) {
    const query = `query{search(query:${JSON.stringify(`repo:${repo} is:pr created:${since}..${until}`)},type:ISSUE,first:25${after ? `,after:${JSON.stringify(after)}` : ''}){pageInfo{hasNextPage endCursor} nodes{... on PullRequest{number state comments(first:100){totalCount nodes{createdAt body}} reviews(first:100){nodes{submittedAt body author{login}}}}}}}`;
    const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`])).data.search;
    for (const n of data.nodes) {
      if (!n?.number) continue;
      out.push({
        number: n.number,
        state: n.state,
        truncated: n.comments.totalCount > n.comments.nodes.length,
        comments: n.comments.nodes,
        reviews: n.reviews.nodes.map((r) => ({ submittedAt: r.submittedAt, body: r.body, author: r.author?.login || '' })),
      });
    }
    if (!data.pageInfo.hasNextPage) return out;
    after = data.pageInfo.endCursor;
  }
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const repo = arg('repo', process.env.GITHUB_REPOSITORY || '');
  const since = arg('since');
  const until = arg('until');
  const cap = Number(arg('cap', '2'));
  if (!repo || !since || !until) {
    console.error('uso: measure-redflag-rounds.mjs --repo owner/repo --since YYYY-MM-DD --until YYYY-MM-DD [--cap N]');
    process.exit(2);
  }
  const summary = summarizeRedflagRounds(fetchPrs(repo, since, until), { cap });
  console.log(renderSummary(summary, { repo, since, until, cap }));
}
