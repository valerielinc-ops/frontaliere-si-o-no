# NPA variabile vs boilerplate — misura su campione ampio

Generato: 2026-09-06T05:45:45.435Z · comando: `node scripts/prospect-measure-postal-variance.mjs`

Criterio misurato: **l'NPA che non compare su tutte le pagine di dettaglio dello
stesso datore è quello dell'annuncio**. Verità di riferimento: la località che il
listing porta già, graduata dal resolver di produzione. Baseline di confronto:
primo NPA della pagina, varianza ignorata. Questa misura non modifica nessun gate.

## Aggregato

- host misurati: 1 (pagine 5, con verità nota 0)
- criterio «NPA variabile»: precision n/d · recall n/d (hit 0, miss 0, nessuna previsione 0)
- baseline «primo NPA»: precision n/d · recall n/d (hit 0, miss 0, nessuna previsione 0)

## Per host

| host | pagine | NPA costanti (boilerplate) | NPA variabili | verità note | precision | recall | baseline precision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `recruitingapp-2649` | 5 | — | — | 0 | n/d | n/d | n/d |
