/** Application transport provenance; never evidence of employment or agency experience. */
export function individualApplicationOriginQuestion(value) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').replace(/^\s*[*＊]\s*/u, '').trim();
  if (!text || text.length > 1600) return false;
  const question = /^(?:stammt diese bewerbung von einem vermittlungsb[üu]ro|wird diese bewerbung (?:von|durch) eine(?:r)? (?:personalvermittlung|personalvermittlungsagentur) eingereicht|is this application (?:submitted by|from) (?:a|an) (?:recruitment|recruiting|staffing|employment|placement) agency|are you applying through (?:a|an) (?:recruitment |staffing |employment )?agency|questa candidatura (?:proviene da|è presentata da|viene presentata da) un['’]agenzia (?:per il lavoro|di collocamento|interinale)|cette candidature (?:provient-elle d['’]une|est-elle présentée par une) agence (?:de placement|de recrutement|intérimaire))\s*\?/iu;
  const match = question.exec(text);
  if (!match) return false;
  const tail = text.slice(match[0].length).trim();
  if (!tail) return true;
  // One closed conditional legal clause applies ONLY to an agency's Yes.
  // The organisation's name is data in a noun phrase, never another assertion.
  return /^\(Falls ja: Mit Einreichen des Dossiers werden die AGB der [\p{L}\p{N}'’& .-]{1,100} für die Personalvermittlung auf Erfolgsbasis akzeptiert\.\)$/iu.test(tail);
}
