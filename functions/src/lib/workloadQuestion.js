const HARD_WORKLOAD_CONSTRAINT = /\b(?:if|when|provided|falls|wenn|sofern|se|si|qualora|presso|pour|chez|hours?|stunden?|heures?|ore|days?|giorni|tage|jours|weekends?|overtime|shifts?|schicht\w*|horaire\w*|night|turni|notturn|fine settimana|attuale|attualmente|current|currently|aktuell\w*|derzeit|actuel\w*|(?:un)?availab\w*|requir\w*|obbligat\w*|richiest\w*|richied\w*|requisit\w*|erforder\w*|verlang\w*|pflicht\w*|obligatoire|requis\w*|exig\w*|necessit\w*|min(?:imum)?|max(?:imum)?|minimo|massimo|almeno|mindestens|maximal|au moins|au plus|must(?: be)?|at least|at most|less than|more than|no less than|not less than|no more than|up to|down to|fino a(?:l{1,2}[aeio]?)?|bis zu|jusqu a|muss(?:en)?|wenigstens|mehr als|weniger als|deve|devono|non meno di|non piu di|al massimo|doit|doivent|moins de|plus de)\b/;

export const WORKLOAD_PREFERENCE_KEY = 'preference_workload_percentage_v1';

/** A percentage preference is portable; employer requirements and shift availability are not. */
export function isPreferredWorkloadQuestion(value) {
  const text = String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (!text || HARD_WORKLOAD_CONSTRAINT.test(text)) return false;
  const workload = /\b(?:workload|pensum|arbeitspensum|beschaftigungsgrad|grado di occupazione|grado d impiego|grado di impiego|carico di lavoro|percentuale di lavoro|percentuale lavorativa|disponibilita lavorativa|taux d activite|taux d occupation)\b/.test(text);
  return workload;
}
