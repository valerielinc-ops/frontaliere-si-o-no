/**
 * profession-taxonomy.mjs — deterministic profession taxonomy + matchers.
 *
 * Shared by scripts/profession-keyword-opportunities.mjs (weekly gap
 * ranking, #3396) and consumed indirectly by
 * scripts/generate-keyword-pages-config.mjs via the emitted
 * data/profession-keyword-opportunities.json.
 *
 * Zero-Claude by design: matching is normalization + stemming + curated
 * alias lists across the 4 site locales (it canonical, de/fr/en because
 * crawler job titles are multi-lingual). No model calls, ever.
 *
 * Matching rules (see matchProfession):
 *  - text is normalized (lowercase, accents stripped, non-alnum → space);
 *  - single-word aliases match a token when their stems are equal, or when
 *    the token (≥5 chars) is a prefix of the alias stem — this absorbs
 *    on-site typing prefixes ("inferm", "infermier" → infermiere) without
 *    picking up 1-4 char noise ("i", "inf", "infe");
 *  - multi-word aliases match when every word appears (stem-equal) among
 *    the text tokens, order-free ("operatore socio" ⊂ "operatore socio
 *    sanitario");
 *  - the longest matching alias wins, so "assistente dentale" beats a
 *    hypothetical single-word "assistente" alias.
 */

/** Lowercase, strip accents, collapse every non-alphanumeric run to a space. */
export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stem a normalized single word: strip ONE trailing vowel when the word is
 * ≥5 chars. Collapses Italian gender/number variants onto one stem
 * (infermiere/infermieri/infermiera → infermier, psicologo/psicologa →
 * psicolog) without a full stemmer.
 */
export function stemToken(token) {
  if (token.length >= 5 && /[aeiou]$/.test(token)) return token.slice(0, -1);
  return token;
}

function tokenMatchesAlias(token, alias) {
  const ts = stemToken(token);
  const as = stemToken(alias);
  if (ts === as) return true;
  // Typing-prefix tolerance: on-site search logs partial terms while the
  // user types. Require ≥5 chars so "inf"/"infe" stay noise.
  if (token.length >= 5 && as.startsWith(ts)) return true;
  return false;
}

/**
 * Curated taxonomy. `id` is the IT canonical kebab slug, `label` the IT
 * display name, `aliases` the normalized match surface (it/de/fr/en +
 * gender variants + common CH job-title spellings), `feedFilter` the single
 * IT substring generate-keyword-pages-config.mjs uses as filterKeywords
 * (jobsSeoPagesPlugin ANDs filterKeywords, so exactly one substring).
 */
