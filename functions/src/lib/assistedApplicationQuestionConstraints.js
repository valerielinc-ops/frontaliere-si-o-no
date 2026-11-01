const START_DATE_RE = /availab|disponib|verfügbar|verfuegbar|ab wann|\bstart|inizio|entrata in servizio|beginn|eintritt|antritt|arbeitsbeginn|début|entrée en (fonction|service)|prise de poste|à partir de quand|when can you/i;

/** Today in Zurich, YYYY-MM-DD. */
export function zurichToday(nowMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
}

/** The earliest date a date question accepts: today for a start date, else none. */
export function minDateFor(question, nowMs = Date.now()) {
  return question?.type === 'date' && START_DATE_RE.test(`${question.id || ''} ${question.question || ''}`) ? zurichToday(nowMs) : null;
}

/**
 * The proposed start date (owner decision 2026-09-30): the first day of the
 * month three months after next month, e.g. 1 January 2027 in September 2026.
 */
export function defaultStartDate(nowMs = Date.now()) {
  const [year, month] = zurichToday(nowMs).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + 4, 1)).toISOString().slice(0, 10);
}
