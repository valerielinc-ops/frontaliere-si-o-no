/**
 * prComments.mjs — dedup "commenta una volta" via marker HTML, condiviso da
 * pr-collision-detector.mjs e pr-autorebase.mjs (residuo #5095, issue #5100).
 *
 * Prima erano due copie indipendenti della STESSA query (fetch di tutti i
 * commenti issue/PR via `gh api .../comments --paginate`, poi
 * `includes(marker)`): drift possibile by-construction, es. se una sola delle
 * due fosse passata a un match case-insensitive o a una paginazione diversa.
 *
 * `gh` è iniettato dal chiamante — entrambi i consumer hanno già un proprio
 * wrapper `execFileSync`-based con lo stesso contratto
 * `gh(args, {json, allowFail}) -> string|object|null` — evita di introdurre
 * una TERZA copia di quel wrapper, fuori scope di questa issue.
 *
 * DRY: il check del marker (`hasCommentMarker`) gira SEMPRE, anche in
 * dry-run — così un run `--dry-run` logga correttamente "già presente" invece
 * di un falso "[dry] comment" per un marker già postato. Solo l'azione di
 * SCRITTURA (`gh pr comment`) è gated su `dry`. Comportamento identico a
 * entrambi gli originali (nessuno dei due gated il fetch/check su DRY).
 */

/** Un commento della issue/PR `num` contiene già `marker`? Predicato puro,
 * nessun logging (i chiamanti loggano l'esito nel proprio contesto). */
export function hasCommentMarker(gh, repo, num, marker) {
  const comments = gh(['api', `repos/${repo}/issues/${num}/comments`, '--paginate',
    '--jq', '[.[] | .body] | join("\\n")'], { json: false, allowFail: true }) || '';
  return comments.includes(marker);
}

/**
 * Commenta `body` (prefissato da `marker` su riga propria) SOLO se `marker`
 * non è già presente in un commento esistente (dedup). In dry-run logga senza
 * postare.
 */
export function commentOnce(gh, repo, num, marker, body, { dry = false } = {}) {
  if (hasCommentMarker(gh, repo, num, marker)) {
    console.log(`PR #${num}: marker ${marker} già presente — no comment.`);
    return;
  }
  if (dry) { console.log(`[dry] comment ${marker} #${num}`); return; }
  gh(['pr', 'comment', String(num), '--repo', repo, '--body', `${marker}\n${body}`], { json: false, allowFail: true });
}

/**
 * Trova l'ID del commento che porta `marker`, o null. Distinto da
 * `hasCommentMarker` (che concatena i body e perde l'id) perché per AGGIORNARE
 * un commento serve il suo id, non solo sapere che esiste.
 */
export function findCommentIdByMarker(gh, repo, num, marker) {
  // Il match lo fa `jq` sul body INTERO, non un parser di righe lato JS: i body
  // dei commenti sono multi-riga, quindi qualunque formato `id<TAB>body` si
  // spezzerebbe sulle continuazioni e potrebbe attribuire il marker al commento
  // sbagliato. Qui esce al più un id per riga, e nient'altro.
  const raw = gh(['api', `repos/${repo}/issues/${num}/comments`, '--paginate',
    '--jq', `.[] | select(.body // "" | contains("${marker}")) | .id`],
  { json: false, allowFail: true }) || '';
  const first = String(raw).split('\n').map((s) => s.trim()).filter((s) => /^\d+$/.test(s))[0];
  return first || null;
}

/**
 * Commento STICKY: aggiorna in place il commento che porta `marker` se esiste,
 * altrimenti ne crea uno.
 *
 * Differenza sostanziale da `commentOnce`, che è "posta una volta e poi tace
 * per sempre": lì un secondo passaggio con contenuto DIVERSO viene perso, e il
 * commento resta a mostrare uno stato stantio. Per un osservatore che rigira a
 * ogni ri-valutazione dell'auto-merge serve l'opposto — un solo commento per
 * PR, sempre aggiornato all'ultima misura — così N ri-valutazioni producono
 * UNA notifica invece di N commenti.
 *
 * `body` deve già contenere `marker` (tipicamente in testa): è il marker a
 * rendere il commento ritrovabile al giro successivo.
 *
 * Best-effort come tutto il modulo (`allowFail`): un fallimento di scrittura
 * non deve mai rompere il chiamante, che sta facendo altro (mergiare).
 */
export function upsertStickyComment(gh, repo, num, marker, body, { dry = false } = {}) {
  const id = findCommentIdByMarker(gh, repo, num, marker);
  if (dry) { console.log(`[dry] ${id ? 'update' : 'create'} sticky ${marker} #${num}`); return; }
  if (id) {
    gh(['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${id}`,
      '-f', `body=${body}`], { json: false, allowFail: true });
    console.log(`PR #${num}: commento sticky ${marker} aggiornato (id ${id}).`);
    return;
  }
  gh(['pr', 'comment', String(num), '--repo', repo, '--body', body], { json: false, allowFail: true });
  console.log(`PR #${num}: commento sticky ${marker} creato.`);
}
