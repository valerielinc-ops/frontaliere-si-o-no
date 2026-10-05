/**
 * robot.mjs — one run of the social robot, with every side effect injected.
 *
 * Per platform: pick the next post from the queue on origin/main (the same
 * queue the API posters fill — scripts/lib/social-publish-queue.mjs), download
 * its slides (Instagram) or verified MP4 (TikTok) from the site's CDN, drive
 * the platform's web flow in the owner's
 * profile, and:
 *   - dry run: stop at the publish button (screenshot), record nothing but a
 *     `dry-run` line in the local journal;
 *   - publish: press, and only with the platform's confirmation on the page
 *     dispatch social-robot-confirm.yml, which moves the entry into the
 *     ledger on main. A press without confirmation is `unconfirmed`: never
 *     pressed again automatically, an issue asks a human to look, and the
 *     platform is held — nothing else is pressed there — until a human
 *     settles it.
 * Any error: screenshot + HTML in the diagnostics folder, one issue with a
 * stable title per platform (github-issue-creator.mjs dedups and comments),
 * no retry in the same run; a login wall or a challenge pauses the platform.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  SOCIAL_CHANNELS,
  isAllowedImageUrl,
  isAllowedVideoUrl,
  isConfirmedInLedger,
  parseLedger,
  parseQueue,
  selectNextPending,
} from '../../lib/social-publish-queue.mjs';
import {
  BETWEEN_PLATFORMS_MS,
  BLOCKING_ERROR_CLASSES,
  HUMAN_DELAY_MS,
  MAX_POSTS_PER_DAY_PER_PLATFORM,
  MAX_POSTS_PER_RUN_PER_PLATFORM,
  TYPING_DELAY_MS,
  blockedQueueIds,
  openUnconfirmed,
  pauseChannel,
  pausedUntil,
  pendingConfirmations,
  pressedToday,
  randomBetween,
  unsettledLedgerKeys,
} from './cadence.mjs';
import { TIKTOK_VIDEO_CONTENT_TYPE } from '../../lib/social-carousel-video.mjs';
import { PRESSED_STEPS, classifyError, RobotError } from './flows.mjs';

export const SITE_REPO = 'valerielinc-ops/frontaliere-si-o-no';
export const CONFIRM_WORKFLOW = 'social-robot-confirm.yml';
export const PLATFORM_LABEL = Object.freeze({ instagram: 'Instagram', tiktok: 'TikTok' });

/** Stable issue title per platform: the creator's 60-char prefix dedup keeps one thread. */
export function issueTitleFor(channel) {
  return `Robot social: pubblicazione ${PLATFORM_LABEL[channel] || channel} non riuscita`;
}

/** A press followed by any error (not only a missing confirmation) leaves the post possibly online. */
const NEXT_STEP_AFTER_PRESS = 'Il bottone di pubblicazione è stato premuto prima dell\'errore: controllare a mano sul profilo se il post è online. Se sì, registrarlo con `gh workflow run social-robot-confirm.yml` (input del journal); se no, aggiungere `resolvedAt` alla riga `unconfirmed` del journal del robot (o cancellarla). Il robot resta fermo su questa piattaforma finché la riga non è risolta.';

const NEXT_STEP = {
  'login-required': 'Il proprietario apre il profilo e fa il login: `node scripts/social-robot/run.mjs --login --platform=<piattaforma>` sul Mac host agenti.',
  challenge: 'Il proprietario apre il profilo (`node scripts/social-robot/run.mjs --login`) e supera la verifica della piattaforma. Il robot resta in pausa sulla piattaforma per 12 ore.',
  'confirmation-missing': 'Controllare a mano sul profilo se il post è online. Se sì, registrarlo con `gh workflow run social-robot-confirm.yml` (input del journal); se no, aggiungere `resolvedAt` alla riga `unconfirmed` del journal del robot (o cancellarla). Il robot non ripubblica questo post da solo e resta fermo su questa piattaforma finché la riga non è risolta.',
  'selector-missing': 'Confrontare screenshot e HTML della diagnosi con i selettori di `scripts/social-robot/lib/flows.mjs`, aggiornarli e coprirli in `scripts/social-robot/robot-e2e.mjs`.',
  'upload-unsupported': 'La pagina non accetta foto: verificare il flusso di caricamento dal web della piattaforma.',
  download: 'Le immagini della coda non sono scaricabili dalla CDN: verificare `images/social/` su R2.',
};

