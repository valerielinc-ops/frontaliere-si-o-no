## Implementato

- Riconosciuto il layout live SuccessFactors della vacancy `Lugano, CH` quando il portale omette `facility` e `tenant`, ma conserva insieme URL job nativo, organizzazione condivisa, contesto `Inspired Education Group school` e `IB World School`; i dettagli svizzeri privi di questa prova restano fail-closed (in questa PR).
- Aggiunti due test di regressione per il nuovo segnale positivo e per il caso incompleto senza contesto IB; eseguiti 43 test mirati verdi e verificato dal vivo il job `1375440257`, ora classificato `native-detail-fields` e `isIst=true` (in questa PR).

Closes #11088

## Non implementato (ancora)

- La run completa del gruppo crawler e la chiusura automatica del monitor restano da osservare dopo il merge; in questa PR la prova live copre il dettaglio che causava `selector_miss`, non l'intero ciclo CI schedulato.
