## Implementato

- Resa best-effort la sola archiviazione storica delle settimane di turno: una release atomica `partial` continua a essere rifiutata dal CLI, ma non può più rendere fallita l’intera sync dopo che il finalizer ha preservato i dati live fail-closed (in questa PR).
- Aggiunto un test del contratto workflow che richiede `continue-on-error: true` sul passo storico e mantenuti verdi i 21 test di storia più i 5 test del workflow (in questa PR).
- La run corrente `39778550295` è riprodotta nel body del fix: `observeDutyWeeks` falliva su `release is partial, publishable=false` nel passo non pubblicabile, dopo la validazione del catalogo (in questa PR).

Closes #10236

## Non implementato (ancora)

- L’archiviazione di una release parziale non viene forzata: in questa PR resta intenzionalmente saltata e la prossima release completa dovrà osservare le settimane mancanti.