/** `~` instead of the home folder: the issue is public. */
export function displayPath(p, home = homedir()) {
  return home && String(p).startsWith(home) ? `~${String(p).slice(home.length)}` : String(p);
}

export function buildIssueDescription({ channel, error, entry, diagnostics, mode }) {
  return [
    `Il robot Playwright (\`scripts/social-robot/\`) si è fermato su **${PLATFORM_LABEL[channel] || channel}**.`,
    '',
    `- Classe: \`${error.errorClass}\``,
    `- Passo: \`${error.step || 'n/d'}\``,
    `- Messaggio: ${String(error.message).slice(0, 500)}`,
    `- Post della coda: \`${entry?.id || 'n/d'}\``,
    `- Modalità: \`${mode}\``,
    `- Bottone premuto: ${error.pressed ? '**sì** (il post potrebbe essere online)' : 'no'}`,
    `- Diagnosi sul Mac host: \`${diagnostics ? displayPath(diagnostics) : 'n/d'}\` (screenshot + HTML)`,
    '',
    `**Prossimo passo:** ${(error.pressed && error.errorClass !== 'confirmation-missing' ? `${NEXT_STEP_AFTER_PRESS} ` : '') + (NEXT_STEP[error.errorClass] || 'Leggere la diagnosi e il log del robot (`~/Library/Logs/frontaliere/social-robot.log`).')}`,
  ].join('\n');
}

/** Download the slides of `entry` into `dir`; only from the site's CDN, only images. */
export async function downloadImages(entry, dir, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [i, url] of entry.imageUrls.entries()) {
    if (!isAllowedImageUrl(url)) throw new RobotError('download', `image outside the site's CDN: ${url}`);
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new RobotError('download', `GET ${url} failed: ${err.message}`);
    }
    const type = String(res.headers?.get?.('content-type') || '');
    if (!res.ok || !type.startsWith('image/')) throw new RobotError('download', `GET ${url} → ${res.status} ${type}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new RobotError('download', `GET ${url} → empty body`);
    const file = path.join(dir, `slide-${i + 1}.jpg`);
    writeFileSync(file, buf);
    files.push(file);
  }
  return files;
}

function downloadTimeoutForVideo(video, baseMs = 30_000) {
  const bytes = Number(video?.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return baseMs;
  return Math.min(120_000, Math.max(baseMs, 10_000 + Math.ceil(bytes / (512 * 1024)) * 1_000));
}

/** Download and verify the MP4 signed by the poster before Playwright sees it. */
export async function downloadVideo(entry, dir, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const video = entry?.video;
  if (!video || !isAllowedVideoUrl(video.url)) {
    throw new RobotError('download', `video outside the site's CDN: ${video?.url || 'missing'}`);
  }
  mkdirSync(dir, { recursive: true });
  let res;
  try {
    res = await fetchImpl(video.url, { signal: AbortSignal.timeout(downloadTimeoutForVideo(video, timeoutMs)) });
  } catch (err) {
    throw new RobotError('download', `GET ${video.url} failed: ${err.message}`);
  }
  const type = String(res.headers?.get?.('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!res.ok || type !== TIKTOK_VIDEO_CONTENT_TYPE) throw new RobotError('download', `GET ${video.url} → ${res.status} ${type}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length !== video.bytes) {
    throw new RobotError('download', `GET ${video.url} → byte count ${buf.length}, expected ${video.bytes}`);
  }
  const sha256 = createHash('sha256').update(buf).digest('hex');
  if (sha256 !== video.sha256) throw new RobotError('download', `GET ${video.url} → sha256 mismatch`);
  const file = path.join(dir, 'video.mp4');
  writeFileSync(file, buf);
  return file;
}

