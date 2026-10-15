#!/usr/bin/env node
/**
 * deploy-file-delta.mjs — "what changed in the artifact vs the previous deploy?"
 *
 * Writes a Markdown section to $GITHUB_STEP_SUMMARY (and stdout) summarising
 * how the freshly-built dist/ differs from the previous deploy. Two independent
 * signals, each robust on its own:
 *
 *   Signal 1 — net add/remove per plugin bucket (ALWAYS available).
 *     Source: the last two rows of data/dist-size-history.jsonl. That file is
 *     committed every deploy by `report-dist-bytes-by-plugin.mjs`, so the
 *     second-to-last row is the previous deploy and the last row is this one.
 *     Gives `+added / -removed` file counts per plugin (and totals). It is a
 *     stat-only signal: it cannot see a file that was rewritten in place
 *     (same path, new content) — that's what signal 2 is for.
 *
 *   Signal 2 — in-place CHANGED HTML pages (best-effort, claim-based).
 *     Source: two `content-manifest.tsv` files (`path<TAB>sha1`), the previous
 *     deploy's (restored from actions/cache) and this build's (emitted during
 *     the Vite build by writeRegistryReportPlugin from getPathHistory()). The
 *     sha1 is the one claim() already computes for collision detection, so this
 *     signal adds ZERO hashing to the build. Coverage = every HTML page routed
 *     through WriteCollector/claim() (the ~1.2M job-SEO pages + static pages);
 *     binary assets (og PNGs) and direct fs.writeFile emits are NOT covered
 *     here — their churn shows up in signal 1 as add/remove instead. The hash
 *     is captured at claim() time, i.e. BEFORE any deterministic post-walk
 *     mutation; it is therefore a reliable change-DETECTOR as long as the
 *     post-walk logic is unchanged between the two deploys, not a byte-image of
 *     the shipped file. When either manifest is missing (first deploy after
 *     enabling this, or cache miss) the section degrades gracefully to a note.
 *
 * Usage:
 *   node scripts/deploy-file-delta.mjs \
 *     [--history=data/dist-size-history.jsonl] \
 *     [--prev-manifest=prev-content-manifest.tsv] \
 *     [--cur-manifest=content-manifest.tsv] \
 *     [--top=15]
 *
 * Never fails the deploy: any error is caught and reported as a note in the
 * summary (exit 0). This is observability, not a gate.
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

function parseArgs(argv) {
  const out = {
    history: 'data/dist-size-history.jsonl',
    prevManifest: 'prev-content-manifest.tsv',
    curManifest: 'content-manifest.tsv',
    top: 15,
  };
  for (const arg of argv) {
    if (arg.startsWith('--history=')) out.history = arg.slice('--history='.length);
    else if (arg.startsWith('--prev-manifest=')) out.prevManifest = arg.slice('--prev-manifest='.length);
    else if (arg.startsWith('--cur-manifest=')) out.curManifest = arg.slice('--cur-manifest='.length);
    else if (arg.startsWith('--top=')) out.top = Math.max(1, Number(arg.slice('--top='.length)) || 15);
  }
  return out;
}

/** Read the last two non-empty JSONL rows without loading the whole file. */
function lastTwoRows(historyPath) {
  if (!existsSync(historyPath)) return { prev: null, cur: null };
  const lines = readFileSync(historyPath, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  const parse = (l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  };
  const cur = lines.length >= 1 ? parse(lines[lines.length - 1]) : null;
  const prev = lines.length >= 2 ? parse(lines[lines.length - 2]) : null;
  return { prev, cur };
}

function fmtSigned(n) {
  return n > 0 ? `+${n.toLocaleString('en-US')}` : n.toLocaleString('en-US');
}

/** Signal 1: per-plugin file-count delta between two dist-size-history rows. */
function buildSignal1(prev, cur) {
  if (!cur) return { lines: ['_Nessuna riga in dist-size-history.jsonl — niente baseline._'] };
  if (!prev) {
    return {
      lines: [
        `Primo deploy registrato (run \`${cur.runId}\`): **${(cur.totalFiles || 0).toLocaleString('en-US')}** file totali, nessun deploy precedente con cui confrontare.`,
      ],
    };
  }

  const prevByPlugin = prev.byPlugin || {};
  const curByPlugin = cur.byPlugin || {};
  const names = new Set([...Object.keys(prevByPlugin), ...Object.keys(curByPlugin)]);

  const rows = [];
  for (const name of names) {
    const p = prevByPlugin[name]?.files || 0;
    const c = curByPlugin[name]?.files || 0;
    const d = c - p;
    if (d !== 0) rows.push({ name, prev: p, cur: c, delta: d });
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const totalPrev = prev.totalFiles || 0;
  const totalCur = cur.totalFiles || 0;
  const totalDelta = totalCur - totalPrev;

  const lines = [];
  lines.push(
    `Totale file: **${totalCur.toLocaleString('en-US')}** (${fmtSigned(totalDelta)} vs run precedente \`${prev.runId}\` → \`${cur.runId}\`)`,
  );
  lines.push('');
  if (rows.length === 0) {
    lines.push('_Nessun bucket plugin ha cambiato numero di file (possibili solo modifiche in-place → vedi sotto)._');
  } else {
    lines.push('| Bucket plugin | Prima | Dopo | Δ file |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const r of rows.slice(0, 30)) {
      lines.push(`| \`${r.name}\` | ${r.prev.toLocaleString('en-US')} | ${r.cur.toLocaleString('en-US')} | ${fmtSigned(r.delta)} |`);
    }
    if (rows.length > 30) lines.push(`| _…+${rows.length - 30} altri bucket_ | | | |`);
  }
  return { lines };
}

/** Load a path<TAB>sha1 manifest into a Map. Streamed to bound memory. */
async function loadManifest(file) {
  const map = new Map();
  if (!existsSync(file)) return null;
  const rl = createInterface({ input: createReadStream(file, 'utf-8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    map.set(line.slice(0, tab), line.slice(tab + 1));
  }
  return map;
}

/** Signal 2: added / removed / changed HTML pages between two claim manifests. */
async function buildSignal2(prevFile, curFile, top) {
  const cur = await loadManifest(curFile);
  if (!cur) {
    return { lines: ['_Manifest contenuti di questo build assente (signal 2 non emesso) — solo add/remove sopra._'] };
  }
  const prev = await loadManifest(prevFile);
  if (!prev) {
    return {
      lines: [
        `_Nessun manifest del deploy precedente (cache miss / primo run). Baseline registrata: **${cur.size.toLocaleString('en-US')}** pagine HTML tracciate._`,
      ],
    };
  }

  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  const changedSample = [];
  for (const [path, hash] of cur) {
    const prevHash = prev.get(path);
    if (prevHash === undefined) added += 1;
    else if (prevHash !== hash) {
      changed += 1;
      if (changedSample.length < top) changedSample.push(path);
    } else unchanged += 1;
  }
  for (const path of prev.keys()) {
    if (!cur.has(path)) removed += 1;
  }

  const lines = [];
  lines.push(
    `Pagine HTML tracciate (claim-based): **${cur.size.toLocaleString('en-US')}**`,
  );
  lines.push('');
  lines.push('| | Conteggio |');
  lines.push('| --- | ---: |');
  lines.push(`| ✏️ Modificate in-place | **${changed.toLocaleString('en-US')}** |`);
  lines.push(`| ➕ Aggiunte | ${added.toLocaleString('en-US')} |`);
  lines.push(`| ➖ Rimosse | ${removed.toLocaleString('en-US')} |`);
  lines.push(`| ⏸️ Invariate | ${unchanged.toLocaleString('en-US')} |`);
  if (changedSample.length > 0) {
    lines.push('');
    lines.push('<details><summary>Esempio pagine modificate</summary>');
    lines.push('');
    for (const p of changedSample) lines.push(`- \`${p}\``);
    lines.push('');
    lines.push('</details>');
  }
  return { lines };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = [];
  out.push('## 📦 File delta vs deploy precedente');
  out.push('');

  try {
    const { prev, cur } = lastTwoRows(args.history);
    out.push('### Net add/remove per bucket (stat-based, sempre disponibile)');
    out.push('');
    out.push(...buildSignal1(prev, cur).lines);
  } catch (err) {
    out.push(`_Signal 1 fallito: ${err?.message || err}_`);
  }

  out.push('');
  try {
    out.push('### Modifiche in-place HTML (claim-based, best-effort)');
    out.push('');
    const s2 = await buildSignal2(args.prevManifest, args.curManifest, args.top);
    out.push(...s2.lines);
  } catch (err) {
    out.push(`_Signal 2 fallito: ${err?.message || err}_`);
  }

  out.push('');
  out.push(
    '<sub>Signal 1 = differenza di numero file per bucket (non vede i file riscritti a parità di path). '
    + 'Signal 2 = pagine HTML il cui contenuto è cambiato, hash sha1 calcolato da claim() al momento della scrittura '
    + '(copre le pagine via WriteCollector; asset binari/og non inclusi → compaiono nel Signal 1).</sub>',
  );

  const block = out.join('\n') + '\n';
  // eslint-disable-next-line no-console
  console.log(block);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      appendFileSync(summaryFile, block);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[deploy-file-delta] could not append to step summary: ${err?.message || err}`);
    }
  }
}

main().catch((err) => {
  // Observability only — never fail the deploy.
  // eslint-disable-next-line no-console
  console.error(`[deploy-file-delta] non-fatal error: ${err?.stack || err}`);
  process.exit(0);
});
