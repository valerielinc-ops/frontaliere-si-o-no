# NPA variabile vs boilerplate — misura su campione ampio

Generato: 2026-09-08T10:33:14.510Z · comando: `node scripts/prospect-measure-postal-variance.mjs`

Criterio misurato: **l'NPA che non compare su tutte le pagine di dettaglio dello
stesso datore è quello dell'annuncio**. Verità di riferimento: la località source-backed
estratta dal dettaglio, senza usare il listing. Baseline di confronto:
primo NPA della pagina, varianza ignorata. Questa misura non modifica nessun gate.

## Aggregato

- host misurati: 30 (pagine 179, con verità nota 56)
- criterio «NPA variabile»: precision 58.3% · recall 12.5% (hit 7, miss 5, nessuna previsione 44)
- baseline «primo NPA»: precision 35.1% · recall 23.2% (hit 13, miss 24, nessuna previsione 19)
- pagine su cui il criterio ha una risposta univoca: 29/179 (nessun NPA variabile 150, ambiguo 0)

## Lettura

- Il criterio produce una risposta univoca su 29 pagine su 179 (16.2%): sulle altre 150 il testo non porta nessun NPA riconosciuto e 0 restano ambigue con più NPA variabili.
- Sulle 56 pagine con verità nota il criterio ha ragione 7 volte e torto 5, contro 13/24 della baseline.
- Un NPA di boilerplate — presente su tutte le pagine campionate — esiste su 12 host su 30: dove c'è, il criterio lo esclude correttamente (colonna «NPA costanti»), e questo è il pezzo di ipotesi che la misura conferma.

## Per host

| host | pagine | NPA costanti (boilerplate) | NPA variabili | risposta univoca | verità note | precision | recall | baseline precision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `physioswiss` | 6 | — | `2000 neuchatel`<br>`2552 orpund`<br>`4528 zuchwil`<br>`8004 zurich`<br>`8618 oetwil am see`<br>`9472 grabs` | 6/6 | 6 | 100.0% | 100.0% | 100.0% |
| `recruitingapp-2862` | 6 | — | `5703 seon`<br>`8058 zurich flughafen` | 2/6 | 0 | n/d | n/d | n/d |
| `recruitingapp-2649` | 5 | — | — | 0/5 | 0 | n/d | n/d | n/d |
| `fachkraft` | 6 | `6003 luzern` | `6210 sursee`<br>`8400 winterthur` | 5/6 | 6 | 0.0% | 0.0% | 16.7% |
| `recruitingapp-2783` | 6 | — | — | 0/6 | 0 | n/d | n/d | n/d |
| `sta` | 6 | `2026 sta`<br>`4665 oftringen`<br>`6003 luzern`<br>`8050 zurich` | — | 0/6 | 6 | n/d | 0.0% | 66.7% |
| `griesser` | 6 | — | — | 0/6 | 0 | n/d | n/d | n/d |
| `stellentreff` | 6 | `2026 stellentreff`<br>`6210 sursee`<br>`8400 winterthur`<br>`9000 st gallen` | — | 0/6 | 6 | n/d | 0.0% | 0.0% |
| `recruitingapp-2677` | 6 | — | `9490 vaduz` | 0/6 | 0 | n/d | n/d | n/d |
| `stellenpartner` | 6 | `2026 stellenpartner`<br>`5400 baden`<br>`6300 zug`<br>`8500 frauenfeld` | — | 0/6 | 6 | n/d | 0.0% | 16.7% |
| `sonnenhalde` | 6 | — | — | 0/6 | 0 | n/d | n/d | n/d |
| `anker-swiss` | 6 | `2026 anker`<br>`8004 zurich` | — | 0/6 | 6 | n/d | 0.0% | 0.0% |
| `jsafrasarasin` | 6 | — | — | 0/6 | 4 | n/d | 0.0% | n/d |
| `silvaplana` | 6 | `2026 engadiner` | `7503 samedan`<br>`7505 pontresina` | 2/6 | 0 | n/d | n/d | n/d |
| `recruitingapp-2794` | 6 | — | — | 0/6 | 0 | n/d | n/d | n/d |
| `ete` | 6 | `9016 st gallen` | `4624 harkingen`<br>`8303 bassersdorf` | 2/6 | 0 | n/d | n/d | n/d |
| `recruitingapp-2748` | 6 | `4101 bruderholz`<br>`4242 laufen`<br>`4410 liestal` | — | 0/6 | 0 | n/d | n/d | n/d |
| `michaelpage` | 6 | — | — | 0/6 | 5 | n/d | 0.0% | n/d |
| `apleona-schweiz-ag` | 6 | — | — | 0/6 | 1 | n/d | 0.0% | n/d |
| `okjob` | 6 | — | `1347 le`<br>`1400 yverdon`<br>`4051 bale`<br>`8001 zurich` | 1/6 | 4 | 100.0% | 25.0% | 100.0% |
| `recruitingapp-1123` | 6 | `1020 wien`<br>`2025 bundesimmobiliengesellschaft` | — | 0/6 | 0 | n/d | n/d | n/d |
| `recruitingapp-2678` | 6 | — | — | 0/6 | 0 | n/d | n/d | n/d |
| `recruitingapp-2717` | 6 | — | `7007 chur`<br>`8050 zurich`<br>`8280 kreuzlingen`<br>`8400 winterthur`<br>`8640 rapperswil`<br>`9001 st gallen` | 6/6 | 0 | n/d | n/d | n/d |
| `schauenstein` | 6 | — | `7414 furstenau`<br>`8704 herrliberg` | 5/6 | 0 | n/d | n/d | n/d |
| `recruitingapp-2788` | 6 | — | `4190 bad`<br>`5201 seekirchen`<br>`6300 worgl`<br>`6380 st` | 0/6 | 0 | n/d | n/d | n/d |
| `115west` | 6 | `2503 biel` | — | 0/6 | 0 | n/d | n/d | n/d |
| `recruitingapp-2806` | 6 | — | — | 0/6 | 0 | n/d | n/d | n/d |
| `accor` | 6 | `2026 accor` | — | 0/6 | 6 | n/d | 0.0% | n/d |
| `recruitingapp-2814` | 6 | — | — | 0/6 | 0 | n/d | n/d | n/d |
| `belvair` | 6 | `2025 rhatische`<br>`7001 chur` | — | 0/6 | 0 | n/d | n/d | n/d |

## Host non misurati

- `im-bethesda-spital` — solo 1 pagine di dettaglio raggiunte, varianza non osservabile
- `jobs` — solo 1 pagine di dettaglio raggiunte, varianza non osservabile
- `ipersonal` — solo 0 pagine di dettaglio raggiunte, varianza non osservabile
- `med-ipersonal` — solo 0 pagine di dettaglio raggiunte, varianza non osservabile
