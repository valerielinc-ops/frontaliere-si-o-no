/**
 * «Salta una» contro «abbandona il lotto».
 *
 * Il difetto sorvegliato è una regressione reale, trovata in review su questa stessa PR:
 * `gh()` ritorna `null` quando la chiamata fallisce, e `JSON.parse(null)` coerce
 * l'argomento a `"null"` e ritorna `null` SENZA LANCIARE. Il `try/catch` attorno al parse
 * — che documentava «issue illeggibile → intatta» — non scattava più, l'oggetto nullo
 * entrava nella lista, e il primo accesso a un suo campo lanciava un `TypeError` raccolto
 * dal `catch` per-PR: una sola lettura fallita faceva perdere TUTTE le altre issue della
 * stessa PR, e nel log compariva «gate saltato» al posto delle righe per-issue.
 *
 * Perché questo test gira il processo vero invece di esercitare una funzione: la
 * differenza fra saltarne una e abbandonare il lotto vive nel ciclo di `main()`, ed è
 * **invisibile a un test che passa una issue sola**. Qui il lotto ne ha tre e quella in
 * mezzo è illeggibile. `gh` è un finto sul PATH, `DRY_RUN=1` non scrive niente.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = fileURLToPath(new URL('../scripts/ci/gate-minted-followups.mjs', import.meta.url));
let binDir = '';

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'mint-gate-fake-gh-'));
  // `gh` finto: la lista rende tre issue della stessa PR, e `issue view` della SECONDA
  // fallisce — esattamente la lettura che prima abbatteva l'intero lotto.
  const fake = `#!/bin/sh
case "$1 $2" in
  "issue list")
    echo '[{"number":101,"title":"follow-up(#900): 1 item deferred - a","createdAt":"__NOW__"},{"number":102,"title":"follow-up(#900): 1 item deferred - b","createdAt":"__NOW__"},{"number":103,"title":"follow-up(#900): 1 item deferred - c","createdAt":"__NOW__"}]'
    ;;
  "issue view")
    if [ "$3" = "102" ]; then echo "gh: could not read issue 102" >&2; exit 1; fi
    # Heredoc QUOTATO: senza, la shell (o printf) trasformerebbe i \\n che devono restare
    # escape JSON in newline veri, e il corpo arriverebbe come JSON non valido.
    cat <<'JSON' | sed "s/__N__/$3/"
{"number":__N__,"title":"follow-up(#900): 1 item deferred - x","body":"## Origine\\n- PR: #900\\n\\n### 1. item senza condizione\\n- Source: reviewer\\n- Suggested action: valutare se serve un campo esplicito\\n","createdAt":"__NOW__"}
JSON
    ;;
  *) exit 0 ;;
esac
`.replace(/__NOW__/g, new Date().toISOString());
  writeFileSync(join(binDir, 'gh'), fake);
  chmodSync(join(binDir, 'gh'), 0o755);
});

afterAll(() => { if (binDir) rmSync(binDir, { recursive: true, force: true }); });

describe('gate sul conio — proceed-safe PER ISSUE, non per PR', () => {
  it('una issue illeggibile in mezzo al lotto non porta via le altre', () => {
    const out = execFileSync('node', [GATE], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, BATCH_PRS: '900', DRY_RUN: '1', GH_REPO: 'o/r' },
    });
    // Le due leggibili sono state giudicate...
    expect(out).toContain('#101 (PR #900)');
    expect(out).toContain('#103 (PR #900)');
    // ...quella illeggibile è saltata da sola, con la sua riga...
    expect(out).toContain('#102: non leggibile');
    // ...e il lotto NON è stato abbandonato: è la riga che compariva col difetto.
    expect(out).not.toContain('gate saltato');
  });
});
