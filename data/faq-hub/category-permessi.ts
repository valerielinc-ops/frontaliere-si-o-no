import type { FaqHubEntry } from './types';

/**
 * FAQ hub — category "permessi" (AE-5, 10/100).
 *
 * Scope: permessi G, B, passaggio G→B, rinnovi, residenza,
 * regola 45 min / 20 km, ricongiungimento familiare.
 */
export const FAQ_permessi: ReadonlyArray<FaqHubEntry> = [
  {
    id: 'permessi-differenza-g-b',
    category: 'permessi',
    question: {
      it: 'Qual è la differenza tra permesso G e permesso B?',
      en: 'What is the difference between G and B permits?',
      de: 'Was ist der Unterschied zwischen G- und B-Bewilligung?',
      fr: 'Quelle est la différence entre les permis G et B ?',
    },
    answer: {
      it:
        "Il permesso G (frontaliere) è rilasciato a cittadini UE/AELS che lavorano in Svizzera e rientrano in Italia almeno una volta alla settimana (art. 35 LStrI, art. 7 OLCP) [fonte: Fedlex SEM LStrI RS 142.20]. Non dà diritto alla residenza in Svizzera e non include il 2° pilastro come contribuente svizzero pieno. Il permesso B (residenza) è rilasciato a chi ha un contratto di oltre 12 mesi e trasferisce il domicilio in Svizzera; conferisce diritto alla residenza, al ricongiungimento familiare facile e alla progressione verso il permesso C dopo 5-10 anni. Il titolare B è tassato ordinariamente dopo il superamento della soglia di CHF 120.000 l'anno, mentre il G è sempre alla fonte. Il cambio G→B richiede il trasferimento effettivo di residenza.",
      en:
        "The G permit (cross-border) is issued to EU/EFTA nationals working in Switzerland who return to Italy at least weekly (Foreign Nationals Act art. 35, OLCP art. 7) [source: Fedlex SEM FNA RS 142.20]. It does not give Swiss residence rights. The B permit (residence) is issued with a contract over 12 months and actual domicile transfer to Switzerland; it gives residence, easy family reunification and progression to C permit after 5-10 years. B holders are taxed ordinarily above CHF 120,000/year, while G is always at source. Switching G→B requires effective residence transfer.",
      de:
        "Die G-Bewilligung (Grenzgänger) wird EU/EFTA-Bürgern erteilt, die in der Schweiz arbeiten und mindestens wöchentlich nach Italien zurückkehren (AIG Art. 35, VFP Art. 7) [Quelle: Fedlex SEM AIG SR 142.20]. Sie gewährt kein Wohnrecht in der Schweiz. Die B-Bewilligung (Aufenthalt) wird bei Vertrag über 12 Monate und effektiver Wohnsitzverlegung erteilt; sie gewährt Aufenthalt, erleichtertem Familiennachzug und Aufstieg zur C-Bewilligung nach 5-10 Jahren. B-Inhaber werden ordentlich besteuert ab CHF 120'000/Jahr, G immer an der Quelle. G→B-Wechsel erfordert echten Wohnsitzwechsel.",
      fr:
        "Le permis G (frontalier) est délivré aux ressortissants UE/AELE travaillant en Suisse qui rentrent en Italie au moins hebdomadairement (LEI art. 35, OLCP art. 7) [source : Fedlex SEM LEI RS 142.20]. Il n'ouvre pas de droit de résidence. Le permis B (séjour) exige un contrat de plus de 12 mois et le transfert effectif du domicile ; il ouvre résidence, regroupement familial facilité et progression vers le permis C après 5-10 ans. Les titulaires B sont imposés ordinairement au-delà de CHF 120 000/an, les G toujours à la source. Passage G→B : transfert réel du domicile.",
    },
    relatedLinks: [
      {
        href: '/guida-frontaliere/permessi-lavoro/',
        label: {
          it: 'Guida ai permessi di lavoro',
          en: 'Work permits guide',
          de: 'Leitfaden Arbeitsbewilligungen',
          fr: 'Guide des permis de travail',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2007/758/it',
      'https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html',
    ],
  },
  {
    id: 'permessi-regola-45-minuti',
    category: 'permessi',
    question: {
      it: 'Esiste ancora la regola dei 20 km o dei 45 minuti per i frontalieri?',
      en: 'Is the 20 km / 45 minutes rule for cross-border workers still in force?',
      de: 'Gilt die 20-km- oder 45-Minuten-Regel für Grenzgänger noch?',
      fr: 'La règle des 20 km ou 45 minutes pour frontaliers est-elle encore en vigueur ?',
    },
    answer: {
      it:
        "Sì, in forma aggiornata. L'Accordo fiscale CH-IT 2020 (art. 2) definisce «frontaliere» il lavoratore residente in uno dei comuni il cui territorio si trovi, in tutto o in parte, entro la zona di 20 km dal confine [fonte: Fedlex SR 0.642.045.43]. La SEM esige inoltre il rientro quotidiano (o almeno settimanale) al domicilio. La vecchia regola dei 45 minuti dalla frontiera è stata abbandonata nel 2004 per tutti i cittadini UE/AELS grazie all'Accordo sulla libera circolazione (ALC). Oggi il permesso G non richiede un tempo massimo di pendolarismo ma solo il rientro settimanale. Per i fini fiscali i 20 km restano rilevanti per distinguere vecchi/nuovi frontalieri e per i ristorni ai Comuni.",
      en:
        "Yes, updated. The CH-IT 2020 tax Agreement (art. 2) defines a cross-border worker as someone residing in a municipality whose territory lies, entirely or partly, within 20 km of the border [source: Fedlex SR 0.642.045.43]. SEM also requires daily (or at least weekly) return home. The old 45-minutes rule was dropped in 2004 for all EU/EFTA nationals under the Free Movement Agreement (AFMP). Today the G permit requires no commuting-time cap, only weekly return. For tax purposes the 20 km remain relevant for old/new worker classification and rebate allocation.",
      de:
        "Ja, aktualisiert. Das CH-IT-Steuerabkommen 2020 (Art. 2) definiert Grenzgänger als Personen, die in einer Gemeinde wohnen, deren Gebiet ganz oder teilweise innerhalb von 20 km von der Grenze liegt [Quelle: Fedlex SR 0.642.045.43]. Das SEM verlangt ausserdem tägliche (oder mind. wöchentliche) Rückkehr. Die alte 45-Minuten-Regel wurde 2004 mit dem FZA für alle EU/EFTA-Bürger aufgehoben. Die G-Bewilligung kennt heute keine Pendelzeit-Obergrenze, nur wöchentliche Rückkehr. Steuerlich bleibt die 20-km-Grenze für alte/neue Grenzgänger und Rückzahlungen relevant.",
      fr:
        "Oui, actualisée. L'Accord fiscal CH-IT 2020 (art. 2) définit le frontalier comme résidant dans une commune dont le territoire se trouve, en tout ou partie, dans la zone de 20 km de la frontière [source : Fedlex SR 0.642.045.43]. Le SEM exige aussi le retour quotidien (ou hebdomadaire). L'ancienne règle des 45 minutes a été abandonnée en 2004 pour tous les ressortissants UE/AELE avec l'Accord sur la libre circulation (ALCP). Le permis G n'impose plus de durée de trajet maximale, seulement le retour hebdomadaire. Fiscalement la zone des 20 km reste pertinente pour anciens/nouveaux frontaliers et ristournes.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2023/694/it',
      'https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta.html',
    ],
  },
  {
    id: 'permessi-rinnovo-g-scadenza',
    category: 'permessi',
    question: {
      it: 'Quanto dura il permesso G e come si rinnova?',
      en: 'How long is the G permit valid and how is it renewed?',
      de: 'Wie lange ist die G-Bewilligung gültig und wie wird sie erneuert?',
      fr: 'Quelle est la durée du permis G et comment le renouveler ?',
    },
    answer: {
      it:
        "Il permesso G UE/AELS ha durata pari al contratto di lavoro, fino a un massimo di 5 anni (art. 35 cpv. 2 LStrI, art. 7 OLCP) [fonte: Fedlex LStrI RS 142.20]. Per contratti indeterminati viene rilasciato con durata di 5 anni ed è rinnovato automaticamente se permane l'attività. Il datore di lavoro trasmette la richiesta di rilascio/rinnovo all'Ufficio della migrazione (in Ticino: Servizio migrazione a Bellinzona) tramite portale EasyGov, allegando contratto, certificato di residenza italiano e tessera sanitaria. Cambio di datore di lavoro: richiede una nuova notifica entro 8 giorni dalla nuova assunzione. Interruzione per disoccupazione: il permesso resta valido 6 mesi per cercare nuova occupazione (art. 61a LStrI).",
      en:
        "The EU/EFTA G permit lasts as long as the employment contract, up to 5 years (FNA art. 35 para. 2, OLCP art. 7) [source: Fedlex FNA RS 142.20]. Open-ended contracts are issued a 5-year permit, automatically renewed while employment continues. The employer files the request with the Migration Office (Ticino: Servizio migrazione, Bellinzona) via the EasyGov portal, attaching contract, Italian residence certificate and health card. Employer change requires a new notification within 8 days of new hire. Unemployment: permit remains valid 6 months to seek new work (FNA art. 61a).",
      de:
        "Die G-Bewilligung EU/EFTA gilt für die Vertragsdauer, max. 5 Jahre (AIG Art. 35 Abs. 2, VFP Art. 7) [Quelle: Fedlex AIG SR 142.20]. Unbefristete Verträge: 5 Jahre, automatische Verlängerung bei Fortbestehen. Arbeitgeber reicht Antrag bei der Migrationsbehörde ein (Tessin: Servizio migrazione, Bellinzona) via EasyGov mit Vertrag, italienischem Wohnsitzzeugnis, Gesundheitskarte. Arbeitgeberwechsel: neue Meldung binnen 8 Tagen. Arbeitslosigkeit: Bewilligung 6 Monate gültig zur Stellensuche (AIG Art. 61a).",
      fr:
        "Le permis G UE/AELE dure autant que le contrat, 5 ans maximum (LEI art. 35 al. 2, OLCP art. 7) [source : Fedlex LEI RS 142.20]. Contrat de durée indéterminée : permis 5 ans renouvelé automatiquement. L'employeur dépose la demande à l'Office des migrations (Tessin : Servizio migrazione, Bellinzone) via EasyGov avec contrat, certificat de résidence italien et carte de santé. Changement d'employeur : nouvelle notification dans les 8 jours. Chômage : permis valable 6 mois pour chercher un nouvel emploi (LEI art. 61a).",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2007/758/it',
      'https://www.easygov.swiss/',
    ],
  },
  {
    id: 'permessi-trasferimento-residenza-b',
    category: 'permessi',
    question: {
      it: 'Come passo dal permesso G al permesso B?',
      en: 'How do I switch from G permit to B permit?',
      de: 'Wie wechsle ich von der G- zur B-Bewilligung?',
      fr: 'Comment passer du permis G au permis B ?',
    },
    answer: {
      it:
        "Occorre trasferire la residenza effettiva in Svizzera (art. 33 LStrI) [fonte: Fedlex LStrI RS 142.20]. La procedura: (1) trovare alloggio in Svizzera e firmare contratto di locazione; (2) notificare l'arrivo al Controllo abitanti del Comune entro 14 giorni con passaporto, contratto di lavoro e contratto di locazione; (3) il Comune inoltra la richiesta al Servizio migrazione; (4) ritirare il permesso biometrico in 4-8 settimane. Costo: circa CHF 120-160. Contestualmente occorre iscriversi all'AIRE presso il Comune italiano di provenienza entro 90 giorni, cancellarsi dal SSN italiano e attivare LAMal svizzera. La residenza B richiede CHF 120.000 lordi annui o equivalente per ottenere imposizione ordinaria; altrimenti resta la fonte come per il G.",
      en:
        "You must effectively move to Switzerland (FNA art. 33) [source: Fedlex FNA RS 142.20]. Procedure: (1) find a Swiss dwelling and sign a lease; (2) notify the Municipal registry office within 14 days of arrival with passport, work contract and lease; (3) the Commune forwards the request to the Migration Office; (4) collect the biometric permit in 4-8 weeks. Cost: about CHF 120-160. You must also register at AIRE at your Italian originating municipality within 90 days, deregister from the Italian SSN and activate Swiss LAMal. Ordinary taxation needs CHF 120,000 gross/year; otherwise withholding tax applies as for G.",
      de:
        "Tatsächlicher Wohnsitzwechsel in die Schweiz (AIG Art. 33) [Quelle: Fedlex AIG SR 142.20]. Ablauf: (1) Schweizer Wohnung mieten; (2) innert 14 Tagen beim Einwohnerkontrollamt anmelden mit Pass, Arbeitsvertrag, Mietvertrag; (3) Gemeinde leitet an Migrationsdienst weiter; (4) biometrische Bewilligung in 4-8 Wochen abholen. Kosten ~CHF 120-160. Zeitgleich Eintrag im italienischen AIRE-Register (90 Tage), Austritt aus SSN, KVG-Abschluss. Ordentliche Besteuerung ab CHF 120'000 brutto/Jahr, sonst Quellensteuer wie bei G.",
      fr:
        "Transfert effectif du domicile en Suisse (LEI art. 33) [source : Fedlex LEI RS 142.20]. Procédure : (1) trouver un logement et signer un bail ; (2) annoncer l'arrivée au Contrôle des habitants de la commune dans les 14 jours avec passeport, contrat de travail et bail ; (3) la commune transmet au Service des migrations ; (4) retrait du permis biométrique en 4-8 semaines. Coût ~CHF 120-160. Il faut aussi s'inscrire à l'AIRE dans la commune italienne sous 90 jours, se désinscrire du SSN italien et souscrire la LAMal. Imposition ordinaire si revenu brut >CHF 120 000/an, sinon source comme pour le G.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2007/758/it',
    ],
  },
  {
    id: 'permessi-ricongiungimento-familiare-g',
    category: 'permessi',
    question: {
      it: 'Posso portare la famiglia in Svizzera con il permesso G?',
      en: 'Can I bring my family to Switzerland under the G permit?',
      de: 'Kann ich meine Familie mit der G-Bewilligung in die Schweiz bringen?',
      fr: 'Puis-je faire venir ma famille en Suisse avec le permis G ?',
    },
    answer: {
      it:
        "Il permesso G non prevede diritto automatico al ricongiungimento in Svizzera perché non conferisce residenza (art. 42 LStrI si applica ai permessi di dimora). Tuttavia il Regolamento ALC Allegato I, art. 3, consente al coniuge e ai figli di cittadini UE/AELS di installarsi nel luogo di lavoro del lavoratore se vi sono motivi comprovati (scuola internazionale, formazione) [fonte: Fedlex ALC SR 0.142.112.681]. In pratica, il ricongiungimento richiede in Svizzera un alloggio adeguato e risorse sufficienti, e va richiesto al Servizio migrazione. Più comune è il contrario: il frontaliere mantiene la famiglia in Italia e rientra ogni sera. Se si vuole stabilmente convivere in Svizzera conviene convertire in permesso B, che dà pieno diritto al ricongiungimento.",
      en:
        "The G permit does not give an automatic family reunification right in Switzerland because it is not a residence permit (FNA art. 42 applies to settlement permits). However AFMP Annex I art. 3 allows spouses and children of EU/EFTA nationals to settle at the worker's place of work if justified (international school, training) [source: Fedlex AFMP SR 0.142.112.681]. In practice, reunification requires suitable housing and sufficient means, submitted to the Migration Office. More commonly the worker keeps the family in Italy and returns each night. Converting to a B permit is simpler for permanent cohabitation.",
      de:
        "Die G-Bewilligung gewährt keinen automatischen Familiennachzug in die Schweiz, da sie keine Aufenthaltsbewilligung ist (AIG Art. 42 gilt für Niederlassung). FZA Anhang I Art. 3 erlaubt jedoch Ehepartnern und Kindern von EU/EFTA-Bürgern die Niederlassung am Arbeitsort bei triftigem Grund (internationale Schule, Ausbildung) [Quelle: Fedlex FZA SR 0.142.112.681]. Nachzug verlangt geeignete Wohnung und ausreichende Mittel, Antrag beim Migrationsdienst. Häufiger bleibt die Familie in Italien. Zur dauerhaften Ansiedlung ist der B-Wechsel einfacher.",
      fr:
        "Le permis G ne donne pas de droit automatique au regroupement familial en Suisse car il n'est pas un permis de résidence (LEI art. 42 pour les permis d'établissement). Toutefois l'Annexe I de l'ALCP art. 3 permet au conjoint et enfants des citoyens UE/AELE de s'installer au lieu de travail pour motif justifié (école internationale, formation) [source : Fedlex ALCP RS 0.142.112.681]. En pratique, logement adéquat et ressources suffisantes requis, demande au Service des migrations. Le plus souvent la famille reste en Italie. Pour une cohabitation stable, passer au permis B.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2002/243/it',
    ],
  },
  {
    id: 'permessi-residenza-aire-italia',
    category: 'permessi',
    question: {
      it: 'Devo iscrivermi all\'AIRE se ho il permesso G?',
      en: 'Must I register with AIRE if I hold a G permit?',
      de: 'Muss ich mich beim AIRE registrieren, wenn ich eine G-Bewilligung habe?',
      fr: 'Dois-je m\'inscrire à l\'AIRE si je détiens un permis G ?',
    },
    answer: {
      it:
        "No. L'AIRE (Anagrafe Italiani Residenti all'Estero) riguarda i cittadini italiani che trasferiscono la residenza fuori d'Italia per oltre 12 mesi [fonte: Ministero Affari Esteri, dlgs 470/1988]. Il frontaliere con permesso G mantiene residenza anagrafica in Italia, quindi NON si iscrive all'AIRE. Se invece trasferisce il domicilio in Svizzera (permesso B o C) deve iscriversi all'AIRE entro 90 giorni tramite consolato italiano di Lugano (portale FAST IT) e cancellarsi dal Comune italiano. L'iscrizione AIRE cambia gli obblighi fiscali (tassazione mondiale si sposta in Svizzera), sanitari (niente SSN, obbligo LAMal) e politici (voto solo per elezioni nazionali via corrispondenza). Restano validi passaporto e carta d'identità italiani.",
      en:
        "No. AIRE (Italian Citizens Resident Abroad Register) applies to Italians moving residence outside Italy for over 12 months [source: Italian MFA, dlgs 470/1988]. The G permit holder keeps Italian residence, so does NOT register with AIRE. Conversely, moving domicile to Switzerland (B or C permit) requires AIRE registration within 90 days via the Lugano Italian Consulate (FAST IT portal) and deregistration from the Italian municipality. AIRE registration changes tax (worldwide taxation shifts to Switzerland), health (no SSN, LAMal required) and political rights (only national elections by mail). Italian passport and ID remain valid.",
      de:
        "Nein. Das AIRE (Register der im Ausland ansässigen italienischen Staatsbürger) betrifft Italiener, die ihren Wohnsitz länger als 12 Monate ins Ausland verlegen [Quelle: italienisches Aussenministerium, Gesetzesdekret 470/1988]. G-Grenzgänger behalten den italienischen Wohnsitz und registrieren sich nicht im AIRE. Bei Wohnsitzwechsel in die Schweiz (B oder C) ist die AIRE-Einschreibung binnen 90 Tagen über das italienische Konsulat Lugano (Portal FAST IT) und Abmeldung in Italien zwingend. AIRE verändert Steuer-, Gesundheits- und Politikstatus (Weltsteuer CH, KVG, Briefwahl).",
      fr:
        "Non. L'AIRE (registre des Italiens résidant à l'étranger) concerne les Italiens qui transfèrent leur résidence hors d'Italie pour plus de 12 mois [source : MAE italien, décret 470/1988]. Le frontalier avec permis G garde sa résidence en Italie, donc NE s'inscrit PAS à l'AIRE. En revanche, le transfert du domicile en Suisse (permis B ou C) impose l'inscription à l'AIRE dans les 90 jours via le consulat de Lugano (portail FAST IT) et la désinscription de la commune italienne. L'AIRE modifie les obligations fiscales (taxation mondiale en Suisse), sanitaires (LAMal) et politiques (vote par correspondance).",
    },
    sources: [
      'https://www.esteri.it/it/servizi-consolari-e-visti/italiani-all-estero/aire_2/',
    ],
  },
  {
    id: 'permessi-lavoro-secondario-ticino',
    category: 'permessi',
    question: {
      it: 'Posso avere due datori di lavoro in Svizzera con un permesso G?',
      en: 'Can I have two Swiss employers with one G permit?',
      de: 'Kann ich mit einer G-Bewilligung zwei Schweizer Arbeitgeber haben?',
      fr: 'Puis-je avoir deux employeurs suisses avec un permis G ?',
    },
    answer: {
      it:
        "Sì. L'OLCP art. 12 consente ai titolari di permesso G di esercitare più attività lucrative simultaneamente in Svizzera [fonte: Fedlex OLCP RS 142.203]. Ogni datore di lavoro notifica l'impiego e calcola l'imposta alla fonte sulla propria quota. Attenzione: la tabella fiscale è quella del reddito aggregato (codice L o B se superiori a CHF 120.000 totali), e al momento del conguaglio cantonale (richiesta di NOV, nuovo Nuovo calcolo ordinario) il frontaliere può presentare certificati di tutti i datori per evitare tassazione doppia. LAMal e LAINF vanno ripartite: il datore con orario maggiore trattiene la LAINF non professionale. L'AVS/LPP si cumula e il secondo datore può affiliarsi automaticamente alla stessa cassa pensione se supera CHF 22.050/anno.",
      en:
        "Yes. OLCP art. 12 allows G permit holders to hold multiple Swiss employments simultaneously [source: Fedlex OLCP RS 142.203]. Each employer notifies the hire and withholds tax on its share. The tax table is based on aggregate income (code L or B if total exceeds CHF 120,000); at cantonal settlement (NOV — new ordinary computation) the worker may file all payslips to avoid double taxation. LAMal and LAINF must be split: the main employer withholds non-professional LAINF. AVS/LPP accumulate, and the second employer enrols automatically if its part exceeds CHF 22,050/year.",
      de:
        "Ja. VFP Art. 12 erlaubt G-Inhabern gleichzeitige Mehrfachanstellung in der Schweiz [Quelle: Fedlex VFP SR 142.203]. Jeder Arbeitgeber meldet und zieht Quellensteuer anteilig ab. Tarif: aggregiertes Einkommen (Code L oder B über CHF 120'000); bei der NOV (neue ordentliche Veranlagung) legt der Grenzgänger alle Lohnausweise vor, um Doppelbesteuerung zu vermeiden. KVG und UVG aufteilen: Hauptarbeitgeber deckt Nichtberufsunfall. AHV/BVG werden kumuliert, Zweitarbeitgeber schliesst automatisch bei >CHF 22'050/Jahr an.",
      fr:
        "Oui. L'art. 12 OLCP permet aux détenteurs du permis G d'exercer plusieurs activités lucratives simultanées en Suisse [source : Fedlex OLCP RS 142.203]. Chaque employeur annonce l'embauche et retient l'impôt à la source sur sa part. Barème : revenu agrégé (code L ou B si total >CHF 120 000) ; au décompte cantonal (TOU, taxation ordinaire ultérieure) le frontalier présente tous les certificats de salaire pour éviter la double imposition. LAMal et LAA réparties : l'employeur principal retient la LAA non professionnelle. AVS/LPP cumulées, le second employeur s'affilie à partir de CHF 22 050/an.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2007/759/it',
    ],
  },
  {
    id: 'permessi-disoccupazione-g-permit',
    category: 'permessi',
    question: {
      it: 'Se perdo il lavoro cosa succede al permesso G?',
      en: 'What happens to my G permit if I lose my job?',
      de: 'Was passiert mit meiner G-Bewilligung bei Jobverlust?',
      fr: 'Que devient mon permis G si je perds mon emploi ?',
    },
    answer: {
      it:
        "Il permesso G resta valido per 6 mesi dopo la fine del rapporto (art. 61a LStrI) per consentire la ricerca di un nuovo impiego [fonte: Fedlex LStrI RS 142.20]. Durante questo periodo il frontaliere può iscriversi come disoccupato. La competenza assicurativa cambia in base al domicilio: residente in Italia, l'indennità di disoccupazione (NASpI) è versata dall'INPS sulla base dei contributi svizzeri trasferiti via formulario U1 [fonte: Reg. UE 883/2004 art. 65]. Serve certificato U1 rilasciato dalla Cassa di disoccupazione cantonale svizzera. In parallelo, se trova lavoro in CH entro 6 mesi, il permesso G si rinnova automaticamente con il nuovo contratto. Oltre i 6 mesi il permesso decade e occorre ripresentare domanda.",
      en:
        "The G permit remains valid for 6 months after employment ends (FNA art. 61a) to allow job search [source: Fedlex FNA RS 142.20]. During this period the worker may claim unemployment. Insurance competence follows residence: if resident in Italy, unemployment benefit (NASpI) is paid by INPS based on Swiss contributions transferred via U1 form [source: EU Reg. 883/2004 art. 65]. A U1 certificate from the Swiss cantonal unemployment fund is required. If the worker finds a new Swiss job within 6 months, the G permit is automatically renewed. After 6 months it lapses and a new application is needed.",
      de:
        "Die G-Bewilligung bleibt 6 Monate nach Anstellungsende gültig (AIG Art. 61a) für die Stellensuche [Quelle: Fedlex AIG SR 142.20]. Arbeitslosengeld richtet sich nach dem Wohnsitz: in Italien wohnhaft zahlt INPS (NASpI) auf Basis schweizerischer Beiträge via U1-Formular [Quelle: EU-VO 883/2004 Art. 65]. U1 wird von der schweizerischen kantonalen Arbeitslosenkasse ausgestellt. Neue Schweizer Stelle binnen 6 Monaten: G-Bewilligung wird automatisch verlängert. Danach erlischt sie; Neuantrag nötig.",
      fr:
        "Le permis G reste valable 6 mois après la fin de l'emploi (LEI art. 61a) pour la recherche [source : Fedlex LEI RS 142.20]. Pendant cette période on peut s'inscrire au chômage. Compétence selon le domicile : résident en Italie, la NASpI est versée par l'INPS sur la base des cotisations suisses transférées via formulaire U1 [source : règl. UE 883/2004 art. 65]. Le U1 est émis par la caisse cantonale suisse. Nouvelle embauche en Suisse en 6 mois : permis G renouvelé automatiquement. Au-delà, il s'éteint ; nouvelle demande.",
    },
    relatedLinks: [
      {
        href: '/guida-frontaliere/disoccupazione-frontalieri/',
        label: {
          it: 'Disoccupazione frontalieri',
          en: 'Cross-border unemployment',
          de: 'Arbeitslosigkeit Grenzgänger',
          fr: 'Chômage frontaliers',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2007/758/it',
      'https://eur-lex.europa.eu/legal-content/IT/TXT/?uri=CELEX%3A32004R0883',
    ],
  },
  {
    id: 'permessi-cambio-datore-lavoro',
    category: 'permessi',
    question: {
      it: 'Se cambio datore di lavoro devo cambiare anche il permesso G?',
      en: 'If I change employer do I need to change the G permit?',
      de: 'Brauche ich bei Arbeitgeberwechsel eine neue G-Bewilligung?',
      fr: 'Si je change d\'employeur, dois-je changer le permis G ?',
    },
    answer: {
      it:
        "Il permesso G è personale, non vincolato al datore. Tuttavia il nuovo datore deve notificare l'assunzione al Servizio migrazione cantonale entro 8 giorni via EasyGov, indicando il numero del permesso vigente (art. 9 OLCP) [fonte: Fedlex OLCP RS 142.203]. Non serve nuova procedura di rilascio. Se il nuovo impiego è in un cantone diverso da quello d'emissione del permesso, l'autorità può richiedere un trasferimento di competenza. In caso di interruzione tra i due contratti, vale il periodo di 6 mesi per la ricerca di lavoro (art. 61a LStrI). Il titolare del permesso G deve a sua volta informare il Comune italiano di residenza del cambio di datore (rilevante per la dichiarazione dei redditi e per l'eventuale iscrizione SSN in caso di interruzione).",
      en:
        "The G permit is personal, not tied to a specific employer. The new employer must notify the Cantonal Migration Office within 8 days via EasyGov, indicating the existing permit number (OLCP art. 9) [source: Fedlex OLCP RS 142.203]. No new issuance procedure is required. If the new job is in a different canton, jurisdictional transfer may be needed. Unemployment between jobs: 6-month rule applies (FNA art. 61a). The G holder must inform the Italian municipality of the change (relevant for tax declaration and possible SSN re-enrolment).",
      de:
        "Die G-Bewilligung ist personenbezogen, nicht arbeitgeberbezogen. Neuer Arbeitgeber meldet binnen 8 Tagen via EasyGov dem kantonalen Migrationsdienst unter Angabe der bestehenden Bewilligungsnummer (VFP Art. 9) [Quelle: Fedlex VFP SR 142.203]. Kein neues Ausstellungsverfahren. Bei Kantonswechsel kann Zuständigkeitsübertragung nötig sein. Bei Unterbruch gilt die 6-Monats-Regel (AIG Art. 61a). G-Inhaber informiert auch die italienische Wohngemeinde (relevant für Steuererklärung und SSN).",
      fr:
        "Le permis G est personnel, non lié à l'employeur. Le nouvel employeur doit annoncer l'embauche au Service cantonal des migrations dans les 8 jours via EasyGov en indiquant le numéro du permis existant (OLCP art. 9) [source : Fedlex OLCP RS 142.203]. Aucune nouvelle procédure d'émission. Changement de canton : transfert de compétence possible. En cas d'interruption : règle des 6 mois (LEI art. 61a). Le titulaire informe aussi la commune italienne (déclaration fiscale et éventuelle réinscription au SSN).",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2007/759/it',
    ],
  },
  {
    id: 'permessi-familiari-frontalieri-g',
    category: 'permessi',
    question: {
      it: 'Il coniuge e i figli possono avere un permesso G familiare?',
      en: 'Can spouse and children hold a family G permit?',
      de: 'Können Ehepartner und Kinder eine G-Familienbewilligung haben?',
      fr: 'Le conjoint et les enfants peuvent-ils avoir un permis G familial ?',
    },
    answer: {
      it:
        "Sì. L'ALC Allegato I art. 3 consente ai familiari (coniuge, figli minori di 21 anni o a carico, ascendenti a carico) di cittadini UE/AELS frontalieri di esercitare un'attività lucrativa in Svizzera e ottenere a loro volta un permesso G di 5 anni [fonte: Fedlex ALC SR 0.142.112.681]. Non serve un contratto minimo di durata. La notifica al Servizio migrazione è identica a quella del titolare principale. Il coniuge mantiene la residenza in Italia e la tassazione resta alla fonte (o ordinaria in caso di superamento dei CHF 120.000). Se invece il familiare lavora in Italia, non ha bisogno di permesso svizzero. In mancanza di lavoro, il coniuge e i figli non ricevono automaticamente un permesso G: serve un ricongiungimento a un permesso B o C in Svizzera.",
      en:
        "Yes. AFMP Annex I art. 3 allows family members (spouse, children under 21 or dependents, dependent parents) of EU/EFTA cross-border workers to work in Switzerland and obtain their own 5-year G permit [source: Fedlex AFMP SR 0.142.112.681]. No minimum contract duration is required. The migration notification is identical to the main holder's. The spouse keeps Italian residence and withholding taxation (or ordinary above CHF 120,000). If the family member works in Italy they don't need a Swiss permit. Without employment, spouse and children do not get an automatic G: they need family reunification to a B or C permit.",
      de:
        "Ja. FZA Anhang I Art. 3 erlaubt Familienangehörigen (Ehepartner, Kinder unter 21 Jahren oder unterhaltsberechtigte, unterhaltsberechtigte Eltern) von EU/EFTA-Grenzgängern eine Erwerbstätigkeit in der Schweiz und damit eine eigene G-Bewilligung für 5 Jahre [Quelle: Fedlex FZA SR 0.142.112.681]. Keine Mindestvertragsdauer. Meldung identisch. Wohnsitz und Quellensteuer bleiben in Italien (ordentlich ab CHF 120'000). Beim Arbeiten in Italien kein CH-Bewilligung nötig. Ohne Arbeit kein automatisches G; nur Nachzug zur B- oder C-Bewilligung.",
      fr:
        "Oui. ALCP Annexe I art. 3 permet aux membres de la famille (conjoint, enfants < 21 ans ou à charge, ascendants à charge) des frontaliers UE/AELE de travailler en Suisse et d'obtenir leur propre permis G de 5 ans [source : Fedlex ALCP RS 0.142.112.681]. Pas de durée minimale de contrat. Notification identique. Le conjoint garde sa résidence en Italie et l'imposition à la source (ou ordinaire >CHF 120 000). S'il travaille en Italie, pas besoin de permis suisse. Sans emploi, pas de G automatique : regroupement familial sur permis B ou C.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2002/243/it',
    ],
  },
];
