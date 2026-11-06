## Il difetto

`scripts/ci/loop-sync-manifest.json` mette i 25 file sotto `engine/` in
`scope.outOfScope`, e motiva cosi':

> «byte-identici a `packages/articles/engine/` del sito — ma hanno gia' un canale
> di discesa AUTOMATICO: `mirror-articles-engine.yml`. Registrarli produrrebbe un
> `site-ahead` per tutta la durata di ogni PR di mirror, cioe' rumore su un canale
> che funziona.»

e chiude dicendo che se quel canale si rompe **«il segnale giusto e' un allarme sul
mirror, non un drift check giornaliero»**.

**Quell'allarme non esiste.** La conseguenza non e' teorica: e' successo il
2026-08-10.

## La misura

La PR #205 (`🔗 Lockstep engine/ with the site`) e' rimasta bloccata ~4 ore in un
deadlock **permanente**, non lenta:

- tocca un solo file, `engine/rssFeeds.mjs`, `+2 / -9`
- `tests (node --test)` e `Generator CI` FAILURE su entrambi i trigger
- `generator/tests/rss-feed-guid.test.mjs:70` → `not ok 602 - guid survives a slug rename`, `not ok 603 - guid and link escape XML special characters (issue #182)`

Causa: la lockstep avrebbe **regredito** il fix corpus-side di #162/#182, perche'
l'engine del sito era rimasto alla forma pre-fix (`guid` dallo slug con
`isPermaLink="true"`, nessun `escapeXml`). Ogni push sull'engine del sito
rigenerava la stessa lockstep con la stessa regressione, e il test corpus la
ributtava indietro: **nessun tick di nessun workflow poteva romperlo.**

Per confronto, le 8 lockstep precedenti (#136, #134, #130, #72, #61, #26, #14, #8)
mergiavano in minuti. Questa e' la prima incagliata, ed e' rimasta invisibile a
ogni gate.

Costo reale: finche' #205 e' bloccata, **nessuna modifica all'engine del sito
scende sul corpus** — ed e' il corpus a renderizzare le pagine articolo. E' la
stessa classe di incidente gia' vista (articoli pubblicati da un engine pre-fix,
visibile solo come `audit:footer-root-presence` 23 → 3608).

Sbloccata a mano portando il fix a monte con `frontaliere-si-o-no#5584`.

## Le due lacune, distinte

**1. Nessun allarme sul mirror.** Una PR `engine-lockstep-auto` aperta e con i
check rossi da > N ore non produce nessun segnale. E' esattamente cio' che il
manifest dichiara di volere e che non e' mai stato costruito. Basterebbe un
guardiano che apra una issue quando la lockstep e' rossa oltre una soglia.

**2. Il punto cieco sull'assenza di un test.** `loop-drift-check` confronta i file
del manifest **uno per uno**: non vede l'assenza di un test da un lato. Qui era
peggio dell'assenza — `tests/rss-feeds-module.test.ts:221` del sito **asseriva la
forma pre-fix**, cioe' un test del sito difendeva la regressione che bloccava il
corpus, con la CI verde da entrambi i lati. E' la stessa forma gia' documentata
per `SiteShellContract` e per `alert-pat-down.mjs`: un contratto che **non ha
forma di import** non e' coperto dai guard che seguono gli import.

## Perche' apro la issue qui

La sede di entrambi i guardiani e' corpus-side (`loop-drift-check` e i workflow di
mirror). Il fix del dato e' gia' andato sul sito (#5584): questa issue copre solo
la **prevenzione**, non la riparazione.

