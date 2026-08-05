/**
 * Single shared source of truth for glossario-frontaliere term definitions
 * (issue #4409). Keyed by the Italian term slug (the URL segment under
 * `/glossario-frontaliere/<slug>/`), each entry is a real, 1-2 sentence,
 * number-forward Italian definition — the same style already used for the
 * hand-curated entries (irpef, franchigia, ristorni, permesso-g, lamal, …).
 *
 * Consumed by THREE call sites that must never drift apart (AGENTS.md rule
 * 6 — same fact duplicated ≥2 places → extract to one shared module):
 *   - `services/seo/seo-pages.ts` — hand-curated `DefinedTerm.description`
 *     for the 12 terms that also ship a dedicated FAQ block.
 *   - `build-plugins/staticPagesPlugin.ts` — SSG auto-generated fallback for
 *     every OTHER glossary term (no hand-curated seo-pages.ts entry).
 *   - `services/seoService.ts` — the runtime/SPA-navigation mirror of the
 *     same auto-generated fallback.
 *
 * Before this module existed, the auto-generated fallback for every term
 * NOT in seo-pages.ts literally emitted the generic template text
 * "Definizione e spiegazione di <term> per frontalieri (Svizzera–Italia):
 * significato, contesto e impatto pratico." as the page's DefinedTerm
 * JSON-LD description (and, since the same string also fed the meta
 * description and the on-page lede paragraph immediately under the H1, as
 * the FIRST piece of visible text a user or crawler saw on the page) —
 * never a real definition. One hand-curated entry (imposta-alla-fonte) had
 * independently hand-typed the same placeholder pattern into its
 * `DefinedTerm.description`. Backfilling every term here, and having every
 * consumer read from this ONE map, makes that regression impossible by
 * construction (see also scripts/check-glossario-definitions.mjs, the
 * weekly post-deploy guard for this exact regex).
 */

/** Literal placeholder pattern this module exists to eliminate. Exported so
 * the periodic checker (scripts/check-glossario-definitions.mjs) and this
 * module's own consumers can share one detection regex. */
import { peelDanglingClauseTail } from '../../build-plugins/shared/clauseTail.mjs';

export const GLOSSARY_PLACEHOLDER_DESCRIPTION_RX = /^Definizione e spiegazione di .+ per frontalieri/i;

