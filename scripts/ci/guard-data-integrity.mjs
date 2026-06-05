/**
 * guard-data-integrity.mjs — catch-all contro il troncamento catastrofico dei
 * file-dati accumulatori committati su main (zero-Claude, deterministico).
 *
 * Perché (incidente 2026-06-04): `discover-404s.yml` (github-actions[bot]) ha
 * committato DIRETTAMENTE su main una versione di `data/seo-404-compat-paths.json`
 * troncata 657594→0 (read fallback `{paths:[]}` → sovrascrive l'accumulatore con
 * vuoto). I 43 workflow che committano dati su main NON passano da PR → nessun
 * vitest/review li gata → la regressione è andata live silenziosamente fino a
 * rompere il 404→301 resolver. Serve un guard UNICO post-push, byte-size based
 * (universale: array E object-map), che copra tutti i writer presenti e futuri.
 *
 * Cosa fa: confronta la size di ogni file-dati cambiato tra il commit PRIMA del
 * push (`beforeSha`) e DOPO (`afterSha`). Se un file GRANDE (> MIN_BYTES) si
 * restringe oltre SHRINK_PCT → è un troncamento catastrofico. Emette la lista
 * delle violazioni come JSON su stdout (il workflow le auto-reverta + apre issue).
 *
 * Uso: node scripts/ci/guard-data-integrity.mjs <beforeSha> <afterSha>
 * Output stdout: JSON array di { file, prevBytes, newBytes, shrinkPct }
 * Exit: 0 sempre (il giudizio è del workflow; qui solo detection pura).
 *
 * Soglie volutamente conservative per non sbagliare su prune legittimi:
 * solo file già grandi (>1MB) e crolli forti (>70%) — un prune reale taglia
 * raramente l'80% di un accumulatore da centinaia di migliaia di righe.
 */
import { execFileSync } from 'node:child_process';

const MIN_BYTES = 1_000_000; // solo accumulatori grandi (>1MB)
const SHRINK_PCT = 70; // crollo > 70% = sospetto troncamento

// Path-glob dei file-dati protetti. I file che cambiano size legittimamente
// (snapshot rigenerati, cache volatili) restano coperti: la soglia size+pct li
// salva dai falsi positivi; un crollo >70% di un file >1MB non è mai "normale".
const DATA_PREFIXES = ['data/', 'public/data/'];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Byte-size di un blob a un dato ref, o null se il path non esiste lì. */
function sizeAt(ref, file) {
  try {
    // `git cat-file -s ref:path` = size del blob senza materializzarlo (veloce).
    const out = execFileSync('git', ['cat-file', '-s', `${ref}:${file}`], {
      encoding: 'utf8',
    }).trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // path assente a quel ref (file nuovo / cancellato)
  }
}

function main() {
  const [beforeSha, afterSha] = process.argv.slice(2);
  if (!beforeSha || !afterSha) {
    console.error('usage: guard-data-integrity.mjs <beforeSha> <afterSha>');
    process.exit(2);
  }
  // Push su branch nuovo / primo commit: before = 000…0 → niente baseline, skip.
  if (/^0+$/.test(beforeSha)) {
    console.log('[]');
    return;
  }

  // Force-push / orphan BEFORE guard: se BEFORE non è antenato di AFTER
  // (force-push o merge-queue con history riscritta), git diff fallirebbe →
  // il catch restituirebbe [] silenziosamente → guard cieco senza segnale.
  // Emettiamo ::warning:: esplicito invece (visibile nei log Actions).
  try {
    git(['merge-base', '--is-ancestor', beforeSha, afterSha]);
  } catch {
    process.stderr.write(
      `::warning::guard-data-integrity: BEFORE ${beforeSha.slice(0, 8)} non è antenato di AFTER — force-push / orphan rilevato, diff saltato, guard cieco su questo push.\n`
    );
    console.log('[]');
    return;
  }

  // File cambiati nel range, ristretti ai prefissi dati.
  let changed = [];
  try {
    changed = git(['diff', '--name-only', beforeSha, afterSha])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((f) => DATA_PREFIXES.some((p) => f.startsWith(p)));
  } catch (e) {
    console.error(`diff fallito: ${String(e).slice(0, 160)}`);
    console.log('[]');
    return;
  }

  const violations = [];
  for (const file of changed) {
    const prevBytes = sizeAt(beforeSha, file);
    const newBytes = sizeAt(afterSha, file);
    if (prevBytes == null || newBytes == null) continue; // creato/cancellato: non è un troncamento
    if (prevBytes < MIN_BYTES) continue; // non era un accumulatore grande
    const shrinkPct = ((prevBytes - newBytes) / prevBytes) * 100;
    if (shrinkPct > SHRINK_PCT) {
      violations.push({
        file,
        prevBytes,
        newBytes,
        shrinkPct: Math.round(shrinkPct * 10) / 10,
      });
    }
  }

  process.stdout.write(JSON.stringify(violations));
}

main();
