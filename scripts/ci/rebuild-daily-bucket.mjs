#!/usr/bin/env node
/**
 * rebuild-daily-bucket.mjs — rigenera titolo e corpo CANONICI di un bucket
 * follow-up giornaliero riscritto fuori formato, passando da `rebuildDailyBody`
 * (lo stesso ricostruttore del gate sul conio).
 *
 * Il difetto. Il reconciler apriva l'allarme «Bucket follow-up illeggibile dal
 * parser» e chiedeva di «rigenerare il corpo canonico dagli item noti» — a
 * mano. Una riscrittura a mano e' esattamente come il bucket era uscito dal
 * formato (8705, 29-09: titolo «… — status reconciled 2026-09-29»,
 * `- State: open — …` in testa, `- State: done.` negli item), e nessuno la
 * faceva: il bucket restava fermo, con il gate sul conio e il drainer bloccati
 * dallo stesso veto.
 *
 * Cosa normalizza, e SOLO questo:
 *   - titolo `follow-up(daily:<key>): <N> items — <owner/repo>`;
 *   - testa: `- State:` diverso da `collecting` → `sealed` (il testo libero
 *     resta in `- Nota sullo stato:`), `Daily key` e `Target repository` se
 *     mancano, backtick attorno al repository;
 *   - item: heading `### FU-<key>-NNN — titolo`; `- State:` ridotto alla parola
 *     iniziale `open|in-progress|done|blocked` (il resto diventa
 *     `- Nota sullo stato:`); backtick attorno al `Target repository`.
 * Non indovina mai: uno `State` che non comincia con una delle quattro parole,
 * due `State` nello stesso item, ID fuori dalla daily key o un repository di
 * item diverso dalla testa → rifiuto, nessuna scrittura. Il risultato deve
 * superare `bucketStructuralVeto` e conservare ID, ordine e stati.
 *
 *   node scripts/ci/rebuild-daily-bucket.mjs --issue <N> --repo <owner/repo> [--out <file>] [--write]
 *
 * Senza `--write` stampa l'anteprima e salva il corpo in `--out` (default nella
 * tmpdir). Con `--write` rilegge la issue e scrive solo se titolo e corpo non
 * sono cambiati dalla prima lettura.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FOLLOWUP_ITEM_ID_SINGLE_RE,
  dailyBucketInfo,
  dailyBucketTitle,
  dailyKeyFromBucketBody,
  followupItemDailyKey,
  hasUnterminatedMarkdownFence,
  parseFollowupItems,
} from './followup-resolution-match.mjs';
import { rebuildDailyBody } from './gate-minted-followups.mjs';
import { bucketStructuralVeto } from './reconcile-followups.mjs';

const REPOSITORY_SLUG_RE = /^[\w.-]+\/[\w.-]+$/u;
const ITEM_STATE_RE = /^(open|in-progress|done|blocked)(?![\w-])\s*[.:;,—–-]?\s*(.*)$/iu;
const HEAD_STATE_RE = /^(\s*(?:-\s+)?)State\s*:\s*(.*?)\s*$/iu;
const ITEM_STATE_LINE_RE = /^(\s*-\s+)State\s*:\s*(.*?)\s*$/iu;
const REPO_LINE_RE = /^(\s*(?:-\s+)?Target repository\s*:\s*)`([^`]*)`\s*$/iu;
const STATE_NOTE = 'Nota sullo stato';

/** Righe di Markdown con il flag «protetta» (recinto ``` / ~~~ o citazione). */
function markdownLines(text) {
  let fence = null;
  return String(text || '').split('\n').map((line) => {
    const opener = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fence) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = null;
      return { line, protected: true };
    }
    if (opener) { fence = opener[1]; return { line, protected: true }; }
    return { line, protected: /^\s*>/u.test(line) };
  });
}

function stripRepositoryBackticks(line) {
  const match = REPO_LINE_RE.exec(line);
  return match ? `${match[1]}${match[2].trim()}` : line;
}

function liveFieldValues(text, re) {
  return markdownLines(text).filter((record) => !record.protected).map((record) => re.exec(record.line)).filter(Boolean);
}