export const PROFESSION_TAXONOMY = [
  // ── Cluster sanitario / paramedico (priorità #3393) ──────────────────
  { id: 'infermiere', label: 'Infermiere', feedFilter: 'infermier', aliases: ['infermiere', 'infermiera', 'pflegefachfrau', 'pflegefachmann', 'pflegefachperson', 'infirmier', 'infirmiere', 'nurse'] },
  { id: 'oss', label: 'Operatore socio sanitario (OSS)', feedFilter: 'socio sanitario', aliases: ['oss', 'operatore socio sanitario', 'operatore socio', 'operatrice socio sanitaria', 'fachfrau gesundheit', 'fachmann gesundheit', 'fage', 'assistant en soins', 'health care assistant', 'fachfrau langzeitpflege und betreuung', 'fachmann langzeitpflege und betreuung', 'operatore sociosanitario', 'operatrice sociosanitaria'] },
  { id: 'psicologo', label: 'Psicologo', feedFilter: 'psicolog', aliases: ['psicologo', 'psicologa', 'psicoterapeuta', 'psychologe', 'psychologin', 'psychologue', 'psychologist', 'psychotherapeut', 'psychotherapeutin'] },
  { id: 'fisioterapista', label: 'Fisioterapista', feedFilter: 'fisioterap', aliases: ['fisioterapista', 'fisioterapia', 'physiotherapeut', 'physiotherapeutin', 'physiotherapie', 'physiotherapeute', 'physiotherapist', 'physio', 'tierphysiotherapeut', 'tierphysiotherapeutin'] },
  { id: 'logopedista', label: 'Logopedista', feedFilter: 'logoped', aliases: ['logopedista', 'logopedia', 'logopade', 'logopadin', 'logopede', 'speech therapist'] },
  { id: 'farmacista', label: 'Farmacista', feedFilter: 'farmacist', aliases: ['farmacista', 'apotheker', 'apothekerin', 'pharmacien', 'pharmacienne', 'pharmacist', 'pharma assistentin', 'assistente di farmacia', 'assistant en pharmacie', 'assistante en pharmacie', 'fachfrau apotheke', 'fachmann apotheke'] },
  { id: 'ostetrica', label: 'Ostetrica', feedFilter: 'ostetric', aliases: ['ostetrica', 'ostetrico', 'hebamme', 'sage femme', 'midwife', 'levatrice'] },
  { id: 'assistente-dentale', label: 'Assistente dentale', feedFilter: 'dental', aliases: ['assistente dentale', 'igienista dentale', 'dentalassistentin', 'dentalassistent', 'dentalhygieniker', 'dentalhygienikerin', 'assistante dentaire', 'dental assistant', 'dental hygienist', 'hygieniste dentaire'] },
  { id: 'tecnico-radiologia', label: 'Tecnico di radiologia (TRM)', feedFilter: 'radiolog', aliases: ['tecnico di radiologia', 'tecnico radiologia', 'trm', 'radiologia medica', 'fachfrau mtr', 'fachmann mtr', 'radiologiefachfrau', 'radiologiefachmann', 'technicien en radiologie', 'radiographer', 'technicienne en radiologie medicale'] },
  { id: 'ergoterapista', label: 'Ergoterapista', feedFilter: 'ergoterap', aliases: ['ergoterapista', 'ergoterapia', 'ergotherapeut', 'ergotherapeutin', 'ergotherapeute', 'occupational therapist'] },
  { id: 'dietista', label: 'Dietista', feedFilter: 'dietist', aliases: ['dietista', 'nutrizionista', 'ernahrungsberater', 'ernahrungsberaterin', 'dieteticien', 'dieteticienne', 'dietitian', 'ernahrungswissenschafter', 'ernahrungswissenschafterin', 'nutritionniste'] },
  { id: 'ottico-optometrista', label: 'Ottico optometrista', feedFilter: 'optometrist', aliases: ['ottico', 'optometrista', 'optiker', 'optikerin', 'optometrist', 'optometristin', 'opticien', 'opticienne', 'augenoptiker', 'augenoptikerin', 'feinwerkoptiker', 'feinwerkoptikerin'] },
  { id: 'podologo', label: 'Podologo', feedFilter: 'podolog', aliases: ['podologo', 'podologa', 'podologe', 'podologin', 'podologue', 'podiatrist'] },
  { id: 'assistente-medico', label: 'Assistente di studio medico', feedFilter: 'studio medico', aliases: ['assistente di studio medico', 'assistente studio medico', 'mpa', 'medizinische praxisassistentin', 'medizinischer praxisassistent', 'praxisassistentin', 'assistante medicale', 'medical practice assistant'] },
  { id: 'tso-strumentista', label: 'Tecnico di sala operatoria (TSO)', feedFilter: 'sala operatoria', aliases: ['tso', 'strumentista', 'tecnico di sala operatoria', 'sala operatoria', 'fachfrau operationstechnik', 'fachmann operationstechnik', 'operationstechnik', 'technicien en salle d operation'] },
  { id: 'medico', label: 'Medico', feedFilter: 'medico', aliases: ['medico', 'medico assistente', 'arzt', 'arztin', 'oberarzt', 'oberarztin', 'assistenzarzt', 'assistenzarztin', 'medecin', 'physician', 'allgemeinarzt', 'allgemeinarztin', 'dentista', 'facharzt', 'facharztin', 'fachzahnarzt', 'fachzahnarztin', 'komplementartherapeut', 'komplementartherapeutin', 'medizinproduktetechnologe', 'medizinproduktetechnologin', 'technologue en dispositifs medicaux', 'terapista in medicina complementare', 'zahnarzt', 'zahnarztin'] },
  { id: 'veterinario', label: 'Veterinario', feedFilter: 'veterinar', aliases: ['veterinario', 'veterinaria', 'tierarzt', 'tierarztin', 'veterinaire', 'veterinarian', 'tiermedizinischer praxisassistent', 'veterinaranasthesist', 'veterinaranasthesistin'] },
  { id: 'assistente-cura', label: 'Assistente di cura', feedFilter: 'assistente di cura', aliases: ['assistente di cura', 'assistente cura', 'pflegehelfer', 'pflegehelferin', 'pflegeassistent', 'pflegeassistentin', 'aide soignant', 'aide soignante', 'auxiliaire de sante', 'collaboratore sanitario', 'collaboratrice sanitaria'] },

  // ── Tecnica / ingegneria / IT ─────────────────────────────────────────
  { id: 'informatico', label: 'Informatico', feedFilter: 'informatic', aliases: ['informatico', 'informatica aziendale', 'sviluppatore', 'programmatore', 'informatiker', 'informatikerin', 'software engineer', 'software developer', 'developpeur', 'ict', 'entwickler digitales business', 'entwicklerin digitales business', 'gebaudeinformatiker', 'gebaudeinformatikerin', 'informaticien', 'informaticien de gestion', 'informaticien du batiment', 'informaticienne', 'informaticienne de gestion', 'informaticienne du batiment', 'informatiklehrer', 'informatiklehrerin', 'operateur en informatique', 'operatrice en informatique', 'wirtschaftsinformatiker', 'wirtschaftsinformatikerin'] },
  { id: 'progettista-elettrico', label: 'Progettista elettrico', feedFilter: 'progettista', aliases: ['progettista elettrico', 'progettista', 'elektroplaner', 'elektroplanerin', 'projeteur electricien', 'electrical designer'] },
  { id: 'polimeccanico', label: 'Polimeccanico', feedFilter: 'polimeccanic', aliases: ['polimeccanico', 'polymechaniker', 'polymechanikerin', 'polymecanicien', 'polymechanic', 'polymecanicienne'] },
  { id: 'meccanico', label: 'Meccanico', feedFilter: 'meccanic', aliases: ['meccanico', 'meccanico auto', 'automechaniker', 'automobil mechatroniker', 'mecanicien', 'mechanic', 'mechaniker', 'allrounder maschinenmechanik', 'automobil fachfrau', 'automobil fachmann', 'automobildiagnostiker', 'automobildiagnostikerin', 'baumaschinenmechaniker', 'baumaschinenmechanikerin', 'fachfrau komfortluftung', 'fachmann komfortluftung', 'fahrradmechaniker', 'fahrradmechanikerin', 'kleinmotorrad und fahrradmechaniker', 'kleinmotorrad und fahrradmechanikerin', 'landmaschinenmechaniker', 'landmaschinenmechanikerin', 'luftfahrzeugmechaniker', 'luftfahrzeugmechanikerin', 'manoeuvre industrie mecanique', 'maschineningenieur', 'maschineningenieurin', 'mecanicienne de production', 'mecanicienne en cycles', 'mecanicienne en machines agricoles', 'mecanicienne en machines de chantier', 'mecanicienne en motocycles', 'mecanicienne en motocycles de petite cylindree et cycles', 'mecanicienne sur aeronefs', 'mechanikpraktiker', 'mechanikpraktikerin', 'motorgeratemechaniker', 'motorgeratemechanikerin', 'motorradmechaniker', 'motorradmechanikerin', 'praticien en mecanique', 'praticienne en mecanique', 'produktionsmechaniker', 'produktionsmechanikerin', 'specialiste en aeration douce'] },
  { id: 'meccatronico', label: 'Meccatronico', feedFilter: 'meccatronic', aliases: ['meccatronico', 'mechatroniker', 'mechatronikerin', 'mecatronicien', 'mechatronics', 'mecatronicienne de remontees mecaniques'] },
  { id: 'saldatore', label: 'Saldatore', feedFilter: 'saldator', aliases: ['saldatore', 'saldatrice tig', 'schweisser', 'schweisserin', 'soudeur', 'welder', 'esperta saldatrice', 'experte soudeuse', 'schweissfachfrau', 'schweissfachmann'] },
  { id: 'tecnico-cnc', label: 'Operatore CNC', feedFilter: 'cnc', aliases: ['cnc', 'fresatore', 'tornitore', 'cnc fraser', 'cnc dreher', 'operateur cnc', 'cnc operator', 'cnc machinist', 'dreher', 'dreherin', 'fraiseur', 'fraiseuse', 'fraser', 'fraserin', 'fresatrice', 'tornitrice', 'tourneur', 'tourneuse'] },
  { id: 'disegnatore', label: 'Disegnatore tecnico', feedFilter: 'disegnator', aliases: ['disegnatore', 'disegnatrice', 'zeichner', 'zeichnerin', 'hochbauzeichner', 'bauzeichner', 'dessinateur', 'dessinatrice', 'draftsman', 'konstrukteur', 'konstrukteurin', 'landschaftsbauzeichner', 'landschaftsbauzeichnerin', 'metallbaukonstrukteur', 'metallbaukonstrukteurin', 'mikrozeichner', 'mikrozeichnerin', 'projeteur constructeur sur metal', 'projeteuse constructrice sur metal'] },
  { id: 'automazione', label: 'Tecnico automazione', feedFilter: 'automazion', aliases: ['automazione', 'automatico', 'automatiker', 'automatikerin', 'automaticien', 'automaticienne', 'automation engineer', 'agent en automatique', 'agente en automatique', 'automatenbetreuer', 'automatenbetreuerin', 'automatikfachfrau', 'automatikfachmann', 'automatikmonteur', 'automatikmonteurin', 'gebaudeautomatiker', 'gebaudeautomatikerin', 'surveillant de distributeurs automatiques', 'surveillante de distributeurs automatiques'] },

  // ── Amministrazione / finanza / servizi ───────────────────────────────
  { id: 'contabile', label: 'Contabile', feedFilter: 'contabil', aliases: ['contabile', 'contabilita', 'buchhalter', 'buchhalterin', 'comptable', 'accountant', 'accounting', 'fachfrau im finanz und rechnungswesen', 'fachmann im finanz und rechnungswesen', 'lohnbuchhalter', 'lohnbuchhalterin', 'specialiste en finance et comptabilite', 'wirtschaftsprufer', 'wirtschaftspruferin'] },
  { id: 'segretaria', label: 'Segretaria', feedFilter: 'segretar', aliases: ['segretaria', 'segretario', 'sekretarin', 'sekretar', 'secretaire', 'secretary', 'gemeindeschreiber', 'gemeindeschreiberin', 'gerichtssekretar', 'gerichtssekretarin', 'gewerkschaftssekretar', 'gewerkschaftssekretarin', 'greffier', 'greffiere', 'hotelsekretar', 'hotelsekretarin', 'steuersekretar', 'steuersekretarin'] },
  { id: 'risorse-umane', label: 'Risorse umane (HR)', feedFilter: 'risorse umane', aliases: ['risorse umane', 'hr manager', 'hr assistant', 'hr fachfrau', 'hr fachmann', 'personalberater', 'ressources humaines', 'human resources', 'recruiter'] },
  { id: 'fiduciario', label: 'Fiduciario', feedFilter: 'fiduciar', aliases: ['fiduciario', 'fiduciaria', 'treuhander', 'treuhanderin', 'fiduciaire', 'trustee', 'administrateur de biens immobiliers', 'administratrice de biens immobiliers', 'immobilientreuhander', 'immobilientreuhanderin', 'treuhandexperte', 'treuhandexpertin'] },
  { id: 'consulente-clientela', label: 'Consulente alla clientela', feedFilter: 'consulente', aliases: ['consulente alla clientela', 'consulente clientela', 'consulente', 'kundenberater', 'kundenberaterin', 'conseiller clientele', 'conseillere clientele', 'client advisor'] },
  { id: 'assistente-sociale', label: 'Assistente sociale', feedFilter: 'assistente sociale', aliases: ['assistente sociale', 'sozialarbeiter', 'sozialarbeiterin', 'sozialpadagoge', 'sozialpadagogin', 'assistant social', 'assistante sociale', 'social worker'] },
  { id: 'docente', label: 'Docente', feedFilter: 'docente', aliases: ['docente', 'insegnante', 'maestro', 'maestra', 'lehrer', 'lehrerin', 'lehrperson', 'enseignant', 'enseignante', 'teacher'] },
  { id: 'receptionist', label: 'Receptionist', feedFilter: 'receptionist', aliases: ['receptionist', 'receptionniste', 'rezeptionist', 'rezeptionistin', 'front desk', 'empfangsmitarbeiter', 'hotelreceptionist', 'hotelreceptionistin', 'receptionistin', 'ricezionista'] },

  // ── Edilizia / artigianato ────────────────────────────────────────────
  { id: 'idraulico', label: 'Idraulico', feedFilter: 'idraulic', aliases: ['idraulico', 'installatore sanitario', 'sanitarinstallateur', 'sanitar installateur', 'installateur sanitaire', 'plumber', 'plombier', 'hydraulicien', 'hydraulicienne', 'hydrauliker', 'hydraulikerin', 'installatore di impianti sanitari', 'installatrice di impianti sanitari', 'installatrice sanitaire', 'sanitarinstallateurin'] },
  { id: 'falegname', label: 'Falegname', feedFilter: 'falegnam', aliases: ['falegname', 'schreiner', 'schreinerin', 'zimmermann', 'menuisier', 'carpenter', 'tischler', 'bauschreiner', 'bauschreinerin', 'charron', 'charronne', 'schreinerpraktiker', 'schreinerpraktikerin', 'wagner', 'wagnerin', 'zimmerin'] },
  { id: 'carpentiere', label: 'Carpentiere', feedFilter: 'carpent', aliases: ['carpentiere', 'carpenteria metallica', 'zimmermann', 'metallbauer', 'charpentier', 'carpenter', 'constructeur metallique', 'constructrice metallique', 'metalcostruttore', 'metalcostruttrice', 'metallbauerin'] },
  { id: 'pittore', label: 'Pittore / imbianchino', feedFilter: 'imbianchin', aliases: ['pittore', 'imbianchino', 'maler', 'malerin', 'peintre', 'painter', 'aiuto pittrice', 'artista pittrice', 'carrosserielackierer', 'carrosserielackiererin', 'carrozziera verniciatrice', 'carrozziere verniciatore', 'glasmaler', 'glasmalerin', 'keramikmaler', 'keramikmalerin', 'kunstmaler', 'kunstmalerin', 'malerpraktiker', 'malerpraktikerin', 'pittrice', 'pittrice di scenari', 'pittrice su ceramica', 'pittrice su vetro', 'theatermaler', 'theatermalerin'] },
  { id: 'giardiniere', label: 'Giardiniere', feedFilter: 'giardin', aliases: ['giardiniere', 'giardiniera', 'gartner', 'gartnerin', 'jardinier', 'jardiniere', 'gardener', 'landschaftsgartner', 'horticulteur', 'horticultrice', 'paysagiste conductrice de travaux'] },
  { id: 'lattoniere', label: 'Lattoniere', feedFilter: 'lattonier', aliases: ['lattoniere', 'spengler', 'ferblantier', 'tinsmith', 'calorifugeur tolier', 'calorifugeuse toliere', 'carrosseriespengler', 'carrosseriespenglerin', 'carrossier tolier', 'carrossiere toliere', 'isolierspengler', 'isolierspenglerin', 'spenglerin'] },
  { id: 'piastrellista', label: 'Piastrellista', feedFilter: 'piastrell', aliases: ['piastrellista', 'plattenleger', 'carreleur', 'tiler', 'aide carreleuse', 'carreleuse', 'plattenlegerin', 'plattenlegerpraktiker', 'plattenlegerpraktikerin'] },
  { id: 'gessatore', label: 'Gessatore', feedFilter: 'gessator', aliases: ['gessatore', 'gipser', 'platrier', 'plasterer', 'aiuto gessatrice', 'gipserin trockenbauerin', 'gipserpraktiker', 'gipserpraktikerin'] },
  { id: 'montatore', label: 'Montatore', feedFilter: 'montator', aliases: ['montatore', 'monteur', 'monteurin', 'servicemonteur', 'fitter', 'addetta installatrice di sistemi di refrigerazione', 'addetto installatore di sistemi di refrigerazione', 'aide monteuse frigoriste', 'ajusteuse monteuse', 'bestucker elektrobranche', 'bestuckerin elektrobranche', 'equipeur branche electrique', 'equipeuse branche electrique', 'installatore di sistemi di refrigerazione', 'installatrice di sistemi di refrigerazione', 'kaltemontage praktiker', 'kaltemontage praktikerin', 'liftmonteur', 'liftmonteurin', 'maschinenmonteur', 'maschinenmonteurin', 'montatrice aggiustatrice', 'montatrice di ascensori', 'montatrice di avvolgibili', 'montatrice di impianti solari', 'montatrice di tubazioni', 'montatrice settore elettrico', 'monteuse de reseaux eau et gaz', 'monteuse frigoriste', 'monteuse solaire', 'monteuse video', 'rohrnetzmonteur', 'rohrnetzmonteurin', 'solarmonteur', 'solarmonteurin', 'storiste', 'videomontatore', 'videomontatrice', 'videomonteur', 'videomonteurin'] },

  // ── Logistica / trasporti ─────────────────────────────────────────────
  { id: 'magazziniere', label: 'Magazziniere', feedFilter: 'magazzin', aliases: ['magazziniere', 'magazzino', 'logistica', 'lagerist', 'lageristin', 'logistiker', 'logistikerin', 'magasinier', 'warehouse', 'agent de transport et logistique', 'agente de transport et logistique', 'allrounder logistik', 'disponent transport und logistik', 'disponentin transport und logistik', 'fachfrau internationale spedition und logistik', 'fachmann internationale spedition und logistik', 'logisticien', 'logisticienne', 'logistikfachfrau', 'logistikfachmann', 'manoeuvre logistique', 'specialiste de logistique', 'specialiste en expedition et logistique internationale'] },
  { id: 'corriere', label: 'Corriere / fattorino', feedFilter: 'corrier', aliases: ['corriere', 'fattorino', 'kurier', 'coursier', 'courier', 'driver delivery', 'facteur postal', 'factrice postale', 'kurierin', 'postbote', 'postbotin'] },
  { id: 'gruista', label: 'Gruista', feedFilter: 'gruista', aliases: ['gruista', 'kranfuhrer', 'grutier', 'crane operator', 'kranfuhrerin'] },

  // ── Vendita / food / cura persona ─────────────────────────────────────
  { id: 'venditore', label: 'Venditore', feedFilter: 'venditor', aliases: ['venditore', 'venditrice', 'commesso', 'commessa', 'verkaufer', 'verkauferin', 'detailhandelsfachfrau', 'detailhandelsfachmann', 'vendeur', 'vendeuse', 'sales assistant', 'gestionnaire du commerce de detail'] },
  { id: 'cassiere', label: 'Cassiere', feedFilter: 'cassier', aliases: ['cassiere', 'cassiera', 'kassier', 'kassiererin', 'caissier', 'caissiere', 'cashier', 'kassierin'] },
  { id: 'responsabile-negozio', label: 'Responsabile di negozio', feedFilter: 'responsabile del negozio', aliases: ['responsabile del negozio', 'responsabile negozio', 'store manager', 'filialleiter', 'filialleiterin', 'gerant de magasin', 'responsable de magasin'] },
  { id: 'macellaio', label: 'Macellaio', feedFilter: 'macella', aliases: ['macellaio', 'macellaia', 'specialista della carne', 'metzger', 'metzgerin', 'fleischfachmann', 'fleischfachfrau', 'boucher', 'bouchere', 'butcher'] },
  { id: 'panettiere', label: 'Panettiere', feedFilter: 'panettier', aliases: ['panettiere', 'panettiera', 'fornaio', 'backer', 'backerin', 'boulanger', 'boulangere', 'baker'] },
  { id: 'pasticcere', label: 'Pasticcere', feedFilter: 'pasticc', aliases: ['pasticcere', 'pasticceria', 'konditor', 'konditorin', 'patissier', 'patissiere', 'pastry chef', 'branchenspezialist backerei konditorei confiserie', 'branchenspezialistin backerei konditorei confiserie', 'pasticciera confettiera', 'pasticciere confettiere', 'specialiste des branches de la boulangerie patisserie confiserie'] },
  { id: 'parrucchiere', label: 'Parrucchiere', feedFilter: 'parrucchier', aliases: ['parrucchiere', 'parrucchiera', 'coiffeur', 'coiffeuse', 'hairdresser', 'friseur'] },
  { id: 'estetista', label: 'Estetista', feedFilter: 'estetist', aliases: ['estetista', 'kosmetikerin', 'kosmetiker', 'estheticienne', 'estheticien', 'beautician'] },
  { id: 'barista', label: 'Barista', feedFilter: 'barista', aliases: ['barista', 'barman', 'barmaid', 'barkeeper', 'bardame', 'dame de bar'] },
  { id: 'aiuto-cucina', label: 'Aiuto cucina', feedFilter: 'aiuto cucina', aliases: ['aiuto cucina', 'aiuto cuoco', 'kuchenhilfe', 'aide de cuisine', 'kitchen help'] },

  // ── Sicurezza / pulizie / facility ────────────────────────────────────
  { id: 'agente-sicurezza', label: 'Agente di sicurezza', feedFilter: 'sicurezza', aliases: ['agente di sicurezza', 'guardia', 'sicherheitsmitarbeiter', 'sicherheitsdienst', 'agent de securite', 'security officer', 'security guard', 'flughafensicherheitspolizist', 'flughafensicherheitspolizistin', 'garde frontiere', 'grenzwachter', 'grenzwachterin', 'nachtwachter', 'nachtwachterin', 'sicherheitsfachfrau', 'sicherheitsfachmann', 'veilleur de nuit', 'veilleuse de nuit'] },
  { id: 'custode', label: 'Custode / portinaio', feedFilter: 'custode', aliases: ['custode', 'portinaio', 'hauswart', 'hauswartin', 'concierge', 'janitor', 'facility', 'portier', 'portiere'] },
  { id: 'addetto-pulizie', label: 'Addetto alle pulizie', feedFilter: 'pulizie', aliases: ['addetto alle pulizie', 'addetta alle pulizie', 'pulizie', 'reinigungskraft', 'reinigungsmitarbeiter', 'agent de nettoyage', 'cleaner', 'raumpfleger', 'raumpflegerin', 'agent de proprete', 'agente de proprete', 'femme de chambre', 'garcon de chambre', 'gebaudereiniger', 'gebaudereinigerin', 'gebaudereinigungs fachfrau', 'gebaudereinigungs fachmann', 'reinigungsmitarbeiterin hotel', 'specialiste en nettoyage de batiments'] },

  // ── Professioni con landing dedicata (PROFESSION_IDS) ─────────────────
  // In taxonomy so their demand/supply lands in the "covered" report
  // section instead of polluting the unmapped-candidates list.
  { id: 'operaio', label: 'Operaio', feedFilter: 'operai', aliases: ['operaio', 'operaia', 'operaio di produzione', 'arbeiter', 'produktionsmitarbeiter', 'produktionsmitarbeiterin', 'ouvrier', 'ouvriere', 'production worker', 'bauarbeiter ausbaugewerbe', 'bauarbeiter bauhauptgewerbe', 'bauarbeiterin ausbaugewerbe', 'bauarbeiterin bauhauptgewerbe', 'betriebsarbeiter', 'betriebsarbeiterin', 'bohrarbeiter', 'bohrarbeiterin', 'kanalarbeiter', 'kanalarbeiterin', 'lavoratore edile edilizia principale', 'lavoratore edile lavori di completamento', 'sondeur', 'spurgatore di canalizzazioni', 'spurgatrice di canalizzazioni', 'tunnelarbeiter', 'tunnelarbeiterin'] },
  { id: 'impiegato', label: 'Impiegato di commercio', feedFilter: 'impiegat', aliases: ['impiegato', 'impiegata', 'impiegato di commercio', 'kaufmann', 'kauffrau', 'sachbearbeiter', 'sachbearbeiterin', 'employe de commerce', 'employee de commerce', 'office clerk'] },
  { id: 'ingegnere', label: 'Ingegnere', feedFilter: 'ingegner', aliases: ['ingegnere', 'ingegneria', 'ingenieur', 'ingenieurin', 'engineer', 'allrounder tiefbau', 'automobil und fahrzeugingenieur', 'automobil und fahrzeugingenieurin', 'automobilingenieur', 'automobilingenieurin', 'aviatikingenieur', 'aviatikingenieurin', 'bauingenieur', 'bauingenieurin', 'betriebs und produktionsingenieur', 'betriebs und produktionsingenieurin', 'chemieingenieur', 'chemieingenieurin', 'elektroingenieur', 'elektroingenieurin', 'elektronikingenieur', 'elektronikingenieurin', 'energie und umwelttechnikingenieur', 'energie und umwelttechnikingenieurin', 'forstingenieur', 'forstingenieurin', 'gebaudetechnikingenieur', 'gebaudetechnikingenieurin', 'geomatikingenieur', 'geomatikingenieurin', 'holzingenieur', 'holzingenieurin', 'informatikingenieur', 'informatikingenieurin', 'ingegnerea in scienze del vivente chimica natura alimentazione', 'kulturingenieur', 'kulturingenieurin', 'landschaftsarchitekt', 'landschaftsarchitektin', 'lebensmittelingenieur', 'lebensmittelingenieurin', 'lebenstechnologieningenieur chemie natur nahrung', 'lebenstechnologieningenieurin chemie natur nahrung', 'lebenswissenschafteningenieur chemie natur nahrung', 'lebenswissenschafteningenieurin chemie natur nahrung', 'manoeuvre genie civil', 'mechatronikingenieur', 'mechatronikingenieurin', 'medieningenieur', 'medieningenieurin', 'medizininformatiker', 'medizininformatikerin', 'medizintechnikingenieur', 'medizintechnikingenieurin', 'mikrotechnikingenieur', 'mikrotechnikingenieurin', 'nuklearingenieur', 'nuklearingenieurin', 'photonikingenieur', 'photonikingenieurin', 'prozessingenieur', 'prozessingenieurin', 'systemtechnikingenieur', 'systemtechnikingenieurin', 'telekommunikationsingenieur', 'telekommunikationsingenieurin', 'tiefbauingenieur', 'tiefbauingenieurin', 'transportingenieur', 'transportingenieurin', 'umweltingenieur', 'umweltingenieurin', 'verkaufsingenieur', 'verkaufsingenieurin', 'verkehrsingenieur', 'verkehrsingenieurin', 'werkstoffingenieur', 'werkstoffingenieurin', 'wirtschaftsingenieur', 'wirtschaftsingenieurin'] },
  { id: 'educatore', label: 'Educatore', feedFilter: 'educator', aliases: ['educatore', 'educatrice', 'educatore sociale', 'educatori dell infanzia', 'kleinkinderzieher', 'kleinkinderzieherin', 'educateur', 'educatrice de l enfance', 'educator', 'bewegungspadagoge', 'bewegungspadagogin', 'kindheitspadagoge', 'kindheitspadagogin', 'sexualpadagoge', 'sexualpadagogin'] },
  { id: 'autista', label: 'Autista', feedFilter: 'autista', aliases: ['autista', 'conducente', 'chauffeur', 'chauffeuse', 'fahrer', 'fahrerin', 'lastwagenfahrer', 'conducteur', 'driver'] },
  { id: 'muratore', label: 'Muratore', feedFilter: 'murator', aliases: ['muratore', 'maurer', 'macon', 'mason', 'bricklayer', 'aide maconne', 'aiuto muratrice', 'baupraktiker', 'baupraktikerin', 'maconne', 'maurerin', 'muratrice'] },
  { id: 'cuoco', label: 'Cuoco', feedFilter: 'cuoc', aliases: ['cuoco', 'cuoca', 'commis di cucina', 'koch', 'kochin', 'cuisinier', 'cuisiniere', 'cook', 'chef de partie', 'sous chef', 'souschef', 'alleinkoch', 'alleinkochin', 'commis de cuisine', 'diatkoch', 'diatkochin', 'hilfskoch', 'hilfskochin'] },
  { id: 'cameriere', label: 'Cameriere', feedFilter: 'camerier', aliases: ['cameriere', 'cameriera', 'kellner', 'kellnerin', 'serveur', 'serveuse', 'waiter', 'waitress', 'chef de rang'] },
  { id: 'elettricista', label: 'Elettricista', feedFilter: 'elettricist', aliases: ['elettricista', 'elektriker', 'elektrikerin', 'elektroinstallateur', 'elektromonteur', 'electricien', 'electricienne', 'electrician', 'costruttore elettrico', 'costruttrice elettrica', 'elektroinstallateurin', 'elektrokonstrukteur', 'elektrokonstrukteurin', 'netzelektriker', 'netzelektrikerin'] },
  { id: 'architetto', label: 'Architetto', feedFilter: 'architett', aliases: ['architetto', 'architetta', 'architekt', 'architektin', 'architecte', 'architect', 'innenarchitekt', 'innenarchitektin'] },
];

