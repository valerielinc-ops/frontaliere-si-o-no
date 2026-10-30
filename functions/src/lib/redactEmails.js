// Un indirizzo dentro un messaggio d'errore (un percorso Firestore che contiene
// l'email del sottoscrittore, il corpo di un errore del provider) finisce nel log
// pubblico di Actions. Questa è l'unica definizione della regola di oscuramento.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function redactEmailAddresses(text) {
  return String(text ?? '').replace(EMAIL_RE, '[indirizzo oscurato]');
}
