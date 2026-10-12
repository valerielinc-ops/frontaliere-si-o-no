# Esperimento creativo video TikTok

## Ipotesi

Un contenuto verticale con movimento visivo, ritmo e una gerarchia più simile
a un breve video editoriale trattiene più attenzione delle stesse informazioni
mostrate come slide statiche in dissolvenza.

## Bracci

| Braccio | Variante | Cosa cambia | Cosa resta uguale |
|---|---|---|---|
| Controllo | `carousel-crossfade-v1` | Video verticale dalle slide esistenti, dissolvenza | ranking, caption, durata nominale, account, cadenza |
| Trattamento | `motion-graphic-v1` | Card flottante, movimento di sfondo, barra di avanzamento e transizioni wipe | ranking, caption, asset informativi, account, cadenza |

Il trattamento non introduce musica scaricata: l'audio nativo TikTok è un
esperimento separato. Entrambi gli id sono registrati nel ledger, così il
risultato può essere segmentato anche per `native-sound=control/treatment`.

## Assegnazione e sicurezza

- Firebase Remote Config controlla modalità e percentuale.
- L'assegnazione è deterministica sull'id della coda e non cambia ai retry.
- Il default locale è sempre il controllo.
- Se ffmpeg o ffprobe non producono un MP4 verticale verificabile, il post
  viene saltato: non viene pubblicata una variante diversa senza tracciarla.
- Il robot continua a usare il profilo Chrome già autenticato e la cadenza
  esistente; non servono passaggi manuali.

## Misurazione

Per ogni pubblicazione confrontare, separando anche il tipo `article`/`job`/`border`:

1. visualizzazioni;
2. tempo medio di visione e percentuale di completamento, quando esposti da
   TikTok Studio;
3. like, commenti e condivisioni;
4. sessioni e pagine viste attribuite ai link UTM TikTok in GA4.

Il ledger contiene `creativeVariant`, `creativeLabel` e `creativeFormat`; il
journal del Mac conserva anche la variante effettivamente portata al bottone o
pubblicata. Non si dichiara un vincitore con un solo post: la prima lettura è
descrittiva, e una decisione richiede almeno tre osservazioni comparabili per
braccio e una finestra di almeno sette giorni.

## Distribuzione

Il video è l'asset principale; da ogni video si possono ricavare in seguito
un fermo immagine, una caption breve e una ripubblicazione coerente. TikTok
resta il canale di scoperta: il link in bio e gli UTM riportano il traffico
verso il sito, che conserva l'audience.