/**
 * Locality/topic tokens: demand signal for the LOCATION dimension, never a
 * profession. Search terms made only of these (plus stop words) are kept
 * out of the profession ranking and reported separately.
 */
export const LOCALITY_TOKENS = new Set([
  'ticino', 'tessin', 'lugano', 'mendrisio', 'chiasso', 'bellinzona',
  'locarno', 'stabio', 'mendrisiotto', 'luganese', 'balerna', 'novazzano',
  'agno', 'manno', 'paradiso', 'massagno', 'giubiasco', 'biasca', 'ascona',
  'minusio', 'losone', 'svizzera', 'schweiz', 'suisse', 'switzerland',
  'zurigo', 'zurich', 'zug', 'zugo', 'lucerna', 'luzern', 'basilea',
  'basel', 'berna', 'bern', 'ginevra', 'geneve', 'losanna', 'lausanne',
  'grigioni', 'graubunden', 'coira', 'chur', 'scuol', 'poschiavo',
  'sangallo', 'st gallen', 'como', 'varese', 'milano', 'italia',
]);

/** Words that carry no profession/locality signal in search terms. */
export const SEARCH_STOP_WORDS = new Set([
  'lavoro', 'lavori', 'lavorare', 'offerte', 'offerta', 'annunci',
  'annuncio', 'posti', 'posto', 'impiego', 'cerca', 'cerco', 'cercasi',
  'job', 'jobs', 'stelle', 'stellen', 'emploi', 'frontaliere',
  'frontalieri', 'frontalier', 'part', 'time', 'full', 'percento',
  'di', 'in', 'per', 'a', 'al', 'e', 'il', 'la', 'le', 'i', 'un', 'una',
  'del', 'della', 'delle', 'dei', 'degli', 'con', 'da', 'gli', 'lo',
  'nel', 'nella', 'presso', 'come', 'sono', 'und', 'der', 'die', 'das',
  'w', 'm', 'd', 'f', 'x', 'h',
]);