/** TikTok consumes the verified MP4; Instagram keeps its existing slide list. */
export async function downloadEntryFiles(entry, dir, opts = {}) {
  if (entry?.video) return [await downloadVideo(entry, dir, opts)];
  return downloadImages(entry, dir, opts);
}

/**
 * Reads the queue and the ledger from origin/main of the site checkout
 * (after one fetch per run). A failed fetch leaves the last fetched view:
 * the journal still prevents a second press.
 */
export function gitMainReader({ repoDir, exec = execFileSync, log = console }) {
  let fetched = false;
  const git = (args) => exec('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  const show = (rel) => {
    if (!fetched) {
      fetched = true;
      try {
        git(['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60', 'fetch', '-q', 'origin', 'main']);
      } catch (err) {
        log.warn(`⚠️  git fetch origin main failed (${String(err.message).split('\n')[0]}): using the last fetched origin/main`);
      }
    }
    try {
      return git(['show', `origin/main:${rel}`]);
    } catch {
      return null;
    }
  };
  return {
    readQueue: (channel) => parseQueue(show(`data/${channel}-queue.json`) ?? ''),
    readLedger: (channel) => parseLedger(show(`data/${channel}-posted.json`) ?? ''),
  };
}

/** `gh workflow run social-robot-confirm.yml` through the coordinator shim. */
export function ghConfirmDispatcher({ ghBin = 'gh', exec = execFileSync, repo = SITE_REPO } = {}) {
  return async ({ channel, queueId, confirmedAt, evidence, ledgerEntries }) => {
    try {
      exec(ghBin, [
        'workflow', 'run', CONFIRM_WORKFLOW,
        '--repo', repo,
        '--ref', 'main',
        '-f', `channel=${channel}`,
        '-f', `queue_id=${queueId}`,
        '-f', `confirmed_at=${confirmedAt}`,
        '-f', `evidence=${String(evidence || '').slice(0, 200)}`,
        '-f', `ledger_entries=${JSON.stringify(ledgerEntries || [])}`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err.stderr || err.message).split('\n').filter(Boolean).slice(-1)[0] || 'gh failed' };
    }
  };
}

/**
 * @param {object} deps
 * @param {'dry-run'|'publish'} deps.cliMode   what the command line asked
 * @param {'off'|'dry'|'live'} deps.rcMode     SOCIAL_ROBOT_MODE from Remote Config
 * @param {string[]} [deps.platforms]
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.rng]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {{ readQueue: Function, readLedger: Function }} deps.reader
 * @param {{ load: Function, save: Function }} deps.journalStore
 * @param {(entry: object) => Promise<string[]>} deps.fetchImages
 * @param {(channel: string, entry: object, files: string[], opts: { dryRun: boolean, human: object, diagnosticsDir: string, video?: object }) => Promise<{status: string, evidence?: string}>} deps.publishWith
 * @param {(args: object) => Promise<{ok: boolean, reason?: string}>} deps.dispatchConfirm
 * @param {(args: { title: string, description: string, labels: string[] }) => Promise<unknown>} deps.reportIssue
 * @param {(channel: string, entry: object|null, at: number) => string} deps.diagnosticsFor
 * @param {boolean} [deps.repeatDryRun]  false for an unattended run: one dry run per queue entry
 * @param {Pick<Console, 'log'|'warn'|'error'>} [deps.log]
 */