function repositoryValues(text, { dash }) {
  const re = dash
    ? /^\s*-\s+Target repository\s*:\s*`?([^`]*?)`?\s*$/iu
    : /^\s*(?:-\s+)?Target repository\s*:\s*`?([^`]*?)`?\s*$/iu;
  return liveFieldValues(text, re).map((match) => match[1].trim());
}

/**
 * Titolo e corpo canonici di un bucket giornaliero, o il motivo del rifiuto.
 * Puro: nessuna I/O.
 * @param {{title: string, body: string}} issue
 * @returns {{ok: true, title: string, body: string, changes: string[]} | {ok: false, reason: string}}
 */
export function canonicalDailyBucket({ title, body }) {
  const fail = (reason) => ({ ok: false, reason });
  const source = String(body || '');
  if (hasUnterminatedMarkdownFence(source)) return fail('unterminated-markdown-fence');
  const items = parseFollowupItems(source);
  if (!items.length) return fail('no-items');

  const titleInfo = dailyBucketInfo(title || '');
  const bodyKey = dailyKeyFromBucketBody(source);
  const key = titleInfo?.dailyKey || bodyKey;
  if (!key) return fail('daily-key-missing');
  if (titleInfo && bodyKey && titleInfo.dailyKey !== bodyKey) return fail(`daily-key-mismatch:${titleInfo.dailyKey}/${bodyKey}`);

  const ids = items.map((item) => String(item.id || '').toUpperCase());
  const badId = ids.find((id) => !FOLLOWUP_ITEM_ID_SINGLE_RE.test(id) || followupItemDailyKey(id) !== key);
  if (badId !== undefined) return fail(`item-id:${badId || 'senza-id'}`);
  if (new Set(ids).size !== ids.length) return fail('item-id-duplicate');

  const head = source.slice(0, items[0].start);
  const headRepos = repositoryValues(head, { dash: false });
  if (headRepos.length > 1) return fail('head-target-repository-ambiguous');
  const itemRepos = items.flatMap((item) => repositoryValues(item.text, { dash: true }));
  const titleRepo = titleInfo && REPOSITORY_SLUG_RE.test(titleInfo.targetRepository) ? titleInfo.targetRepository : null;
  const uniqueItemRepos = [...new Set(itemRepos.map((repo) => repo.toLowerCase()))];
  const repo = headRepos[0] || titleRepo || (uniqueItemRepos.length === 1 ? itemRepos[0] : null);
  if (!repo || !REPOSITORY_SLUG_RE.test(repo)) return fail('target-repository-missing');
  if (itemRepos.some((value) => value.toLowerCase() !== repo.toLowerCase())) return fail('item-target-repository-mismatch');

  const changes = [];
  // Testa: State, Daily key, Target repository.
  const headStates = liveFieldValues(head, HEAD_STATE_RE);
  if (headStates.length > 1) return fail('head-state-ambiguous');
  const headLines = [];
  for (const record of markdownLines(head.replace(/\s+$/u, ''))) {
    if (record.protected) { headLines.push(record.line); continue; }
    const state = HEAD_STATE_RE.exec(record.line);
    if (state) {
      const value = state[2];
      const next = /^collecting$/iu.test(value) ? 'collecting' : 'sealed';
      headLines.push(`- State: ${next}`);
      if (value.toLowerCase() !== next) {
        headLines.push(`- ${STATE_NOTE}: ${value}`);
        changes.push(`testa: State «${value}» → ${next}`);
      }
      continue;
    }
    const unquoted = stripRepositoryBackticks(record.line);
    if (unquoted !== record.line) changes.push('testa: Target repository senza backtick');
    headLines.push(unquoted);
  }
  const insertAt = (() => {
    const batch = headLines.findIndex((line) => /^#{1,3}\s+Batch\b/iu.test(line));
    return batch >= 0 ? batch + 1 : 0;
  })();
  const missing = [];
  if (!liveFieldValues(head, /^\s*(?:-\s+)?Daily key\s*:\s*(.*)$/iu).length) missing.push(`- Daily key: ${key}`);
  if (!headStates.length) missing.push('- State: sealed');
  if (!headRepos.length) missing.push(`- Target repository: ${repo}`);
  if (missing.length) {
    headLines.splice(insertAt, 0, ...missing);
    changes.push(`testa: aggiunti ${missing.map((line) => line.replace(/:.*$/u, '').replace(/^-\s+/u, '')).join(', ')}`);
  }

  // Item: heading, State, Target repository.
  const expected = [];
  const rawItems = [];
  for (const item of items) {
    const id = item.id.toUpperCase();
    const [, ...rest] = item.raw.replace(/\s+$/u, '').split('\n');
    const heading = `### ${id} — ${item.title}`.replace(/\s+$/u, '');
    if (item.raw.split('\n')[0].trim() !== heading) changes.push(`${id}: heading`);
    const out = [heading];
    let states = 0;
    let state = null;
    for (const record of markdownLines(rest.join('\n'))) {
      if (record.protected) { out.push(record.line); continue; }
      const field = ITEM_STATE_LINE_RE.exec(record.line);
      if (field) {
        states += 1;
        const parsed = ITEM_STATE_RE.exec(field[2]);
        if (!parsed) return fail(`item-state-unreadable:${id}`);
        state = parsed[1].toLowerCase();
        out.push(`- State: ${state}`);
        if (parsed[2].trim()) out.push(`- ${STATE_NOTE}: ${parsed[2].trim()}`);
        if (field[2] !== state) changes.push(`${id}: State «${field[2]}» → ${state}`);
        continue;
      }
      const unquoted = stripRepositoryBackticks(record.line);
      if (unquoted !== record.line) changes.push(`${id}: Target repository senza backtick`);
      out.push(unquoted);
    }
    if (states === 0) return fail(`item-state-missing:${id}`);
    if (states > 1) return fail(`item-state-ambiguous:${id}`);
    expected.push(`${id}:${state}`);
    rawItems.push(out.join('\n'));
  }

  const nextTitle = dailyBucketTitle(key, repo, items.length);
  if (String(title || '') !== nextTitle) changes.unshift(`titolo → ${nextTitle}`);
  const nextBody = rebuildDailyBody(headLines.join('\n'), rawItems);
  const veto = bucketStructuralVeto({ title: nextTitle, body: nextBody });
  if (veto) return fail(`still-unreadable:${veto}`);
  const signature = parseFollowupItems(nextBody).map((item) => `${String(item.id).toUpperCase()}:${item.state}`);
  if (signature.join('\n') !== expected.join('\n')) return fail('item-signature-changed');
  return { ok: true, title: nextTitle, body: nextBody, changes };
}

function parseArgs(argv) {
  const args = { issue: null, repo: null, out: null, write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') args.write = true;
    else if (arg === '--issue') args.issue = argv[++i];
    else if (arg === '--repo') args.repo = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else throw new Error(`argomento sconosciuto: ${arg}`);
  }
  if (!/^\d+$/u.test(String(args.issue || ''))) throw new Error('--issue <numero> obbligatorio');
  if (!REPOSITORY_SLUG_RE.test(String(args.repo || ''))) throw new Error('--repo <owner/repo> obbligatorio');
  return args;
}

function readIssue(number, repo) {
  const raw = execFileSync('gh', ['issue', 'view', String(number), '--repo', repo, '--json', 'title,body'], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(raw);
  return { title: String(parsed.title || ''), body: String(parsed.body || '') };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const current = readIssue(args.issue, args.repo);
  const result = canonicalDailyBucket(current);
  if (!result.ok) {
    console.error(`#${args.issue}: rifiuto, nessuna scrittura (${result.reason}).`);
    process.exit(1);
  }
  if (result.title === current.title && result.body === current.body) {
    console.log(`#${args.issue}: gia' canonico, niente da scrivere.`);
    return;
  }
  const out = args.out || path.join(os.tmpdir(), `rebuild-daily-bucket-${args.issue}.md`);
  fs.writeFileSync(out, result.body);
  console.log(`#${args.issue}: titolo «${current.title}» → «${result.title}»`);
  for (const change of result.changes) console.log(`  - ${change}`);
  console.log(`corpo canonico: ${out}`);
  if (!args.write) {
    console.log('anteprima: nessuna scrittura (aggiungi --write).');
    return;
  }
  const latest = readIssue(args.issue, args.repo);
  if (latest.title !== current.title || latest.body !== current.body) {
    console.error(`#${args.issue}: titolo o corpo cambiati durante la rigenerazione → nessuna scrittura, rilancia.`);
    process.exit(1);
  }
  execFileSync('gh', ['issue', 'edit', String(args.issue), '--repo', args.repo, '--title', result.title, '--body-file', out], { stdio: 'inherit' });
  console.log(`#${args.issue}: scritto.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`rebuild-daily-bucket: ${String(e?.message ?? e).slice(0, 200)}`);
    process.exit(1);
  }
}
