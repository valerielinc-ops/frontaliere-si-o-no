/**
 * Lessico dei qualificatori che spostano un "architetto" dall'edilizia all'IT.
 *
 * `architect` / `Architekt` / `architetto` sono omonimi: la stessa parola
 * nomina il progettista edile e il progettista di sistemi informatici. Sul
 * dataset riassemblato (28k annunci) il matcher del settore `architetti`
 * pesca 168 titoli e l'81% di essi porta uno di questi qualificatori: senza
 * escluderli la landing di settore mostra annunci IT sotto una query edile.
 *
 * Sorgente UNICA condivisa dai due punti che separano le due popolazioni:
 * - `jobSectorLanding.ts::SECTOR_MATCHERS.architetti` — lookaround adiacente,
 *   perche' li' il pattern e' testato su title+category+tags concatenati e un
 *   veto sull'intera stringa scarterebbe un architetto edile per un tag;
 * - `professionJobsAggregate.ts::PROFESSION_MATCHERS.architetto` — veto
 *   sull'intero titolo, che li' e' l'unico campo testato.
 * Due liste separate divergono in silenzio: e' lo stesso lessico, e vive qui.
 *
 * I token corti o ambigui (`it`, `ot`, `ai`, `sap`, ...) portano i propri
 * `\b`: senza, `it` matcherebbe dentro "unit" e "Sicherheit".
 */
export const ARCHITECT_TECH_QUALIFIER_SRC =
  '(?:software|solutions?|cloud|systems?|enterprise|entreprise|data|\\bit\\b|\\bict\\b|\\bot\\b|\\bai\\b'
  + '|security|sicherheits?|infrastructure|network|netzwerk|platform|plattform|application|technical|test'
  + '|\\bsap\\b|\\biam\\b|\\berp\\b|\\bcrm\\b|domain|business|integrations?|pega|tagetik|salesforce'
  + '|informatique|logiciel)';

/** Il lessico come RegExp, per un veto su un titolo intero. */
export const ARCHITECT_TECH_QUALIFIER_RE = new RegExp(ARCHITECT_TECH_QUALIFIER_SRC, 'i');
