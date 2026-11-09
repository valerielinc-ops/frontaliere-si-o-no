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
 * The proposed start date (owner decision 2026-11-09, superseding 2026-09-30):
 * three months after the submission, the same day of the month (the last day
 * when that month is shorter), e.g. 9 February 2027 on 9 November 2026.
 */
export function defaultStartDate(nowMs = Date.now()) {
  const [year, month, day] = zurichToday(nowMs).split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + 3, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}
