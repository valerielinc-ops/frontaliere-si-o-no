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