/**
 * Match a free-text string (search term or job title) against the taxonomy.
 * Returns the matched profession id or null. Longest alias wins.
 */
export function matchProfession(text) {
  const norm = normalizeText(text);
  if (!norm) return null;
  const tokens = norm.split(' ').filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  const stems = tokens.map(stemToken);
  let best = null;
  for (const entry of PROFESSION_TAXONOMY) {
    for (const alias of entry.aliases) {
      let matched = false;
      if (alias.includes(' ')) {
        const words = alias.split(' ');
        matched = words.every((w) => {
          const ws = stemToken(w);
          return stems.some((s) => s === ws);
        });
      } else {
        matched = tokens.some((t) => tokenMatchesAlias(t, alias));
      }
      if (matched && (!best || alias.length > best.aliasLength)) {
        best = { id: entry.id, aliasLength: alias.length };
      }
    }
  }
  return best ? best.id : null;
}

/**
 * Classify an on-site search term into the profession × locality grid.
 * `isPureLocality` = no profession matched AND every meaningful token is a
 * locality (e.g. "lugano", "mendrisio svizzera") → belongs to the location
 * dimension, not the profession ranking.
 */
export function classifySearchTerm(term) {
  const norm = normalizeText(term);
  const tokens = norm.split(' ').filter((t) => t.length >= 2 && !SEARCH_STOP_WORDS.has(t) && !/^\d+$/.test(t));
  const professionId = matchProfession(term);
  const localityTokens = tokens.filter((t) => LOCALITY_TOKENS.has(t));
  const isPureLocality = !professionId
    && tokens.length > 0
    && tokens.every((t) => LOCALITY_TOKENS.has(t));
  return { professionId, localityTokens, isPureLocality };
}

/** Lookup helper: taxonomy entry by id. */
export function taxonomyEntry(id) {
  return PROFESSION_TAXONOMY.find((e) => e.id === id) || null;
}
