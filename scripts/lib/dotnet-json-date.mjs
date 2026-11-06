/**
 * Parser condiviso del wire-format .NET JSON date: "/Date(epoch_ms)/",
 * con epoch anche negativa e suffisso offset opzionale ("/Date(1316156400000-0700)/").
 * L'offset viene ignorato: il valore leading è già epoch-ms UTC assoluta.
 *
 * Unico punto di verità per la classe di bug fixata in PR #4362 (review):
 * la stessa regex viveva in 3 copie divergenti (bing-webmaster, selecta-job-parser,
 * successfactors-client) — le varianti senza offset/negativi fallivano il match
 * in silenzio e i caller ripiegavano su new Date() (data odierna) corrompendo
 * datePosted senza alcun errore.
 *
 * @param {string|null|undefined} value
 * @returns {Date|null} Date valida, o null se il formato non matcha.
 */
export function parseDotNetJsonDate(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/\/Date\((-?\d+)(?:[+-]\d{4})?\)\//);
  if (!match) return null;
  const ms = Number(match[1]);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}