export const GLOSSARY_TERM_DEFINITIONS: Readonly<Record<string, string>> = {
  // ── Fiscalità CH-IT ────────────────────────────────────────────────
  'imposta-alla-fonte':
    'Imposta alla fonte (Quellensteuer): trattenuta fiscale mensile applicata dal datore di lavoro svizzero direttamente sullo stipendio lordo dei frontalieri, con aliquote 2026 progressive da circa 0% a oltre il 24% secondo la tabella A, B, C o H.',
  irpef:
    'IRPEF: imposta sul reddito delle persone fisiche in Italia. Per i frontalieri 2026, scaglioni dal 23% al 43% con franchigia di €10.000.',
  franchigia:
    'Franchigia fiscale €10.000 per nuovi frontalieri dal 2024: reddito svizzero esente IRPEF fino a questa soglia. Nuovo accordo CH-IT.',
  ristorni:
    'Ristorni fiscali: quota delle imposte alla fonte svizzere retrocessa ai comuni italiani di confine dei lavoratori frontalieri.',
  doppiaimposizione:
    'Doppia imposizione: rischio che lo stesso reddito venga tassato sia in Svizzera (imposta alla fonte) sia in Italia (IRPEF). La Convenzione CH-IT del 1976, integrata dal Nuovo Accordo 2023, lo evita con credito d\'imposta e franchigia di €10.000.',
  'addizionale-regionale':
    'Addizionale regionale: imposta italiana aggiuntiva sull\'IRPEF calcolata dalla Regione di residenza. Per i frontalieri varia dall\'1,23% al 3,33% del reddito imponibile secondo la regione (es. Lombardia fino all\'1,73%).',
  'addizionale-comunale':
    'Addizionale comunale: imposta locale aggiuntiva sull\'IRPEF fissata dal Comune di residenza. Nei comuni di confine varia in genere dallo 0% allo 0,9% del reddito imponibile.',
  deduzioni:
    'Deduzioni: importi che riducono il reddito imponibile IRPEF di un frontaliere, ad esempio i contributi previdenziali svizzeri (AVS, LPP) e la franchigia di €10.000 per i nuovi frontalieri, abbassando l\'imposta dovuta in Italia.',
  'nuovo-accordo-2024':
    'Nuovo Accordo 2024: regime fiscale in vigore per i frontalieri assunti in Svizzera dal 17 luglio 2023, con tassazione concorrente (imposta alla fonte + IRPEF con credito d\'imposta) e franchigia annua di €10.000.',
  'accordo-frontalieri':
    'Accordo frontalieri: intesa bilaterale tra Svizzera e Italia che regola la tassazione dei lavoratori transfrontalieri. Il testo del 23 dicembre 2020, ratificato con Legge 83/2023, ha introdotto dal 2024 il regime dei nuovi frontalieri con franchigia €10.000.',

  // ── Documenti fiscali e dichiarazione redditi ─────────────────────
  lohnausweis:
    'Lohnausweis: certificato di salario annuale rilasciato dal datore di lavoro svizzero, equivalente alla Certificazione Unica (CU) italiana. Riporta lordo, trattenute sociali (AVS, LPP, AC) e imposta alla fonte, necessario per la dichiarazione dei redditi in Italia.',
  cu:
    'CU (Certificazione Unica): documento fiscale italiano che attesta i redditi percepiti e le ritenute versate durante l\'anno, equivalente al Lohnausweis svizzero per i frontalieri con redditi anche in Italia.',
  ral:
    'RAL (Retribuzione Annua Lorda): stipendio lordo annuo di un lavoratore, comprensivo di tredicesima (e quattordicesima se prevista dal CCNL) in Italia; in Svizzera indica il lordo annuo su 12 o 13 mensilità a seconda del contratto.',
  'modello-730':
    'Modello 730: dichiarazione dei redditi semplificata italiana precompilata dall\'Agenzia delle Entrate, usata anche dai frontalieri per dichiarare il reddito svizzero, la franchigia €10.000 e il credito d\'imposta per le tasse già pagate in Svizzera.',
  'redditi-pf':
    'Modello Redditi PF: dichiarazione dei redditi ordinaria italiana (ex Unico), alternativa al 730, spesso obbligatoria per i frontalieri con redditi esteri complessi; il quadro RC accoglie il reddito svizzero e il quadro CE il credito d\'imposta.',

  // ── Sanità ─────────────────────────────────────────────────────────
  lamal:
    'LAMal: assicurazione malattia obbligatoria svizzera. Copre le cure a carico del salario coordinato.',
  cmu:
    'CMU (Copertura Malattia Universale): contribuzione sanitaria italiana dovuta da chi sceglie il SSN invece della LAMal svizzera, calcolata su base reddituale dall\'Agenzia delle Entrate.',
  ssn:
    'SSN (Servizio Sanitario Nazionale): sistema sanitario pubblico italiano, alternativa alla LAMal svizzera per i frontalieri, che possono scegliere l\'iscrizione entro 3 mesi dall\'inizio del rapporto di lavoro in Svizzera.',
  'franchigia-assicurativa':
    'Franchigia assicurativa: importo annuo che l\'assicurato LAMal paga di tasca propria prima che l\'assicurazione malattia svizzera copra le spese. Le fasce vanno da CHF 300 a CHF 2.500: più alta la franchigia, più basso il premio mensile.',
  'modelli-assicurativi':
    'Modelli assicurativi: varianti del piano LAMal che riducono il premio del 15-25% in cambio di vincoli di accesso alle cure — medico di famiglia, HMO (rete di medici) o telemedicina — rispetto al modello standard a libera scelta.',
  ainp:
    'AINP (Assicurazione contro gli Infortuni Non Professionali): copertura obbligatoria inclusa nel pacchetto LAA per i lavoratori svizzeri con almeno 8 ore settimanali, finanziata dal datore di lavoro, copre gli incidenti fuori dall\'orario lavorativo.',

  // ── Permessi di soggiorno ──────────────────────────────────────────
  'permesso-g':
    'Permesso G: autorizzazione di lavoro per frontalieri che risiedono in un Paese confinante e rientrano quotidianamente. Validità 5 anni.',
  'permesso-b':
    'Permesso B: autorizzazione di dimora in Svizzera per cittadini UE/AELS. Consente residenza e lavoro in Svizzera, validità 5 anni.',
  'permesso-c':
    'Permesso C: autorizzazione di domicilio svizzero a tempo indeterminato, ottenibile dopo 5 anni di residenza continuativa con permesso B (10 anni per alcune nazionalità extra-UE). A differenza del permesso G richiede la residenza effettiva in Svizzera.',
  'permesso-l':
    'Permesso L: autorizzazione di soggiorno di breve durata per contratti di lavoro svizzeri fino a 12 mesi, rinnovabile una sola volta fino a 24 mesi complessivi; non dà accesso allo status di frontaliere con permesso G.',

  // ── Previdenza (1°/2°/3° pilastro) ─────────────────────────────────
  avs:
    'AVS (Assicurazione Vecchiaia e Superstiti): primo pilastro previdenziale svizzero. Contributo del 5,3% sullo stipendio dei frontalieri.',
  lpp:
    'LPP: secondo pilastro previdenziale svizzero (cassa pensione aziendale obbligatoria). Contributo dal 7% al 18% dello stipendio coordinato secondo la fascia d\'età.',
  'terzo-pilastro':
    'Terzo pilastro (3a/3b): previdenza privata svizzera con vantaggi fiscali. Il pilastro 3a è deducibile fino a CHF 7.258 annui per dipendenti.',
  rendita:
    'Rendita: pensione periodica erogata dal 1° pilastro AVS o dal 2° pilastro LPP svizzero al raggiungimento dell\'età pensionabile, in alternativa al prelievo del capitale in un\'unica soluzione.',
  'capitale-lpp':
    'Capitale LPP: somma unica del 2° pilastro svizzero che il frontaliere può prelevare, in tutto o in parte, al rientro definitivo in Italia; tassata in Svizzera con aliquota agevolata separata (4-12% secondo cantone e importo).',
  'prestazione-libero-passaggio':
    'Prestazione di libero passaggio: capitale della cassa pensione LPP accumulato da un frontaliere UE/AELS che lascia definitivamente la Svizzera. La parte sovraobbligatoria è riscuotibile subito, la parte obbligatoria resta vincolata su un conto di libero passaggio fino all\'età pensionabile.',

  // ── Cambio valuta e pagamenti ───────────────────────────────────────
  'tasso-di-cambio':
    'Tasso di cambio CHF/EUR: rapporto franco svizzero-euro, fondamentale per calcolare il netto in euro e le tasse italiane dei frontalieri.',
  'multi-valuta':
    'Conto multi-valuta: conto bancario o carta che permette di detenere e cambiare CHF ed EUR senza le commissioni di conversione bancarie tradizionali (fino al 2-3%), utile ai frontalieri che percepiscono lo stipendio in franchi e spendono in euro.',
  bonifico:
    'Bonifico: trasferimento di denaro tra conti bancari, in ambito SEPA (area euro) o internazionale CHF-EUR. Le commissioni bancarie tradizionali sui trasferimenti CHF→EUR variano dall\'1% al 3%, contro lo 0,3-0,5% dei servizi fintech.',
  sepa:
    'SEPA (Single Euro Payments Area): area di pagamento unica europea che standardizza i bonifici in euro tra 36 paesi, rendendoli gratuiti o a basso costo; non copre di per sé i trasferimenti in franchi svizzeri (CHF), valuta extra-SEPA.',

  // ── Lavoro e prestazioni sociali ─────────────────────────────────────
  ccnl:
    'CCNL (Contratto Collettivo Nazionale di Lavoro): accordo sindacale italiano che fissa minimi salariali, tredicesima e condizioni di settore; l\'equivalente svizzero per i frontalieri è il CCL (Contratto Collettivo di Lavoro) ticinese.',
  ipg:
    'IPG (Indennità di Perdita di Guadagno): prestazione svizzera del 1° pilastro che compensa la perdita di reddito durante servizio militare, civile o maternità/paternità, finanziata con lo stesso contributo AVS/AI/IPG del 5,3% dello stipendio.',
  ac:
    'AC (Assicurazione contro la Disoccupazione): contributo obbligatorio svizzero pari all\'1,1% dello stipendio lordo fino a un tetto salariale, che dà diritto all\'indennità di disoccupazione in caso di licenziamento durante il rapporto di lavoro in Svizzera.',
  naspi:
    'NASpI (Nuova Assicurazione Sociale per l\'Impiego): indennità di disoccupazione italiana, fino a 24 mesi, richiedibile dal frontaliere licenziato tramite il formulario PD U1 che totalizza i contributi versati alla cassa AC svizzera.',
  'assegni-familiari':
    'Assegni familiari: prestazione erogata dal datore di lavoro svizzero indipendentemente dalla residenza dei figli; in Ticino ammontano a CHF 200/mese per figlio fino a 16 anni e CHF 250/mese per figli in formazione fino a 25 anni.',
  tredicesima:
    'Tredicesima: mensilità aggiuntiva pari a un dodicesimo dello stipendio annuo lordo, obbligatoria in Svizzera nei settori coperti da CCL (industria, edilizia, commercio, ospitalità in Ticino) e sempre dovuta in Italia.',
};

/** Look up the shared definition for a glossario term by its IT URL slug. */
export function getGlossaryTermDefinition(slug: string): string | undefined {
  return GLOSSARY_TERM_DEFINITIONS[slug];
}

/**
 * Truncate a full definition to the 80-170 char meta-description hard range
 * enforced by tests/seo-description-length.test.ts (mirrors the established
 * truncateAtWordBoundary pattern in build-plugins/jobMarketSnapshotPlugin.ts).
 * The full, untruncated string is still used for DefinedTerm.description
 * (JSON-LD) and the on-page lede — only the <meta name="description"> value
 * needs this cap, since Google's own display limit is what the test encodes.
 */
export function truncateForMetaDescription(text: string, maxLength = 165): string {
  const s = text.trim();
  if (s.length <= maxLength) return s;
  const hardLimit = Math.max(1, maxLength - 1);
  const slice = s.slice(0, hardLimit);
  const lastSpace = slice.lastIndexOf(' ');
  const cutAt = lastSpace > Math.floor(hardLimit * 0.6) ? lastSpace : hardLimit;
  // Shared peel — a word-boundary cut still stops mid-clause ("…tassato in").
  const trimmed = peelDanglingClauseTail(slice.slice(0, cutAt));
  return `${trimmed}…`;
}
