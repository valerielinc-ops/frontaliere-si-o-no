// Italian translations — on-demand namespace "petition".
//
// Loaded by components/pages/StabioDossoPetitionPage.tsx through useTranslationNamespace('petition')
// (services/i18n.ts), NOT with the it-core chunk every route waits for.
const translations: Record<string, string> = {
 'petition.hero.subtitle': 'Ogni mattina il passaggio tra Gaggiolo e Stabio si trasforma in un collo di bottiglia. Chiediamo alle autorità di misurare l’effetto del dosso e di rimuoverlo o abbassarlo se esiste una soluzione sicura.',
 'petition.hero.meta': 'Stabio · Gaggiolo · mobilità quotidiana',
 'petition.hero.cta': 'Firma la petizione',
 'petition.notice': 'Le segnalazioni sul dosso e sui tempi aggiuntivi provengono dalla nostra raccolta editoriale e non sostituiscono una misurazione ufficiale. Non abbiamo trovato, al momento, un avviso pubblico che documenti posa e impatto: per questo chiediamo dati trasparenti prima di ogni decisione.',
 'petition.evidence.title': 'Cosa sappiamo finora',
 'petition.evidence.weekdayLabel': 'Giorni feriali',
 'petition.evidence.weekday': '1.083 veicoli/ora tra le 05:00 e le 06:00 nei giorni feriali',
 'petition.evidence.weekendLabel': 'Fine settimana',
 'petition.evidence.weekend': '15.836 veicoli al giorno il sabato; 12.489 la domenica',
 'petition.evidence.reportsLabel': 'Segnalazioni locali',
 'petition.evidence.reports': 'Segnalazioni locali: oltre 10 minuti aggiuntivi e code già dalle 05:00',
 'petition.ask.title': 'Che cosa chiediamo',
 'petition.ask.intro': 'La sicurezza viene prima. Ma una misura di moderazione del traffico deve essere proporzionata, verificabile e compatibile con il flusso reale di un valico internazionale.',
 'petition.ask.item1': 'Pubblicare la motivazione tecnica, la data di posa e i limiti di velocità associati al dosso.',
 'petition.ask.item2': 'Rilevare tempi di percorrenza e code prima e dopo il dosso, nei feriali e nei festivi, con dati confrontabili.',
 'petition.ask.item3': 'Rimuovere o abbassare il dosso se i dati mostrano un impatto sproporzionato e la sicurezza può essere garantita con una soluzione diversa.',
 'petition.ask.safety': 'Non chiediamo di eliminare la sicurezza stradale: chiediamo una soluzione efficace per residenti, lavoratori e persone che attraversano il confine.',
 'petition.sources.title': 'Fonti e contesto',
 'petition.sources.intro': 'Le fonti aiutano a separare i dati documentati dalle segnalazioni ancora da verificare.',
 'petition.sources.traffic': 'Il conteggio ufficiale OASI 2025 della stazione N24 Stabio-Gaggiolo mostra un flusso rilevante già all’alba e anche nel fine settimana.',
 'petition.sources.cdt': 'Il Corriere del Ticino ha descritto via Gaggiolo come una delle tratte più congestionate e ha riportato flussi di 1.000–1.100 veicoli l’ora nella fascia 05:00–20:00.',
 'petition.sources.municipality': 'Il Comune di Stabio definisce insoddisfacente la situazione del traffico su via Gaggiolo e via Cantonale e indica sicurezza e vivibilità tra le priorità.',
 'petition.sources.history': 'Nel 2015 una petizione locale raccolse circa 1.200 richieste per attraversamenti più sicuri e un territorio più vivibile: il problema della convivenza tra traffico e comunità non è nuovo.',
 'petition.form.title': 'Firma la richiesta',
 'petition.form.subtitle': 'La firma è personale, una per account. Per evitare firme anonime, devi registrarti o accedere al sito e confermare l’iscrizione alle nostre comunicazioni.',
 'petition.form.accountNotice': 'Per firmare devi creare un account o accedere con uno già esistente. La casella qui sotto iscrive il tuo indirizzo alle comunicazioni di Frontaliere Ticino; potrai gestire o revocare le preferenze in qualsiasi momento.',
 'petition.form.checkboxIntro': 'Per continuare, conferma di voler ricevere le comunicazioni:',
 'petition.form.emailLabel': 'Il tuo indirizzo email',
 'petition.form.emailHint': 'Riceverai un link per confermare l’email e accedere al modulo di firma.',
 'petition.form.emailCta': 'Continua con l’email',
 'petition.form.socialTitle': 'Oppure usa un account',
 'petition.form.socialIntro': 'Dopo l’accesso potrai inviare la firma dal tuo account verificato.',
 'petition.form.or': 'oppure',
 'petition.form.emailLink': 'Invia un nuovo link di accesso',
 'petition.form.backToForm': 'Torna al modulo',
 'petition.form.checkEmailTitle': 'Controlla la tua posta',
 'petition.form.checkEmailBody': 'Ti abbiamo inviato un link. Conferma l’indirizzo e apri il link su questo dispositivo; poi torna qui per firmare.',
 'petition.form.checkEmailReturn': 'Dopo la conferma, ricarica questa pagina se il modulo non si aggiorna da solo.',
 'petition.form.signedAs': 'Accesso effettuato come',
 'petition.form.signCta': 'Invia la mia firma',
 'petition.form.signing': 'Registrazione della firma…',
 'petition.form.successTitle': 'Firma registrata',
 'petition.form.successBody': 'La tua firma è stata aggiunta alla richiesta per una verifica trasparente del dosso tra Gaggiolo e Stabio.',
 'petition.form.already': 'Avevi già firmato questa petizione: la tua firma resta conteggiata una sola volta.',
 'petition.form.privacyNote': 'Conserviamo solo l’identificativo dell’account, la lingua e la data della firma; non pubblichiamo il tuo indirizzo email.',
 'petition.form.emailRequired': 'Inserisci un indirizzo email valido.',
 'petition.form.accountError': 'Accedi con un account verificato per poter firmare la petizione.',
 'petition.form.consentRequired': 'Per firmare devi confermare anche l’iscrizione alle comunicazioni.',
 'petition.form.newsletterOptOut': 'Questo indirizzo risulta disiscritto. Per rispetto della tua scelta non possiamo usarlo per la firma: scegli un indirizzo con consenso attivo o riattiva prima le preferenze.',
 'petition.form.newsletterError': 'Non è stato possibile completare l’iscrizione alle comunicazioni. Riprova tra poco.',
 'petition.form.error': 'Non è stato possibile registrare la firma. Riprova tra poco.',
};

/** Key families owned by this namespace; tests/i18n-namespaces.test.ts keeps them out of every core chunk. */
export const KEY_PREFIXES: readonly string[] = ["petition."];
/** Keys of those families that stay in core because a surface outside the namespace renders them. */
export const KEEP_IN_CORE: readonly string[] = ["petition.hero.title"];

export default translations;
