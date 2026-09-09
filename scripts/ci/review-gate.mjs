#!/usr/bin/env node

/**
 * Gate della review Claude per tests.yml.
 *
 * Un finding 🔴 Important puo' essere declassato solo quando tutti i file che
 * cita sono risolti nel tree della PR e nessuno appartiene al diff corrente.
 * Le review successive non possono cancellare uno storico Important: resta
 * aperto finche' una review successiva conferma esplicitamente il fix dell'ancora
 * (`Fix di \`path:L<linea>\`: ok.` oppure, per un finding senza citazioni,
 * `Fix di \`testo normalizzato\`: ok.`), oppure il finding viene classificato
 * fuori dal diff.
 * Ogni informazione mancante resta bloccante: una lista incompleta, vuota o un
 * tree non risolvibile non autorizzano mai un'inferenza «fuori dal diff».
 */
import { execFileSync } from 'node:child_process';
import { realpathSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REDFLAG_IMPORTANT_RE } from './lib/constants.mjs';
import { fetchPrFiles } from './lib/fetchPrFiles.mjs';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';

export const FOLLOWUP_MARKER = 'OUT_OF_SCOPE_REVIEW_FOLLOWUP';
const MAX_FOLLOWUP_BODY_LEN = 60_000;
const ZERO_IMPORTANT_RE = /^(?:0|none|nessuno)\s*$/iu;
const IMPORTANT_MARKER_RE = /🔴\s*\*{0,2}\s*Important\s*\*{0,2}\s*[:—-]\s*/u;
const FINDING_MARKER_RE = /🔴|🟡\s*\*{0,2}\s*Nit\s*\*{0,2}\s*[:—-]|🟣\s*\*{0,2}\s*Pre-existing\s*\*{0,2}\s*[:—-]|❓\s*q\s*:/gu;
const REVIEWER_LOGIN_RE = /^(?:claude(?:\[bot\])?|frontaliere-automation\[bot\])$/iu;
const FIX_CONFIRMATION_RE = /^\s*(?:[-*]\s*)?Fix di\s+`([^`\n]+)`\s*:\s*ok\b/iu;
// L'alternanza delle estensioni e' first-match-wins: senza il lookahead finale
// `ts` vince su `tsx` e `js` su `json`/`jsx`, e la citazione viene troncata a un
// path che non esiste (`Foo.tsx:L107` -> `Foo.ts`). Un path non risolvibile e'
// bloccante per progetto, quindi il refuso teneva aperto per sempre un finding
// gia' confermato risolto. Il lookahead impone che l'estensione finisca davvero
// li', e rende l'ordine delle alternative irrilevante.
const FILE_CITATION_RE = /(?:^|[\s([{"'`])((?:\.\.?\/)?(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.(?:cjs|css|html|js|json|md|mjs|sh|ts|tsx|txt|toml|yaml|yml|jsx)(?![A-Za-z0-9]))(?:[:#]L?\d+(?:[-–]\d+)?)?/giu;

/**
 * Normalize a review citation without turning an unsafe/ambiguous path into a
 * different valid path. GitHub review locations may use `a/`, `b/` or `./`.
 */
export function normalizePath(value, { stripGitPrefix = true } = {}) {
  let path = String(value || '')
    .trim()
    .replace(/^['"`([{<]+|['"`\])}>.,;!?]+$/gu, '')
    .replace(/\\/gu, '/');
  if (!path || /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/|~\/)/u.test(path)) return '';
  if (path.split('/').includes('..')) return '';
  path = path.replace(/^\.\//u, '');
  if (stripGitPrefix) path = path.replace(/^[ab]\//u, '');
  return path.replace(/[:#]L?\d+(?:[-–]\d+)?$/iu, '');
}

function citationPathAndLine(rawPath, fullMatch) {
  const lineMatch = String(fullMatch || '').match(/[:#]L?(\d+)(?:[-–]\d+)?$/iu);
  return {
    path: normalizePath(rawPath),
    line: lineMatch ? Number(lineMatch[1]) : null,
  };
}

/** Extract file-like citations from one finding, deduplicated by path+line. */
export function extractFileCitations(text) {
  const citations = [];
  FILE_CITATION_RE.lastIndex = 0;
  for (const match of String(text || '').matchAll(FILE_CITATION_RE)) {
    const citation = citationPathAndLine(match[1], match[0]);
    if (citation.path) citations.push(citation);
  }
  const seen = new Set();
  return citations.filter((citation) => {
    const key = `${citation.path}:${citation.line || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isInsideCodeSpan(line, index) {
  return (String(line).slice(0, index).match(/`/gu) || []).length % 2 === 1;
}

function firstFindingMarker(line) {
  FINDING_MARKER_RE.lastIndex = 0;
  for (const match of String(line || '').matchAll(FINDING_MARKER_RE)) {
    if (!isInsideCodeSpan(line, match.index)) return match;
  }
  return null;
}

/**
 * A finding normally starts with `path:Lx:` before its severity marker. A
 * marker without a location is still a finding (and will remain unresolved),
 * while a marker quoted inside another finding is not a new boundary.
 */
function isFindingStart(line, marker) {
  if (!marker) return false;
  const prefix = String(line).slice(0, marker.index).trim();
  const structuralPrefix = prefix
    .replace(/^(?:[-*+>]\s*)+/u, '')
    .replace(/^(?:[_*~`]\s*)+/u, '')
    .trim();
  if (!structuralPrefix || /^[#*_~`]+$/u.test(structuralPrefix)) return true;
  if (extractFileCitations(structuralPrefix).length > 0) return true;
  return /(?:^|\s)(?:L?\d+)(?:[-–]\d+)?\s*:\s*$/iu.test(structuralPrefix)
    || /`[^`\n]+`\s*:\s*$/u.test(structuralPrefix);
}

function importantFindingLine(line) {
  REDFLAG_IMPORTANT_RE.lastIndex = 0;
  if (!REDFLAG_IMPORTANT_RE.test(String(line || ''))) return false;
  const candidates = [...String(line || '').matchAll(
    new RegExp(IMPORTANT_MARKER_RE.source, 'gu'),
  )];
  const marker = candidates.find((candidate) => !isInsideCodeSpan(line, candidate.index));
  // A marker quoted inside a code span is not a verdict. The shared regex is
  // deliberately the first gate, but this positional check also covers a
  // quoted marker preceded by ordinary text inside the span.
  if (!marker) return false;
  // `🔴 Important: 0`/`none`/`nessuno` is a count row only when the whole
  // remainder is that value. `🔴 Important: none of the branches...` remains a
  // real finding, even when its prose begins with a count word.
  return !ZERO_IMPORTANT_RE.test(String(line).slice(marker.index + marker[0].length).trim());
}

/**
 * Parse every real Important finding. Its text ends at the next finding of any
 * severity or at the next H2, so `## Adversarial check` and the summary cannot
 * leak paths into the previous finding.
 */
export function importantFindings(body) {
  const lines = String(body || '').split(/\r?\n/u);
  const markerLines = lines
    .map((line, index) => ({ line, index, marker: firstFindingMarker(line) }))
    .filter(({ marker }) => marker);
  const starts = markerLines
    .filter(({ line, marker }) => isFindingStart(line, marker))
    .map(({ index }) => index);
  const markers = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => importantFindingLine(line));

  return markers.map(({ line, index }, markerIndex) => {
    const nextFinding = starts.find((start) => start > index) ?? lines.length;
    const nextH2 = lines.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && /^##\s/u.test(candidate));
    const end = Math.min(nextFinding, nextH2 === -1 ? lines.length : nextH2);
    const text = lines.slice(index, end).join('\n').trim();
    const parserUncertain = markerLines.some(({ line: markerLine, index: markerIndex, marker }) =>
      markerIndex > index && markerIndex < end && !isFindingStart(markerLine, marker));
    return {
      line,
      text,
      lineNumber: index + 1,
      findingNumber: markerIndex + 1,
      citations: extractFileCitations(text),
      parserUncertain,
    };
  });
}

function suffixMatches(candidate, wanted) {
  return candidate === wanted || candidate.endsWith(`/${wanted}`);
}

/** Resolve a citation against a complete tree, or against the diff only. */
export function resolveCitedPath(citation, repositoryPaths) {
  const wanted = normalizePath(citation?.path);
  const paths = Array.isArray(repositoryPaths)
    ? [...new Set(repositoryPaths.map((path) => normalizePath(path, { stripGitPrefix: false })).filter(Boolean))]
    : [];
  if (!wanted) return { status: 'non-risolubile', path: null, candidates: [] };

  const candidates = paths.filter((path) => wanted.includes('/')
    ? suffixMatches(path, wanted)
    : path === wanted || path.endsWith(`/${wanted}`));
  if (candidates.length === 1) return { status: 'resolved', path: candidates[0], candidates };
  if (candidates.length > 1) return { status: 'non-risolubile', path: null, candidates };
  return { status: 'non-risolubile', path: null, candidates: [] };
}

function changedContains(changedFiles, resolvedPath) {
  return changedFiles.some((file) => file === resolvedPath || file.endsWith(`/${resolvedPath}`));
}

function emptyClassification(findings = []) {
  return {
    findings,
    outside: [],
    inScope: [],
    unresolved: [],
    outsideOnly: false,
    blocking: false,
  };
}

/**
 * Pure fail-closed classifier. `complete` must be exactly true and `files`
 * must be non-empty before a finding can be considered outside the diff.
 */
export function classifyReview(body, {
  files,
  complete,
  reason = 'diff non verificabile',
  repositoryPaths = null,
} = {}) {
  const findings = importantFindings(body);
  if (findings.length === 0) return emptyClassification(findings);

  const validFiles = Array.isArray(files)
    && files.length > 0
    && files.every((file) => typeof file === 'string' && Boolean(normalizePath(file, { stripGitPrefix: false })));
  if (complete !== true || !validFiles) {
    const diffReason = complete !== true
      ? `elenco file incompleto (${reason})`
      : 'elenco file vuoto o non valido';
    return {
      ...emptyClassification(findings),
      unresolved: findings.map((finding) => ({
        ...finding,
        reason: `diff non verificabile: ${diffReason}`,
      })),
      blocking: true,
    };
  }

  const changed = [...new Set(files.map((file) => normalizePath(file, { stripGitPrefix: false })).filter(Boolean))];
  // When the tree is unavailable, resolve only against the changed list. This
  // can prove an in-diff exact path, but cannot prove that another path is
  // outside the diff; the latter remains unresolved and therefore blocking.
  const knownPaths = Array.isArray(repositoryPaths) ? repositoryPaths : changed;
  const outside = [];
  const inScope = [];
  const unresolved = [];

  for (const finding of findings) {
    if (finding.parserUncertain) {
      unresolved.push({ ...finding, reason: 'struttura della review ambigua' });
      continue;
    }
    if (finding.citations.length === 0) {
      unresolved.push({ ...finding, reason: 'nessun file citato' });
      continue;
    }
    const resolved = finding.citations.map((citation) => ({
      citation,
      result: resolveCitedPath(citation, knownPaths),
    }));
    const bad = resolved.find(({ result }) => result.status !== 'resolved');
    if (bad) {
      unresolved.push({
        ...finding,
        reason: bad.result.candidates.length ? 'path ambiguo' : 'file non risolto',
        candidates: bad.result.candidates,
        resolved,
      });
      continue;
    }

    const resolvedFiles = [...new Set(resolved.map(({ result }) => result.path))];
    const classified = { ...finding, resolvedFiles, resolved };
    if (resolvedFiles.some((file) => changedContains(changed, file))) inScope.push(classified);
    else outside.push(classified);
  }

  return {
    findings,
    outside,
    inScope,
    unresolved,
    outsideOnly: outside.length > 0 && inScope.length === 0 && unresolved.length === 0,
    blocking: inScope.length > 0 || unresolved.length > 0,
  };
}

function safeText(value) {
  return String(value || '').replace(/\r?\n/gu, ' ').trim();
}

function distinctiveToken(text) {
  const tokens = [];
  for (const match of String(text || '').matchAll(/`([^`\n]{3,90})`/gu)) {
    const token = match[1].trim();
    if (normalizePath(token)) continue;
    if (!token.includes('/') && /[(){}'" ]|::|=>|\.\w|:\d|>=|<=/u.test(token)) tokens.push(token);
  }
  return tokens.sort((a, b) => b.length - a.length)[0] || null;
}

function followupItemBodies(findings) {
  return findings.map((finding) => {
    const paths = [...new Set((finding.resolvedFiles || []).filter(Boolean))];
    if (paths.length === 0) throw new Error('finding fuori scope senza path risolto');
    const path = paths[0];
    const pathText = paths.map((item) => `\`${item}\``).join(', ');
    const anchor = finding.citations?.[0]?.line
      ? `${path} alla riga ${finding.citations[0].line}`
      : paths.join(', ');
    const token = distinctiveToken(finding.text || finding.line);
    const action = token
      ? `Applicare la correzione indicata dal reviewer in ${anchor} e verificare \`${token}\`.`
      : `Applicare la correzione indicata dal reviewer in ${anchor} e verificare la riga citata.`;
    return [
      `Finding fuori dal diff: ${pathText}`,
      '- Source: reviewer 🔴 Important fuori dal diff',
      '- Stato dichiarato nella PR: nessuno',
      '- Original text:',
      `  > ${safeText(finding.text || finding.line)}`,
      '- Funnel impact: superficie pubblicata / contratto col sito',
      '- Rationale: il finding è stato risolto su un file presente nel tree ma fuori dal diff corrente; il fix resta tracciato senza bloccare questa PR.',
      `- Suggested action: ${action}`,
    ].join('\n');
  });
}

/** Read item sections from the body that the follow-up drainer actually sees. */
export function followupItemsFromBody(body) {
  const lines = String(body || '').split(/\r?\n/u);
  const items = [];
  let inItems = false;
  let fence = false;
  let current = [];
  const flush = () => {
    if (current.length > 0 && current.join('\n').trim()) items.push(current.join('\n').trim());
    current = [];
  };
  for (const line of lines) {
    if (!fence && /^##\s+Item\b/iu.test(line)) {
      inItems = true;
      continue;
    }
    if (!inItems) continue;
    if (!fence && /^##\s+/u.test(line)) break;
    if (/^\s*```/u.test(line)) fence = !fence;
    if (!fence && /^###\s+\d+\.\s*/u.test(line)) {
      flush();
      current.push(line.replace(/^###\s+\d+\.\s*/u, ''));
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  flush();
  return items;
}

function itemKey(item) {
  return String(item).replace(/\s+/gu, ' ').trim().toLowerCase();
}

export function mergeFollowupItems(existingBody, freshItems) {
  const merged = [];
  const seen = new Set();
  for (const item of [...followupItemsFromBody(existingBody), ...freshItems]) {
    const key = itemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function renderFollowupBody({ repo, pr, prUrl, items }) {
  const originUrl = prUrl || `https://github.com/${repo}/pull/${pr}`;
  const header = [
    `<!-- ${FOLLOWUP_MARKER}: ${repo}#${pr} -->`,
    '## Origine',
    '',
    `- PR: #${pr}`,
    `- URL: ${originUrl}`,
    '',
    '## Item',
    '',
  ].join('\n');
  const numbered = items.map((item, index) => `### ${index + 1}. ${item}`).join('\n\n');
  const body = `${header}${numbered}\n`;
  if (body.length > MAX_FOLLOWUP_BODY_LEN) {
    throw new Error('body follow-up oltre il limite sicuro; rifiuto il declassamento');
  }
  return body;
}

/** Build the single aggregate body for all out-of-diff findings of one PR. */
export function followupIssueBody({ repo, pr, prUrl, findings, existingBody = '' }) {
  const freshItems = followupItemBodies(findings);
  return renderFollowupBody({
    repo,
    pr,
    prUrl,
    items: mergeFollowupItems(existingBody, freshItems),
  });
}

function gh(args, { json = true, allowFail = false } = {}) {
  try {
    const output = execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return json ? JSON.parse(output) : output;
  } catch (error) {
    if (allowFail) return json ? null : '';
    throw error;
  }
}

function reviewerList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((page) => Array.isArray(page) ? page : [page]);
}

function findingKey(finding) {
  const anchors = (finding?.citations || [])
    .map((citation) => `${normalizePath(citation.path)}:${citation.line || ''}`)
    .sort()
    .join('|');
  return anchors || String(finding?.text || finding?.line || '')
    .replace(/`/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function fixConfirmations(body) {
  const confirmations = [];
  for (const line of String(body || '').split(/\r?\n/u)) {
    const match = line.match(FIX_CONFIRMATION_RE);
    if (!match) continue;
    const text = match[1].trim();
    confirmations.push({
      citations: extractFileCitations(text),
      key: findingKey({ citations: [], text }),
    });
  }
  return confirmations;
}

// Una conferma aggancia una citazione quando denotano lo stesso file e la riga
// coincide in modo stretto. Il path puo' differire in specificita' — una review
// cita spesso il nome nudo (`foo.js`) e la conferma il path completo
// (`dir/foo.js`) — e quello e' lo stesso suffix-matching che `resolveCitedPath`
// usa gia'. La RIGA invece resta un'uguaglianza esatta, entrambe presenti o
// entrambe assenti: senza quel vincolo una conferma su un file chiuderebbe
// anche un finding DIVERSO sullo stesso file a un'altra riga, che e' proprio la
// scorciatoia che questo gate esiste per impedire.
function citationConfirmed(citation, confirmations) {
  return confirmations.some((confirmation) => confirmation.citations.some((candidate) =>
    candidate.line === citation.line
    && (candidate.path === citation.path
      || suffixMatches(candidate.path, citation.path)
      || suffixMatches(citation.path, candidate.path)),
  ));
}

function findingConfirmed(finding, confirmations) {
  if (finding.citations.length === 0) {
    return confirmations.some((confirmation) => confirmation.key === findingKey(finding));
  }
  return finding.citations.every((citation) => citationConfirmed(citation, confirmations));
}

/**
 * Return Important findings opened by an earlier bot review and not explicitly
 * closed by a later `Fix di ...: ok.` confirmation. GitHub already persists the
 * review bodies; this preserves the path+line anchors without adding storage.
 * `includeLatest` is used by the reviewer bundle, before the new review exists.
 */
export function historicalImportantFindings(reviews, { includeLatest = false } = {}) {
  const bots = reviewerList(reviews).filter((review) =>
    review?.user?.type === 'Bot' && REVIEWER_LOGIN_RE.test(review.user.login || ''),
  );
  if (bots.length < (includeLatest ? 1 : 2)) return [];

  const open = new Map();
  const latestIndex = bots.length - 1;
  for (const [index, review] of bots.entries()) {
    const confirmations = fixConfirmations(review?.body);
    for (const [key, entry] of open.entries()) {
      if (entry.reviewIndex >= index) continue;
      if (findingConfirmed(entry.finding, confirmations)) {
        open.delete(key);
      }
    }
    if (!includeLatest && index === latestIndex) break;

    for (const finding of importantFindings(review?.body)) {
      open.set(findingKey(finding), {
        finding,
        reviewIndex: index,
        reviewCommit: review.commit_id || '',
      });
    }
  }

  return [...open.values()].map(({ finding, reviewCommit }) => ({
    ...finding,
    reviewCommit,
  }));
}

/** Insert inherited findings before the latest review's LGTM marker. */
export function reviewBodyWithHistoricalFindings(body, historicalFindings) {
  const currentKeys = new Set(importantFindings(body).map(findingKey));
  const carry = (historicalFindings || []).filter((finding) => !currentKeys.has(findingKey(finding)));
  if (carry.length === 0) return String(body || '');

  const section = [
    '## Findings ereditati da review precedenti',
    '',
    ...carry.map((finding) => finding.text),
    '',
  ].join('\n');
  const lgtm = String(body || '').search(/^## LGTM\b/imu);
  if (lgtm === -1) return `${String(body || '').trimEnd()}\n\n${section}`;
  return `${String(body || '').slice(0, lgtm)}${section}${String(body || '').slice(lgtm)}`;
}

function latestReviewer(reviews) {
  const bots = reviewerList(reviews).filter((review) =>
    review?.user?.type === 'Bot' && REVIEWER_LOGIN_RE.test(review.user.login || ''),
  );
  return bots.length ? bots[bots.length - 1] : null;
}

function fetchRepositoryPaths(repo, pr) {
  try {
    const base = String(gh([
      'api', `repos/${repo}/pulls/${pr}`, '--jq', '.base.sha',
    ], { json: false })).trim();
    if (!/^[0-9a-f]{40}$/iu.test(base)) {
      console.log('review-gate: tree non recuperabile (base SHA assente o non valida).');
      return null;
    }
    const tree = gh(['api', `repos/${repo}/git/trees/${base}?recursive=1`]);
    if (tree?.truncated || !Array.isArray(tree?.tree) || tree.tree.length === 0) {
      console.log('review-gate: tree non recuperabile (risposta troncata o vuota).');
      return null;
    }
    const paths = tree.tree
      .filter((entry) => entry?.type === 'blob' && entry.path)
      .map((entry) => normalizePath(entry.path, { stripGitPrefix: false }))
      .filter(Boolean);
    return paths.length ? paths : null;
  } catch (error) {
    console.log(`review-gate: tree non recuperabile (${String(error).slice(0, 160)}).`);
    return null;
  }
}

function readReviews(repo, pr) {
  return gh(['api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate', '--slurp']);
}

function fingerprint(sha) {
  try {
    return execFileSync(process.execPath, ['scripts/ci/pr-contribution-fingerprint.mjs', sha], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }).trim() || 'NULL';
  } catch {
    return 'NULL';
  }
}

export function reviewAppliesToHead(reviewCommit, headSha, fingerprintFn = fingerprint) {
  if (!reviewCommit || !headSha) return false;
  if (reviewCommit === headSha) return true;

  const headFingerprint = fingerprintFn(headSha);
  const reviewFingerprint = fingerprintFn(reviewCommit);
  if (headFingerprint !== 'NULL' && headFingerprint === reviewFingerprint) {
    console.log(`review-gate: LGTM carry-forward, contributo invariato (${reviewCommit} → ${headSha}).`);
    return true;
  }
  return false;
}

function writeApproved(value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `approved=${value}\n`);
}

function postBlockedComment(repo, pr, headSha, runUrl, reason) {
  const marker = '<!-- REVIEW_GATE_NO_LGTM -->';
  const existing = gh([
    'api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--jq', '.[].body',
  ], { json: false, allowFail: true }) || '';
  if (String(existing).includes(marker)) return;
  const body = `${marker}
⚠️ **Review gate bloccato** — la review Claude sulla HEAD ${headSha} non contiene un LGTM valido senza un finding Important bloccante. Il merge resta bloccato.

Motivo: ${reason}

Run: ${runUrl}`;
  gh(['pr', 'comment', String(pr), '--repo', repo, '--body', body], { json: false, allowFail: true });
}

async function withRepo(repo, callback) {
  const previous = process.env.GH_REPO;
  process.env.GH_REPO = repo;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = previous;
  }
}

function readFollowupBody(repo, number) {
  return String(gh([
    'issue', 'view', String(number), '--repo', repo, '--json', 'body', '--jq', '.body',
  ], { json: false }));
}

async function mintFollowup({ repo, pr, prUrl, findings }) {
  const body = followupIssueBody({ repo, pr, prUrl, findings });
  const title = `follow-up(#${pr}): finding fuori dal diff`;
  const result = await withRepo(repo, () => createGithubIssue({
    title,
    description: body,
    priority: 2,
    labels: ['follow-up'],
    // A drained follow-up is a completed thread, not a reason to resurrect it.
    reopenWithinHours: 0,
  }));
  if (!result || result.persisted !== true || result.number == null) {
    throw new Error(`follow-up non persistita per PR #${pr}`);
  }

  // The generic writer comments on an existing open issue. The drainer reads
  // the body, so merge fresh findings into that body before approving.
  const current = readFollowupBody(repo, result.number);
  if (!current.includes(FOLLOWUP_MARKER)) {
    throw new Error(`body della follow-up #${result.number} non riconoscibile; rifiuto la sincronizzazione`);
  }
  const merged = followupIssueBody({ repo, pr, prUrl, findings, existingBody: current });
  if (merged.trim() !== current.trim()) {
    gh(['issue', 'edit', String(result.number), '--repo', repo, '--body', merged], { json: false });
  }
  return { number: result.number, url: result.url, bodySynced: true };
}

function logClassification(classification) {
  for (const finding of classification.outside) {
    for (const path of finding.resolvedFiles) {
      console.log(`review-gate: DECLASSIFIED finding=${finding.findingNumber} path=${path} reason=all cited files resolved outside current PR diff`);
    }
  }
  for (const finding of classification.inScope) {
    console.log(`review-gate: BLOCKING finding=${finding.findingNumber} path=${finding.resolvedFiles.join(',')} reason=at least one cited file is in the current PR diff`);
  }
  for (const finding of classification.unresolved) {
    console.log(`review-gate: BLOCKING finding=${finding.findingNumber} reason=${finding.reason}`);
  }
}

/**
 * Fetch and classify one review, optionally minting its single aggregate
 * follow-up. The optional commit pair is used by the red-flag fixer: a stale
 * review is blocking, never an opportunity to mint a debt item.
 */
export async function classifyAndMintReview(body, {
  repo,
  pr,
  prUrl,
  mutate = true,
  reviewCommit,
  headSha,
} = {}) {
  if (!repo || !/^\d+$/u.test(String(pr || ''))) {
    throw new Error('repo o PR number non valido');
  }

  const findings = importantFindings(body);
  if (findings.length === 0) return emptyClassification(findings);

  const hasApplicabilityContext = reviewCommit !== undefined || headSha !== undefined;
  if (hasApplicabilityContext && !reviewAppliesToHead(String(reviewCommit || ''), String(headSha || ''))) {
    const classification = {
      ...emptyClassification(findings),
      unresolved: findings.map((finding) => ({
        ...finding,
        reason: 'review non applicabile alla HEAD corrente',
      })),
      blocking: true,
      error: 'review non applicabile alla HEAD corrente',
    };
    logClassification(classification);
    return classification;
  }

  const changed = fetchPrFiles(Number(pr), gh, repo);
  const repositoryPaths = changed.complete === true && changed.files.length > 0
    ? fetchRepositoryPaths(repo, pr)
    : null;
  const classification = classifyReview(body, {
    files: changed.files,
    complete: changed.complete,
    reason: changed.reason,
    repositoryPaths,
  });
  logClassification(classification);

  let followup = null;
  if (classification.outside.length > 0 && mutate) {
    followup = await mintFollowup({
      repo,
      pr: Number(pr),
      prUrl,
      findings: classification.outside,
    });
    console.log(`review-gate: follow-up aggregata #${followup.number} sincronizzata nel body.`);
  }
  return { ...classification, changed, followup };
}

/** Execute the extracted decision; exported for integration harnesses. */
export async function runReviewGate({
  repo,
  pr,
  headSha,
  runUrl,
  prUrl,
  mutate = true,
  reviews,
  fingerprintFn = fingerprint,
  classifyAndMintReviewFn = classifyAndMintReview,
} = {}) {
  if (!repo || !/^\d+$/u.test(String(pr || '')) || !/^[0-9a-f]{40}$/iu.test(String(headSha || ''))) {
    throw new Error('repo, PR number or HEAD SHA non valido');
  }

  const reviewHistory = reviews ?? readReviews(repo, pr);
  const latest = latestReviewer(reviewHistory);
  if (!latest) return { approved: false, reason: 'nessuna review Claude leggibile' };
  const body = String(latest.body || '');
  const historical = historicalImportantFindings(reviewHistory);
  const effectiveBody = reviewBodyWithHistoricalFindings(body, historical);
  const findings = importantFindings(effectiveBody);
  const reviewCommit = String(latest.commit_id || '');
  let classification = emptyClassification(findings);

  // Applicability comes before scope classification. Otherwise a stale review
  // could mint a follow-up for a finding that belongs to an older head before
  // the gate correctly blocks on the changed contribution.
  const applies = reviewAppliesToHead(reviewCommit, headSha, fingerprintFn);
  if (findings.length > 0 && applies) {
    classification = await classifyAndMintReviewFn(effectiveBody, {
      repo,
      pr,
      prUrl: prUrl || process.env.PR_URL,
      mutate,
    });
  } else if (findings.length > 0 && !applies) {
    classification = {
      ...emptyClassification(findings),
      unresolved: findings.map((finding) => ({
        ...finding,
        reason: 'review non applicabile alla HEAD corrente',
      })),
      blocking: true,
    };
    logClassification(classification);
  }

  if (!body.includes('## LGTM')) {
    return { approved: false, reason: 'manca ## LGTM', classification, review: latest };
  }
  if (classification.blocking) {
    return { approved: false, reason: 'finding Important in-diff o non risolvibile', classification, review: latest };
  }

  if (!reviewCommit) return { approved: false, reason: 'review senza commit_id', classification, review: latest };
  if (reviewCommit === headSha) {
    return { approved: true, reviewCommit, classification, review: latest };
  }

  if (applies) {
    return { approved: true, reviewCommit, classification, review: latest };
  }
  return { approved: false, reason: 'review non sulla HEAD e contributo cambiato', classification, review: latest };
}

async function main() {
  const repo = process.env.REPO || process.env.GITHUB_REPOSITORY || '';
  const pr = process.env.PR_NUMBER || '';
  const headSha = process.env.HEAD_SHA || '';
  const result = await runReviewGate({
    repo,
    pr,
    headSha,
    runUrl: process.env.RUN_URL,
    prUrl: process.env.PR_URL,
  });
  writeApproved(result.approved);
  if (!result.approved) {
    postBlockedComment(repo, pr, headSha, process.env.RUN_URL || '', result.reason || 'verdetto non risolvibile');
    throw new Error(result.reason || 'review gate bloccato');
  }
  console.log(`review-gate: approved=true (review commit ${result.reviewCommit}).`);
}

async function scopeMain() {
  const repo = process.env.REPO || process.env.GITHUB_REPOSITORY || '';
  const pr = process.env.PR_NUMBER || '';
  const result = await classifyAndMintReview(process.env.REVIEW_BODY || '', {
    repo,
    pr,
    prUrl: process.env.PR_URL,
    mutate: process.env.REVIEW_SCOPE_MUTATE !== 'false',
    reviewCommit: process.env.REVIEW_COMMIT,
    headSha: process.env.HEAD_SHA,
  });
  console.log(JSON.stringify({
    blocking: result.blocking === true,
    error: result.error || null,
    outsideOnly: result.outsideOnly === true,
    outside: result.outside.map((finding) => ({
      findingNumber: finding.findingNumber,
      paths: finding.resolvedFiles,
    })),
    inScope: result.inScope.map((finding) => ({
      findingNumber: finding.findingNumber,
      paths: finding.resolvedFiles,
    })),
    unresolved: result.unresolved.map((finding) => ({
      findingNumber: finding.findingNumber,
      reason: finding.reason,
    })),
    followup: result.followup ? { number: result.followup.number } : null,
  }));
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  try {
    if (process.argv.includes('--scope')) await scopeMain();
    else await main();
  } catch (error) {
    if (!process.argv.includes('--scope')) {
      try { writeApproved(false); } catch { /* un write output fallito non puo' rendere verde il gate */ }
    }
    console.error(`review-gate: errore conservativo: ${String(error)}`);
    process.exitCode = 1;
  }
}