export async function runRobot(deps) {
  const {
    cliMode,
    rcMode,
    platforms = [...SOCIAL_CHANNELS],
    now = () => Date.now(),
    rng = Math.random,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    reader,
    journalStore,
    fetchImages,
    publishWith,
    dispatchConfirm,
    reportIssue,
    diagnosticsFor,
    repeatDryRun = true,
    log = console,
  } = deps;

  const results = [];
  if (rcMode === 'off') {
    log.log('ℹ️  SOCIAL_ROBOT_MODE=off: the API pipeline publishes, the robot does nothing');
    return { dryRun: true, results };
  }
  const dryRun = !(cliMode === 'publish' && rcMode === 'live');
  if (cliMode === 'publish' && dryRun) {
    log.log(`ℹ️  --publish asked, but SOCIAL_ROBOT_MODE=${rcMode}: dry run (Remote Config must say "live")`);
  }
  const human = {
    pause: () => sleep(randomBetween(rng, HUMAN_DELAY_MS)),
    typeDelay: () => randomBetween(rng, TYPING_DELAY_MS),
  };

  const journal = journalStore.load();
  const ledgers = new Map();
  const ledgerOf = (channel) => {
    if (!ledgers.has(channel)) ledgers.set(channel, reader.readLedger(channel));
    return ledgers.get(channel);
  };
  const confirmedOn = (channel) => (queueId) => isConfirmedInLedger(ledgerOf(channel), queueId);

  // A post already pressed and confirmed whose confirmation has not reached
  // the ledger (dispatch failed, or dispatched but dropped/failed on the
  // GitHub side): dispatch again first, so the ledger catches up before
  // anything new. confirmQueueEntry is idempotent.
  for (const attempt of pendingConfirmations(journal, { now: now(), isConfirmed: (channel, queueId) => confirmedOn(channel)(queueId) })) {
    const res = await dispatchConfirm({
      channel: attempt.channel,
      queueId: attempt.queueId,
      confirmedAt: attempt.at,
      evidence: attempt.evidence,
      ledgerEntries: attempt.ledgerEntries,
    });
    attempt.confirmDispatched = res.ok;
    if (res.ok) attempt.confirmDispatchedAt = new Date(now()).toISOString();
    log.log(`${res.ok ? '✅' : '⚠️ '} confirm re-dispatch ${attempt.channel}/${attempt.queueId}${res.ok ? '' : `: ${res.reason}`}`);
  }
  journalStore.save(journal);

  let acted = false;
  for (const channel of platforms) {
    const at = now();
    const paused = pausedUntil(journal, channel, at);
    if (paused) {
      log.log(`⏸️  ${channel}: paused until ${paused} (login wall or challenge) — not insisting`);
      results.push({ channel, outcome: 'paused' });
      continue;
    }
    const held = openUnconfirmed(journal, channel, confirmedOn(channel));
    if (held.length) {
      log.log(`✋ ${channel}: held — ${held.map((a) => a.queueId).join(', ')} was pressed without a confirmation and no human has settled it yet`);
      results.push({ channel, outcome: 'held', queueId: held[0].queueId });
      continue;
    }
    if (!dryRun && pressedToday(journal, channel, at) >= MAX_POSTS_PER_DAY_PER_PLATFORM) {
      log.log(`🛑 ${channel}: daily cap of ${MAX_POSTS_PER_DAY_PER_PLATFORM} reached`);
      results.push({ channel, outcome: 'cap' });
      continue;
    }

    const skippedIds = new Set();
    let postsThisRun = 0;
    while (postsThisRun < MAX_POSTS_PER_RUN_PER_PLATFORM) {
      const entry = selectNextPending(reader.readQueue(channel), {
        channel,
        now: at,
        ledger: ledgerOf(channel),
        blockedIds: new Set([
          ...blockedQueueIds(journal, channel, { skipDryRun: dryRun && !repeatDryRun }),
          ...skippedIds,
        ]),
        blockedLedgerKeys: unsettledLedgerKeys(journal, channel, confirmedOn(channel)),
      });
      if (!entry) {
        log.log(`ℹ️  ${channel}: nothing ready in data/${channel}-queue.json on origin/main`);
        results.push({ channel, outcome: 'empty' });
        break;
      }
      if (channel === 'tiktok' && !entry.video) {
        skippedIds.add(entry.id);
        log.log(`⏭️  tiktok: ${entry.id} skipped (no-video legacy queue entry)`);
        results.push({ channel, outcome: 'skipped', reason: 'no-video', queueId: entry.id });
        continue;
      }
      if (acted) await sleep(randomBetween(rng, BETWEEN_PLATFORMS_MS));
      acted = true;

      const diagnostics = diagnosticsFor(channel, entry, at);
      log.log(`▶️  ${channel}: ${entry.id} (${entry.imageUrls.length} slides) — ${dryRun ? 'dry run' : 'publish'}`);
      try {
        const files = await fetchImages(entry);
        const res = await publishWith(channel, entry, files, { dryRun, human, diagnosticsDir: diagnostics, video: entry.video });
        if (res.status === 'published') {
          postsThisRun += 1;
          const attempt = {
            channel,
            queueId: entry.id,
            at: new Date(now()).toISOString(),
            outcome: 'published',
            evidence: res.evidence || '',
            ledgerEntries: entry.ledgerEntries,
            confirmDispatched: false,
          };
          journal.attempts.push(attempt);
          journalStore.save(journal);
          const dispatched = await dispatchConfirm({
            channel,
            queueId: entry.id,
            confirmedAt: attempt.at,
            evidence: attempt.evidence,
            ledgerEntries: entry.ledgerEntries,
          });
          attempt.confirmDispatched = dispatched.ok;
          if (dispatched.ok) attempt.confirmDispatchedAt = new Date(now()).toISOString();
          journalStore.save(journal);
          log.log(`✅ ${channel}: published ${entry.id} (${attempt.evidence})${dispatched.ok ? '' : ` — confirm dispatch failed, retried next run: ${dispatched.reason}`}`);
          results.push({ channel, outcome: 'published', queueId: entry.id, confirmDispatched: dispatched.ok });
        } else if (res.status === 'dry-run') {
          postsThisRun += 1;
          journal.attempts.push({ channel, queueId: entry.id, at: new Date(now()).toISOString(), outcome: 'dry-run' });
          journalStore.save(journal);
          log.log(`🧪 ${channel}: ${entry.id} ready at the publish button (not pressed) — screenshot in ${displayPath(diagnostics)}`);
          results.push({ channel, outcome: 'dry-run', queueId: entry.id });
        } else {
          throw new RobotError('unexpected', `flow returned status "${res.status}"`);
        }
      } catch (raw) {
        const error = classifyError(raw);
        // Second layer behind the flows' own marking: an error raised at or
        // after the press step is a press, whatever the error says.
        if (PRESSED_STEPS.includes(error.step)) error.pressed = true;
        const outcome = error.pressed ? 'unconfirmed' : 'error';
        journal.attempts.push({
          channel,
          queueId: entry.id,
          at: new Date(now()).toISOString(),
          outcome,
          errorClass: error.errorClass,
          step: error.step,
          message: String(error.message).slice(0, 300),
          ...(error.pressed ? { ledgerEntries: entry.ledgerEntries } : {}),
        });
        if (BLOCKING_ERROR_CLASSES.includes(error.errorClass)) pauseChannel(journal, channel, now());
        journalStore.save(journal);
        log.error(`❌ ${channel}: ${error.errorClass} at ${error.step || 'n/a'} — ${error.message}`);
        const needsHuman = BLOCKING_ERROR_CLASSES.includes(error.errorClass) || error.pressed;
        try {
          await reportIssue({
            title: issueTitleFor(channel),
            description: buildIssueDescription({ channel, error, entry, diagnostics, mode: dryRun ? 'dry-run' : 'publish' }),
            labels: needsHuman ? ['Bug', 'needs-human'] : ['Bug'],
          });
        } catch (issueErr) {
          log.error(`⚠️  could not open the issue: ${issueErr.message}`);
        }
        results.push({ channel, outcome, errorClass: error.errorClass, queueId: entry.id });
        break;
      }
    }
  }
  return { dryRun, results };
}
