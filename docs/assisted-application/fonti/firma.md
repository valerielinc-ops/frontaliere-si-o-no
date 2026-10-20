# Fonti: Firma sulla lettera inviata online

Pagine lette il 3 ottobre 2026. Ricerca e verifica sono di due agenti distinti: il secondo ha riaperto ogni
fonte e cercato di confutare ogni affermazione. Le citazioni sono nella lingua della fonte; il testo della
ricerca è in inglese, come è stato prodotto. Le **decisioni** prese su queste fonti sono in
[`../decisioni.md`](../decisioni.md): dove la raccomandazione del ricercatore e la decisione differiscono,
vale la decisione.

Domanda: Signature on a cover letter sent online in Switzerland (PDF by e-mail or portal upload): convention per language region, risk and data-protection status of a scanned handwritten signature, and what the assisted-application product should do (checked 2026-10-03)

## Esito della verifica

- Affermazioni: 66; verdetti: 66 confirmed.
- La raccomandazione regge: no, vedi le obiezioni.

### Obiezioni del verificatore

- What survives: typed first and last name as the default everywhere; a signature image only if the candidate uploads it; never generate one, never use a script font, never add 'gez.'/'signé'/'f.to'. All 66 quotes were found. The failures are in the regional defaults, in several proposed sentences, and in the fit with the product as it runs today.
- Notice point 1 and the consent text are not true for every candidate. They promise the image goes 'only in the cover letters you approve'. The Terms (6.1) and the flow code send the application unapproved after 12 hours (CANDIDATE_REVIEW_MS = 12 h; enterSubmitting(next, 'auto_approved_12h')). Either a letter with a signature image must never auto-approve (or the image is dropped on auto-approval), or this wording cannot ship.
- French hint: 'demandée par les guides officiels romands' is false as a general statement. The Neuchâtel cantonal guide (édition 2026) covers e-mail, online form and post, never tells the applicant to sign, and both model letters end with the typed name only. 'le canton de Genève' is a misattribution: the sheet's stated source is the Valais orientation office, and it says 'à la main ou scannée', not handwritten only. The German rendering 'verlangt' is stronger than the French 'demandée'.
- Italian hint and Italian default: 'richiesta dalle guide ufficiali della Svizzera italiana' is false as a general statement, and 'recommended, all profiles' is unsupported for adults. The Graubünden guide in Italian for adults (September 2025) covers online and e-mail applications with no signing step; the Ticino office's own 2025 sheet on the letter covers PDF sending with no signing step; the orientamento.ch adult page is silent. The sources behind 'recommended' are written for 14-15-year-old apprenticeship seekers plus one school worksheet. The researcher's gap 'no institutional source addresses the PDF case for adults' is wrong.
- The service is for adults only by its own privacy policy ('destinato a persone maggiorenni ... Non raccogliamo consapevolmente dati da minori di 18 anni'). The under-18 branch of the consent option (parent confirmation) contradicts that and should be removed, not designed. Apprenticeship guidance for pupils should not set the default for adult cross-border candidates.
- 'No source says a cover letter sent as PDF must be signed' oversteps. Universität Basel lists the signature under 'Zwingend ... enthalten'. Some employers require more than a signature: a Geneva public employer demands a 'lettre de motivation manuscrite' and a signed, scanned form sent by e-mail only, and the national guidance portal says a handwritten letter may be required. No proposed setting detects such adverts and hands them to the candidate.
- Retention does not fit the product. One order is one advert (Terms 6.1), so the standalone image is needed only until that one letter is rendered; '30 days after last use' has no purpose and has no trigger at all if the image is never used. The notice says 'we delete the image' while the sent PDF stays in the 90-day evidence store, in backups and with the recipient; the retention option says the notice must state this, but the drafted notice has no such sentence.
- The fallback 'until then the notice must not state a deletion date' is not available. The site applies the GDPR by its own policy, and Art. 13(2)(a) requires the retention period or its criteria at collection; Art. 7(3) requires telling the person before consent that it can be withdrawn. The upload must not launch before deletion works. The recommendation builds the notice on DSG Art. 19 only.
- Two legal summaries are overstated and should not be passed on. 'An inserted image is not a legal signature': true only for form-bound acts; Swiss contract law is form-free as a rule and other signature types can be used there, and doctrine mostly accepts signed-then-scanned PDFs even for written form. This raises the misuse risk, it does not lower it. 'Using someone's genuine signature on a document they did not approve is forgery': Art. 251 also needs an 'Urkunde' and intent to harm or to gain an unlawful advantage.
- Notice point 2 is not true for every application: recipients are also staffing agencies that pass the dossier on, and portal operators; some letters go into a portal text field, not as PDF. The data protection commissioner says employers may keep the cover letter itself after a rejection, which is the document that would carry the image; the notice should say so. The consent names 'frontaliereticino.ch', a domain; the controller in the privacy policy is a named person.
- Notice point 3 pairs two true facts to imply a path no source documents. The bank sentence rests on a 2010 case, is put in the present tense, omits the Ombudsman's own qualifier, and concerns Swiss banks, which many candidates living in Italy do not use. If a bank sentence is kept, the 2021/07 case is the pertinent one (copied signatures on e-mailed orders, USD 80,000, settled at 50%). The notice should also say plainly that no documented case of misuse from an application was found.
- Guardrails miss three leak paths that exist in this product. (a) Session replay: PostHog replay is on and Microsoft Clarity records sessions; an upload control or letter preview showing the signature is captured unless masked ('ph-no-capture', 'data-clarity-mask'). 'Analytics' in the never-list does not name this. (b) The letter is drafted by an OpenAI model in GitHub Actions; 'never send it to an LLM' needs the image kept out of that workspace and inserted in a separate deterministic step, and both processors may process data outside Switzerland and the EU. (c) The candidate can have the original CV sent; a signature already in it leaves anyway, so 'CV never signed' and 'never in the CV' cannot be promised for that file.
- 'It is the only way to follow the stated convention' is false. The candidate can sign the final PDF themselves (print-sign-scan, as the Ticino school sheet and the Austrian and German agencies describe), or the image can be inserted in the browser per letter without server storage. DSG Art. 7 para. 3 requires defaults that keep processing to the minimum; a 'recommended' prompt pushes the other way on thin evidence.
- Italian layout: the option and the notice place the image above the typed name ('sopra il tuo nome'). The orientamento.ch template and PDF model (C21) place 'Firma a mano' below 'Nome Cognome'; only the SECO sample of 2007 shows it above. The position for Italian letters is not settled by the sources.
- The hints put third-party names and dated claims into product copy with no way to keep them true (the ETH citation is already one edition behind). The German hint adds 'in der Deutschschweiz' to a statement jobs.ch did not scope that way. jobs.ch and jobup.ch are one publisher with a commercial AI letter generator promoted in the same paragraph; they carry the whole 'not needed online' side in two regions.
- 'CV: never dated' is contradicted for apprenticeships by the Graubünden checklist the researcher cites as C10 ('Habe ich das aktuelle Datum angegeben?'). It holds for adults (BIZ Bern, Vaud).
- Plain-text closing: the contact block is sourced for e-mails only, not for portal fields or chat. 'All contact lines were given by the candidate' does not match the product, which gives employers a dedicated alias address. Official sources also disagree on whether the letter may be the e-mail text at all (C25 and BIZ Bern p. 19 say no).
- Two settings are under-specified. 'Language region of the employer' is undefined for bilingual cantons, English adverts and agencies; the language of the letter is the workable key. The 150 dpi cap has no source and gives little protection: in case 2021/07 pasted signatures passed a bank's check.
- Limit of this verification: the session's web-search budget ran out part-way. Counter-evidence after that point came from direct fetches of known addresses only. Not checked: Fribourg, Valais, Jura, Zürich, Luzern, St. Gallen guides; UNIL, UNIGE, EPFL, USI career services; police or crime-prevention guidance on signatures; home-country habits in Italy and France, which the researcher also left out although they are the product's main audience.

### Prove contrarie o mancanti nella ricerca

- **claim**: A Swiss university career service calls the signature a mandatory element of the letter, against 'No source says ... must be signed'.
  **source**: https://www.unibas.ch/de/Studium/Beratung-und-Support/Berufseinstieg-Laufbahn/Beratung/Bewerbungstipps.html
  **quote**: Zwingend in einem Motivationsschreiben enthalten sind: [...] Grussformel («Mit freundlichen Grüssen»; «Freundliche Grüsse») Unterschrift evtl. Angabe der Beilagen
- **claim**: An official Romandie guide of 2026 does not ask for a signature: no signing step for e-mail, online form or post, and both model letters (pp. 4 and 11, images) end with the typed name only. Contradicts 'demandée par les guides officiels romands'.
  **source**: https://www.ne.ch/sites/default/files/2026-08/OCOSP_rediger_candidature_apprentissage.pdf
  **quote**: QUE METTRE DANS MA LETTRE? Je note l'adresse de l'entreprise. [...] Je me rends disponible pour un entretien et j'adresse mes salutations.
- **claim**: An Italian-language cantonal guide for adults (OPSC Grigioni, settembre 2025) covers online and e-mail applications and has no instruction to sign the letter; 'firma' means the e-mail contact block. Contradicts the gap 'no institutional source addresses the PDF case for adults' and the hint 'richiesta dalle guide ufficiali della Svizzera italiana'.
  **source**: https://www.gr.ch/DE/institutionen/verwaltung/ekud/afb/Dokumente%20AfB/250918-bslb-Il%20dossier%20di%20candidatura.pdf
  **quote**: Il processo di candidatura si svolge sempre più spesso online. [...] Firma nell'e-mail con tutti i dati di contatto (nome, cognome, indirizzo, numero di telefono, indirizzo e-mail)
- **claim**: The Ticino guidance office's newer sheet on the letter (PDF created 2025-08-19) covers PDF saving and sending without a signing step, so the office is not consistent with its 2024 guide (C22).
  **source**: https://www4.ti.ch/fileadmin/DECS/DS/UOSP/download/Tirocinio/Candidatura_istruzioni_per_l_uso_-_lettera_di_motivazione.pdf
  **quote**: Salva la lettera di formato PDF prima di inviarla. Nomina correttamente il file: Lettera_NomeCognome.pdf.
- **claim**: Evidence the other way, also missed: the Ticino office says the general rules hold for online and e-mail applications, which supports reading 'ricordati di firmarla' as applying to PDFs for apprenticeships.
  **source**: https://m4.ti.ch/fileadmin/DECS/DS/UOSP/agenda/Invio_della_candidatura_e_seguito.pdf
  **quote**: Le regole generali per la candidatura valgono anche per la candidatura online o per e-mail.
- **claim**: The Vaud apprenticeship brochure does address online sending and keeps the hand signature; it also confirms the CV rule. Contradicts the researcher's gap note on Vaud.
  **source**: https://www.vd.ch/fileadmin/user_upload/themes/formation/orientation/fichiers_pdf/publications/rechappr.pdf
  **quote**: Elle est datée et signée. [...] SIGNATURE (à la main) [...] Envoie-les avec ta lettre de motivation et ton CV en .pdf avec un petit mot d'accompagnement. [...] Le CV n'est ni daté ni signé.
- **claim**: The national guidance portal's adult pages are silent on signing, say applications are mostly digital, and warn that a handwritten letter may be required. The researcher covered only the apprenticeship pages.
  **source**: https://www.berufsberatung.ch/de/jobs-und-weiterbildung/eine-stelle-suchen
  **quote**: Je nach Branche und Unternehmen können auch andere Formate und Inhalte einer Bewerbung üblich oder gewünscht sein, sei es ein Bewerbungsvideo, eine Arbeitsprobe oder ein handschriftliches Bewerbungsschreiben. Bewerbungen werden heute in den meisten Fällen digital eingereicht.
- **claim**: Same on the Italian adult page.
  **source**: https://www.orientamento.ch/it/lavoro-e-formazione-continua/cercare-un-impiego
  **quote**: È possibile che si richieda una candidatura video, un test di valutazione o una lettera di candidatura scritta a mano. Oggigiorno, le candidature vengono solitamente presentate in formato digitale, tramite e-mail o il portale d'impiego dell'azienda.
- **claim**: A Swiss public employer requires a handwritten letter and a signed, scanned form by e-mail only. A typed letter with an inserted image cannot meet this; the settings have no rule for such adverts.
  **source**: https://www.ge.ch/document/21200/annexe/1
  **quote**: Liste des annexes obligatoires à envoyer avec le formulaire de candidature daté, signé et numérisés en un seul fichier [...] Ceux-ci sont à fournir par courriel uniquement. [...] 1. Lettre de motivation manuscrite
- **claim**: The data protection commissioner does address application documents: after a rejection the employer may keep the cover letter, the document that would carry the signature image. Relevant to what the candidate must be told; the researcher reported no commissioner statement.
  **source**: https://www.edoeb.admin.ch/de/verschiedene-phasen-des-arbeitsverhaeltnisses
  **quote**: Arbeitgeber dürfen nur jene Unterlagen aufbewahren, die ihnen gehören, das heisst Bewerbungsschreiben, Personalfragebögen und Informationen, die aufgrund von Referenzanfragen eingeholt wurden und anschliessend vernichtet werden.
- **claim**: A more recent and more pertinent Ombudsman case than the 2010 and 2013 ones: forged payment orders sent by e-mail with copied signatures, USD 80,000, settled at 50%; the bank relied on a clause shifting undetected forgeries to the customer.
  **source**: https://bankingombudsman.ch/gefaelschte-zahlungsauftraege-per-e-mail/
  **quote**: Auf den gefälschten Aufträgen seien diese Unterschriften anders angeordnet worden und im Hintergrund seien Punkte ersichtlich gewesen. [...] Die Differenzen bei den Unterschriften seien marginal und lediglich bei einer Ex-post-Betrachtung erkennbar.
- **claim**: Swiss contract law is form-free as a rule, so signatures other than the qualified electronic one can be used in most transactions. 'An inserted image is not a legal signature' holds only for form-bound acts.
  **source**: https://www.bakom.admin.ch/de/23-welche-rechtskraft-haben-elektronische-signaturen
  **quote**: Allerdings benötigen wenige Transaktionen in der Schweiz eine qualifizierte elektronische Signatur, die gleichwertig wie eine handschriftliche Unterschrift ist (z. B. Konsumkredit), da das schweizerische Vertragsrecht auf dem Prinzip der Formfreiheit beruht. Andere elektronische Signaturarten können daher verwendet werden, wenn keine eigenhändige Unterschrift der Vertragsparteien erforderlich ist
- **claim**: Federal Council report of 15 September 2023 (p. 12/40, section 2.4.3): doctrine mostly accepts signed-then-scanned PDFs sent by e-mail even for the written form, while the authenticity of a scanned signature cannot be checked reliably.
  **source**: https://www.newsd.admin.ch/newsd/message/attachments/82554.pdf
  **quote**: Fraglich ist, ob original-unterzeichnete und alsdann eingescannte und als Bild- bzw. PDF-Dokumente per gewöhnlicher E-Mail ausgetauschte Dokumente dem Schriftformerfordernis genügen. Dies scheint in der Lehre in Analogie zum Telefax und unter Hinweis auf das enorme praktische Bedürfnis überwiegend bejaht zu werden. Zu bedenken ist aber, dass die Echtheit einer eingescannten Unterschrift wie bei einer Fotokopie auch bei guter Bildqualität und -auflösung nicht mehr mit derselben Zuverlässigkeit überprüft werden kann wie beim Original
- **claim**: Privacy by default, not cited by the researcher: defaults must keep processing to the minimum. Supports the typed-name default and argues against a 'recommended' upload prompt. Current consolidation is 7 July 2025, not 1 September 2023.
  **source**: https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/2022/491/20250707/de/html/fedlex-data-admin-ch-eli-cc-2022-491-20250707-de-html.html
  **quote**: Der Verantwortliche ist verpflichtet, mittels geeigneter Voreinstellungen sicherzustellen, dass die Bearbeitung der Personendaten auf das für den Verwendungszweck nötige Mindestmass beschränkt ist, soweit die betroffene Person nicht etwas anderes bestimmt.
- **claim**: GDPR Art. 13(2)(a) and Art. 7(3), in the text the researcher already used: the retention period must be given at collection, and the right to withdraw consent must be stated before consent. The option 'the notice must not state a deletion date' until the job exists is therefore not permissible.
  **source**: https://www.garanteprivacy.it/documents/10160/0/Regolamento+UE+2016+679.+Arricchito+con+riferimenti+ai+Considerando+Aggiornato+alle+rettifiche+pubblicate+sulla+Gazzetta+Ufficiale++dell%27Unione+europea+127+del+23+maggio+2018
  **quote**: a) il periodo di conservazione dei dati personali oppure, se non è possibile, i criteri utilizzati per determinare tale periodo; [...] L'interessato ha il diritto di revocare il proprio consenso in qualsiasi momento. [...] Prima di prestare il proprio consenso, l'interessato è informato di ciò.
- **claim**: The Graubünden apprenticeship checklist cited as C10 asks for the date on the CV, against 'CV: never dated'.
  **source**: https://www.gr.ch/DE/institutionen/verwaltung/ekud/afb/Dokumente%20AfB/260415-bslb-Tipps%20zur%20Lehrstellenbewerbung.pdf
  **quote**: Lebenslauf [...] Habe ich das aktuelle Datum angegeben?
- **claim**: The ETH guide has a 2025 edition (printed p. 114) with the same sentence; the claim and the hint's condition cite the 2024 edition.
  **source**: https://ethz.ch/content/dam/ethz/associates/students/karriere/berufskarriere/files/Bewerbungsratgeber%202025%20DE%20v1.pdf
  **quote**: Bei elektronischen Bewerbungen kann die handschriftliche Unterschrift mittels Scan eingefügt oder ganz weggelassen werden.
- **claim**: Product, terms of service 6.1 (repository state 73adfb5c2db3, read-only): an application leaves without approval after 12 hours, and one order is one advert. Makes 'only in the cover letters you approve' untrue and the 30-day retention pointless.
  **source**: components/pages/TermsOfService.tsx
  **quote**: Con un pagamento unico prepariamo e inviamo a tuo nome la candidatura per un solo annuncio. [...] Se non rispondi entro 12 ore dall'email di revisione, la candidatura parte così com'è, come indicato nell'email.
- **claim**: Product, flow code: the 12-hour automatic approval is implemented.
  **source**: functions/src/assistedApplicationFlow.js
  **quote**: export const CANDIDATE_REVIEW_MS = 12 * 60 * 60 * 1000; [...] effects = enterSubmitting(next, 'auto_approved_12h');
- **claim**: Product, privacy policy: adults only; GDPR declared applicable; controller is a named person; sent evidence kept 90 days; drafting by an OpenAI model in GitHub Actions, possibly outside the EU and Switzerland; the original CV can be sent.
  **source**: components/pages/PrivacyPolicy.tsx
  **quote**: Il nostro servizio è destinato a persone maggiorenni [...] Non raccogliamo consapevolmente dati da minori di 18 anni [...] le prove di ciò che è stato inviato sono conservate cifrate e cancellate con il CV (90 giorni) [...] OpenAI e GitHub possono trattare i dati anche fuori dall'UE/Svizzera.
- **claim**: Product, session replay: PostHog replay is enabled (5% sample) and Clarity is loaded; rendered content is recorded unless masked. A signature preview would be captured.
  **source**: services/posthog.ts
  **quote**: session_recording: { sampleRate: POSTHOG_SESSION_REPLAY_SAMPLE_RATE },
- **claim**: The Bern template that carries the signature reminder explicitly covers mail and online applications, so BIZ Bern is not clearly a 'sign only on paper' source.
  **source**: https://www.biz.bkd.be.ch/content/dam/biz_bkd/dokumente/de/angebote/informationsangebote/biz-publikationen/infoblaetter-und-broschueren/stellensuche-berufseinstieg-praktikum/m051-bewerbungsdossier-erwachsene.pdf
  **quote**: ((Unterschrift nicht vergessen)) [...] In einer Mail- oder Online-Bewerbung können Sie die Firmenadresse auch weglassen.

## Affermazioni e fonti

### C1 (T1) — verifica: confirmed

SDBB apprenticeship guidance (German): the closing element of the letter is greeting, 'digital signature', first and last name. No explanation of what 'digital' means and no statement that it is mandatory.

- Fonte: SDBB / berufsberatung.ch — <https://www.berufsberatung.ch/de/bewerbungsbrief-schreiben>
- Citazione: «Freundliche Grüsse, digitale Unterschrift, dein Vor- und Nachname.»
- Nota del verificatore: Sentence found under the heading 'Verabschiedung' (page opened 2026-10-03; the site needs a cookie jar, otherwise it returns a cookie-check page). No explanation of 'digital', no word such as 'muss'.

### C2 (T1) — verifica: confirmed

All three German SDBB example letters (2026, SDBB Bern and Stadt Zürich Laufbahnzentrum; all three viewed) show the name twice after the greeting: first in a handwriting-style typeface as a signature line, then typed. The fill-in DOCX on the same page (media.sdbb.ch/asset/fec44651-2e46-42e7-b639-0c3dadb0941e/Bewerbungsbrief-zum-Ausfullen.docx) ends with the typed name only and contains no image. Quote is the PDF text layer of example 1.

- Fonte: SDBB / Stadt Zürich Laufbahnzentrum — <https://media.sdbb.ch/asset/e261c0b7-1845-4cf3-81f0-7b0251e05f38/Vorlage-Bewerbungsbrief-1-Aurora.pdf>
- Citazione: «Freundliche Grüsse Aurora Muster Aurora Muster Beilagen: Lebenslauf, Zeugnisse, Schnupperbericht, Bestätigung Ferienjob»
- Nota del verificatore: All three PDFs opened (Aurora, Elias, Victoria): the first name line is set in BradleyHandITCTT-Bold 15-17 pt between 'Freundliche Grüsse' and the typed name in Aptos; footer '2026 SDBB Bern, und Stadt Zürich Laufbahnzentrum'. DOCX has no media and no drawing. Caveat: the DOCX keeps two empty paragraphs between greeting and name, the usual gap for a signature, so it is not evidence that a typed name alone is intended (the recommendation uses it that way).

### C3 (T1) — verifica: confirmed

SDBB: apprenticeship applications are sent by online form or e-mail as PDF; post is very rare. The French and Italian versions of the page say the same ('très rare', 'È raro oggigiorno'). The letter guidance in C1, C13, C20 therefore concerns online sending.

- Fonte: SDBB / berufsberatung.ch — <https://www.berufsberatung.ch/de/bewerbung-erstellen-und-verschicken>
- Citazione: «Sehr selten verlangt ein Lehrbetrieb die Bewerbungsunterlagen per Post.»
- Nota del verificatore: DE, FR and IT sentences found in the page payload (accordion text sits in the Next.js data, not in the visible HTML). FR page is /fr/creer-et-envoyer-un-dossier-de-candidature: 'Il est aujourd'hui très rare qu'une entreprise exige de recevoir le dossier de candidature par la poste.'

### C4 (T1) — verifica: confirmed

BIZ Kanton Bern (adults, M051-08.2025, p. 13): the letter template places a reminder to sign between 'Freundliche Grüsse' and the typed 'Vorname Name'. The template is channel-neutral.

- Fonte: BIZ Kanton Bern — <https://www.biz.bkd.be.ch/content/dam/biz_bkd/dokumente/de/angebote/informationsangebote/biz-publikationen/infoblaetter-und-broschueren/stellensuche-berufseinstieg-praktikum/m051-bewerbungsdossier-erwachsene.pdf>
- Citazione: «((Unterschrift nicht vergessen))»
- Nota del verificatore: p. 13. 'Channel-neutral' is too weak: the side note on the same template says 'In einer Mail- oder Online-Bewerbung können Sie die Firmenadresse auch weglassen', so the template that carries the signature reminder explicitly covers online use.

### C5 (T1) — verifica: confirmed

BIZ Kanton Bern (p. 19-20): the step 'sign the letter' appears only in the checklist for post or personal delivery. The checklists for the electronic application (create PDFs, send by e-mail, upload by online form) contain no signing step.

- Fonte: BIZ Kanton Bern — <https://www.biz.bkd.be.ch/content/dam/biz_bkd/dokumente/de/angebote/informationsangebote/biz-publikationen/infoblaetter-und-broschueren/stellensuche-berufseinstieg-praktikum/m051-bewerbungsdossier-erwachsene.pdf>
- Citazione: «Versenden per Post oder persönliche Übergabe − Ausdruck auf hochwertigem Papier (nicht falten!) − Nochmals auf Fehlerfreiheit und Vollständigkeit prüfen (lassen) − Brief unterschreiben»
- Nota del verificatore: pp. 19-20 read in full. 'Brief unterschreiben' appears only under 'Versenden per Post oder persönliche Übergabe'.

### C6 (T1) — verifica: confirmed

BIZ Kanton Bern: in Switzerland the CV is neither dated nor signed (p. 8); signing or dating the CV is named as a German habit that stands out (p. 6).

- Fonte: BIZ Kanton Bern — <https://www.biz.bkd.be.ch/content/dam/biz_bkd/dokumente/de/angebote/informationsangebote/biz-publikationen/infoblaetter-und-broschueren/stellensuche-berufseinstieg-praktikum/m051-bewerbungsdossier-erwachsene.pdf>
- Citazione: «In der Schweiz wird der Lebenslauf weder datiert noch unterschrieben.»
- Nota del verificatore: p. 8 and p. 6 ('den Lebenslauf datieren/unterschreiben' as a German habit).

### C7 (T1) — verifica: confirmed

ETH Career Center, Bewerbungsratgeber 2024 (p. 158): for electronic applications the handwritten signature is optional; it can be inserted as a scan or left out entirely. Only institutional source found that says this explicitly.

- Fonte: ETH Zürich Career Center — <https://ethz.ch/content/dam/ethz/main/industry/career-center/Bewerbungsratgeber/2024_BRG_DE.pdf>
- Citazione: «Bei elektronischen Bewerbungen kann die handschriftliche Unterschrift mittels Scan eingefügt oder ganz weggelassen werden.»
- Nota del verificatore: 2024 edition, printed p. 158 (PDF page 81). A newer edition exists and is the one linked from the ETH Career Center page: 'Bewerbungsratgeber 2025 DE v1.pdf' (created 2025-04-07), printed p. 114, same sentence word for word. Cite the 2025 edition.

### C8 (T1) — verifica: confirmed

Universität Basel (student advice, application tips): the signature is listed among the elements of the motivation letter, between greeting and enclosures; no distinction for online sending.

- Fonte: Universität Basel — <https://www.unibas.ch/de/Studium/Beratung-und-Support/Berufseinstieg-Laufbahn/Beratung/Bewerbungstipps.html>
- Citazione: «Grussformel («Mit freundlichen Grüssen»; «Freundliche Grüsse») Unterschrift evtl. Angabe der Beilagen»
- Nota del verificatore: UNDERSTATED. The quote is there, but the list is introduced by 'Zwingend in einem Motivationsschreiben enthalten sind:'. Basel calls the signature a mandatory element, not merely a listed one. This contradicts the recommendation's sentence 'No source says a cover letter ... must be signed'.

### C9 (T1) — verifica: confirmed

UZH Career Services sample letter (document dated 2008, still online): signature by hand under the greeting. Old source, low weight.

- Fonte: Career Services der Universität Zürich — <https://www.careerservices.uzh.ch/dam/jcr:00000000-3503-fe29-ffff-ffffed2e636e/Musteranschreiben.pdf>
- Citazione: «Mit freundlichen Grüssen (Unterschrift von Hand)»
- Nota del verificatore: Sample dated 'Zürich, 8. September 2008'; PDF created 2008-09-11.

### C10 (T1) — verifica: confirmed

Kanton Graubünden BIZ (apprenticeships, file dated 15.04.2026): the dossier checklist asks whether the letter is signed, in a leaflet that also says companies often require online applications.

- Fonte: Kanton Graubünden, Berufs-, Studien- und Laufbahnberatung — <https://www.gr.ch/DE/institutionen/verwaltung/ekud/afb/Dokumente%20AfB/260415-bslb-Tipps%20zur%20Lehrstellenbewerbung.pdf>
- Citazione: «Habe ich den Brief unterschrieben?»
- Nota del verificatore: Question is in the general 'Bewerbungsbrief' checklist, not in the separate 'Physisches Bewerbungsdossier' list. PDF metadata: created 2026-08-20 (file name prefix 260415). The same checklist asks for the current date on the CV ('Habe ich das aktuelle Datum angegeben?').

### C11 (T1) — verifica: confirmed

Kanton Thurgau (apprenticeships, edition 2023): the signature is element 10 of the letter (slashes mark line breaks).

- Fonte: Kanton Thurgau, Amt für Berufsbildung und Berufsberatung — <https://abb.tg.ch/public/upload/assets/81863/2024_lehrstellenbewerbung.pdf?fp=5>
- Citazione: «9 Grussformel / 10 Unterschrift / 11 Beilagen (nur Kopien, keine Originale)»
- Nota del verificatore: Imprint '0203/2023/ABB'. The example letter shows a handwritten image 'S. Muster' above the typed name; the same guide says most companies want e-mail or portal applications as PDF.

### C12 (T1) — verifica: confirmed

SECO brochure 'Wie bewerbe ich mich richtig?' (40 pages, form. 711.253d 03.19): the motivation letter may be the e-mail text itself or a PDF attachment. The extractable text contains no instruction to sign the letter; the only occurrence of 'Unterschrift' concerns the handwriting sample supplied on request; 'Signatur' in the e-mail means the footer with address, phone and e-mail.

- Fonte: SECO / arbeit.swiss — <https://www.arbeit.swiss/api/media/fileservice/sdweb-docs-prod-arbeitswiss-files/files/2026/06/03/06ed7935-ac82-4aa8-a2a6-29ae54ce9f2f.pdf>
- Citazione: «Sie können Ihr Motivationsschreiben entweder direkt als E-Mail-Text oder als PDF-Datei im Anhang senden.»
- Nota del verificatore: p. 14; imprint 'form. 711.253d 03.19'. 'Unterschrift' occurs once (handwriting sample, p. 7); 'Signatur' is the e-mail footer.

### C13 (T1) — verifica: confirmed

SDBB/CSFO apprenticeship guidance (French): the letter carries a handwritten signature; for an application sent entirely online the signature may be digitised by scanning and added before saving as PDF.

- Fonte: CSFO / orientation.ch — <https://www.orientation.ch/fr/ecrire-une-lettre-de-motivation>
- Citazione: «Signature manuscrite. Tu peux numériser ta signature, par exemple en la scannant, et l'ajouter à la lettre avant de l'enregistrer en PDF, si tu envoies ta candidature entièrement en ligne.»
- Nota del verificatore: Order on the page: 'Meilleures salutations' / 'Signature manuscrite...' / 'Ton prénom et ton nom de famille'.

### C14 (T1) — verifica: confirmed

CSFO French fill-in template: the letter ends with 'Prénom Nom' followed by the placeholder 'Signature manuscrite' (slash marks the line break). The three French example PDFs (© 2021, all viewed) show a handwriting-style signature above the typed name, right-aligned.

- Fonte: CSFO / Laufbahnzentrum Zürich — <https://media.sdbb.ch/asset/0090f850-1d2a-4eeb-ab79-10ddf1e53fd1/Exemple-de-lettre-a-completer.docx>
- Citazione: «Prénom Nom / Signature manuscrite»
- Nota del verificatore: DOCX: 'Prénom Nom' then 'Signature manuscrite', both with a left indent of 4248 twips (right-hand block, not right-aligned). The three PDFs (letters dated March 2026, footer '© 2021') show the name in BradleyHandITCTT-Bold above the typed name.

### C15 (T1) — verifica: confirmed

Canton de Vaud, OCOSP, guide for adults (February 2023): date the letter and sign it by hand. The guide does not address sending as PDF.

- Fonte: Canton de Vaud, OCOSP — <https://www.vd.ch/fileadmin/user_upload/themes/formation/orientation/fichiers_pdf/publications/guide_postulation_adultes_WEB.pdf>
- Citazione: «Datez votre lettre et signez-la à la main»
- Nota del verificatore: 'Février 2023'. No mention of online sending in this leaflet.

### C16 (T1) — verifica: confirmed

Canton de Vaud, OCOSP leaflet 'Postuler pour un emploi en trois étapes, 2. La lettre de motivation' (June 2019): sign the letter by hand.

- Fonte: Canton de Vaud, OCOSP — <https://vd.ch/fileadmin/user_upload/themes/formation/orientation/fichiers_pdf/publications/postuler_adultes_2lettre_web.pdf>
- Citazione: «Signez votre lettre à la main.»
- Nota del verificatore: 'Juin 2019'.

### C17 (T1) — verifica: confirmed

Canton de Vaud, OCOSP apprenticeship structure sheet: signature by hand above first and last name, at the 9 cm tab.

- Fonte: Canton de Vaud, OCOSP — <https://www.vd.ch/fileadmin/user_upload/themes/formation/orientation/fichiers_pdf/apprentissage/Recherche_place_apprentissage_p11.pdf>
- Citazione: «SIGNATURE (à la main) (prénom + nom)»
- Nota del verificatore: The sheet is p. 11 of the brochure 'Recherche d'une place d'apprentissage' (Avril 2024, réimpression 2026). That brochure also says 'Elle est datée et signée' and describes sending the letter as .pdf by e-mail and on recruitment sites, so the researcher's gap note that the Vaud guides do not mention online sending is wrong for this guide.

### C18 (T1) — verifica: confirmed

Canton de Genève, DIP (secondary II, apprenticeship letter sheet): the signature may be handwritten or scanned.

- Fonte: République et canton de Genève, DIP — <https://edu.ge.ch/secondaire2/system/files/2021-08/La%20lettre%20de%20motivation%20-%20ce%20qu'il%20faut%20retenir.pdf>
- Citazione: «Signature à la main ou scannée.»
- Nota del verificatore: Quote found, but the attribution is weak: the sheet ends with 'Source : Office d'orientation du Valais romand' and its example is from Sion/Sierre. It is a Valais sheet hosted on the Geneva school platform (PDF created 2021-08-03), not Geneva's own guidance. It does not tie the scanned signature to online applications.

### C19 (T1) — verifica: confirmed

SECO brochure in French 'Qu'est-ce qu'une bonne candidature ?' (form. 711.253 f 02.2018): the letter may be in the body of the e-mail or attached as PDF; 'Signature' in the e-mail section means the footer with contact details. No instruction to sign the letter found in the extractable text.

- Fonte: SECO / travail.swiss — <https://www.arbeit.swiss/api/media/fileservice/sdweb-docs-prod-arbeitswiss-files/files/2026/07/09/5f476989-18b8-4a22-ab63-a7bddb9f0473.pdf>
- Citazione: «Vous pouvez envoyer votre lettre de motivation soit directement dans le corps du message électronique, soit en pièce jointe au format PDF.»
- Nota del verificatore: p. 14; imprint 'form. 711.253.f 02.2018'.

### C20 (T1) — verifica: confirmed

CSFO apprenticeship guidance (Italian): the closing formula is greeting, 'electronic signature', first and last name.

- Fonte: CSFO / orientamento.ch — <https://www.orientamento.ch/it/scrivere-la-lettera-di-motivazione>
- Citazione: «Cordiali saluti, firma elettronica, nome e cognome»
- Nota del verificatore: Under 'Formula di chiusura'.

### C21 (T1) — verifica: confirmed

CSFO Italian fill-in template (and the PDF model linked on the same page): the letter ends with 'Nome Cognome' followed by the placeholder 'Firma a mano', right-aligned. The same publisher therefore says 'firma elettronica' on the page and 'Firma a mano' in the template.

- Fonte: CSFO / orientamento.ch — <https://media.sdbb.ch/asset/1a53d46e-bfe2-4080-8597-508148ef3900/Lettera-di-motivazione-da-completare.docx>
- Citazione: «Nome Cognome / Firma a mano»
- Nota del verificatore: DOCX and PDF model both show 'Nome Cognome' and, below it, 'Firma a mano' (left-indented right-hand block). Note the order: the signature is below the typed name, which the proposed Italian layout reverses.

### C22 (T1) — verifica: confirmed

Cantone Ticino, UOSP, 'Candidarsi per un posto di tirocinio': the letter must be signed. The same document says many companies prefer e-mail with PDF attachments but does not say how to sign a PDF.

- Fonte: Repubblica e Cantone Ticino, UOSP (DECS) — <https://www4.ti.ch/fileadmin/DECS/DS/UOSP/download/Candidarsi_per_un_posto_di_tirocinio.pdf>
- Citazione: «È importante che la lettera sia impaginata correttamente e che non contenga errori di ortografia. Alla fine ricordati di firmarla!»
- Nota del verificatore: p. 2; PDF created 2024-10-09. The same office's newer sheet 'Istruzioni per l'uso - Lettera di motivazione' (PDF created 2025-08-19) covers saving and sending as PDF and has no signing step.

### C23 (T1) — verifica: confirmed

Letter template of a Ticino cantonal middle school (Scuola media di Ambrì, 2020): handwritten signature; for e-mail, print, sign, scan and send as PDF. Single school, low weight, but the only Ticino source found that addresses the PDF case.

- Fonte: Scuola media di Ambrì (Cantone Ticino) — <https://ambri.sm.edu.ti.ch/wp-content/uploads/sites/14/2020/09/2.1-Lettera-pdf-nuvole.pdf>
- Citazione: «Metti anche la tua firma autografa. Se mandi per posta: stampa il documento, firmalo ed invialo. Se mandi per posta elettronica: stampa il documento, firmalo, fai una scansione, invialo come allegato PDF.»
- Nota del verificatore: Quote found. Tier is generous: this is one school's worksheet, not an institutional guideline, yet it is quoted in the proposed Italian UI hint.

### C24 (T1) — verifica: confirmed

SECO/URC leaflet in Italian 'Lettera d'accompagnamento' (Art. Nr. 716.206.i 08.2018), hosted by the Ticino Sezione del lavoro: the list 'Struttura della lettera' has nine items and none is a signature, while the printed sample letter (viewed) shows a handwritten-style signature 'Mario Bianchi' above the typed name.

- Fonte: SECO / URC (hosted by Cantone Ticino) — <https://www4.ti.ch/fileadmin/DFE/DE-SDL/b_persone/flyer/opuscolo_SECO_lettera.pdf>
- Citazione: «> Mittente > Azienda, indirizzo > Luogo e data > Oggetto (in grassetto) > Formula di apertura/appellativo > Introduzione e parte principale > Frase conclusiva > Saluti > Allegati»
- Nota del verificatore: Nine items, none a signature. In the sample 'Mario Bianchi' is set in the script font 'Journal' above the typed name in Arial.

### C25 (T1) — verifica: confirmed

SECO/URC leaflet in Italian 'Candidatura elettronica' (Art. Nr. 716.208.i 08.2018): the cover letter must be sent as an attachment, distinct from the e-mail text. Nothing on signing the attached letter.

- Fonte: SECO / URC (hosted by Cantone Ticino) — <https://www4.ti.ch/fileadmin/DFE/DE-SDL/b_persone/flyer/opuscolo_SECO_candidatura_elettronica.pdf>
- Citazione: «Ricordate però che l’e-mail non sostituisce la lettera d’accompagnamento, che deve comunque essere inoltrata sotto forma di allegato.»
- Nota del verificatore: Imprint 'Art. Nr. 716.208.i 08.2018'. This leaflet says the e-mail does not replace the letter, which conflicts with C12/C19/C26 (letter may be the e-mail text).

### C26 (T1) — verifica: confirmed

SECO brochure in Italian 'Come presentare una buona candidatura?' (form. 711.253 i 02.2018): the letter may be written directly in the e-mail or attached as PDF. The word 'firma' occurs only for the handwriting sample and as the heading of the e-mail footer.

- Fonte: SECO / lavoro.swiss — <https://www.arbeit.swiss/api/media/fileservice/sdweb-docs-prod-arbeitswiss-files/files/2026/07/09/acb5f40b-ca57-4312-9a1e-b6e6e5eefab0.pdf>
- Citazione: «Puoi scegliere se scrivere la lettera di candidatura direttamente nell’e-mail o se allegarla in formato PDF.»
- Nota del verificatore: p. 14; imprint 'form. 711.253.i 02.2018'. 'firma' occurs twice only (handwriting sample; heading of the e-mail footer).

### C27 (T1) — verifica: confirmed

Città di Lugano (adults): the three Word model letters end with the typed name directly after the closing formula; no signature placeholder, no image in the files; the web page says nothing about a signature (slashes mark paragraph breaks).

- Fonte: Città di Lugano — <https://www.lugano.ch/dam/jcr:be1e4c48-a695-4aa5-82c6-607ceabb3297/mod-lettera-candidatura-2.docx>
- Citazione: «La ringrazio per la sua particolare attenzione e, in attesa di una sua gentile risposta, le porgo cordiali saluti. / Mario Rossi / Allegato: citato.»
- Nota del verificatore: All three models and the web page opened. No picture in any file (the drawing in model 2 is a rule line). 'Directly after' is loose: three empty paragraphs precede the name and four to twelve follow it, the usual room for a signature. The page says nothing on signing.

### C28 (T2) — verifica: confirmed

jobs.ch (page dated 2026-02-06): the letter ends with a greeting and your name; for online applications a handwritten or scanned signature is not required (typo 'eingesannte' is in the source).

- Fonte: jobs.ch (JobCloud) — <https://www.jobs.ch/de/job-coach/ratgeber-checklisten/bewerbungsschreiben-aufbau-und-beispiele/>
- Citazione: «Bei Online-Bewerbungen ist eine handschriftliche oder eingesannte Unterschrift nicht erforderlich.»
- Nota del verificatore: datePublished 2026-02-06. jobs.ch does not say 'in der Deutschschweiz'. The same paragraph advertises JobCloud's AI letter generator.

### C29 (T2) — verifica: confirmed

jobup.ch (page dated 2026-02-09, French counterpart of the jobs.ch page, same publisher): closing formula and your name; for online applications a handwritten or scanned signature is not necessary.

- Fonte: jobup.ch (JobCloud) — <https://www.jobup.ch/fr/job-coach/conseils-checklistes/lettre-de-motivation-exemples-et-structure/>
- Citazione: «Pour les candidatures en ligne, une signature manuscrite ou scannée n’est pas nécessaire.»
- Nota del verificatore: datePublished 2026-02-09. Translation of the jobs.ch page by the same publisher: one source, not two.

### C30 (T2) — verifica: confirmed

Randstad Switzerland (2024-10): sign the letter by hand at the end; the online case is not addressed.

- Fonte: Randstad (Schweiz) — <https://www.randstad.ch/talent-blog/arbeit/bewerbungsschreiben-wichtige-informationen-und-tipps/>
- Citazione: «Zum Schluss unterschreibst du das Schreiben handschriftlich.»
- Nota del verificatore: Dated 09 Oktober 2024; the instruction appears twice on the page.

### C31 (T2) — verifica: confirmed

Manpower Switzerland (2024-01, Italian page; the German and French versions of the same page say 'händisch zu unterschreiben' and 'signer votre lettre à la main'): sign the letter by hand; the online case is not addressed.

- Fonte: Manpower (Svizzera) — <https://www.manpower.ch/it/joblog/blogs/2024/01/04/cover-letter>
- Citazione: «Firma. Ricordati di firmare a mano la tua lettera.»
- Nota del verificatore: IT, DE and FR pages opened; all three sentences found.

### C32 (T2) — verifica: confirmed

Manpower Switzerland: signing the CV is listed among the errors to avoid.

- Fonte: Manpower (Svizzera) — <https://www.manpower.ch/it/joblog/blogs/2024/01/03/cv>
- Citazione: «Non bisogna assolutamente: Firmare un curriculum vitae: Il CV non è una lettera.»
- Nota del verificatore: Covers signing only, not dating.

### C33 (T2) — verifica: confirmed

Adecco, German (Germany) site, not Switzerland: a missing signature is listed among mistakes; for online applications scan the signature beforehand. The Swiss Adecco pages returned by search (adecco.com/de-ch, /fr-ch) answer 404.

- Fonte: Adecco (Deutschland) — <https://www.adecco.com/de-de/blog/anschreiben-bewerbung>
- Citazione: «Keine Unterschrift - bei Online-Bewerbungen scanne deine Unterschrift am besten vorher ein.»
- Nota del verificatore: German-market page. The Swiss Adecco blog indexes (de-ch, fr-ch, it-ch) list no letter guidance.

### C34 (T2) — verifica: confirmed

Gewerbeverband Basel-Stadt, apprenticeship placement guide (2024): insert the signature by scanning it or cutting it out with a screenshot tool, above first and last name.

- Fonte: Gewerbeverband Basel-Stadt — <https://gewerbe-basel.ch/wp-content/uploads/2024/04/Bewerbungsratgeber-der-Lehrstellenvermittlung.pdf>
- Citazione: «Unterschrift (Signatur einscannen, per PrintScreen oder SnippingTool ausschneiden+einsetzen) Vorname Name»
- Nota del verificatore: p. 6; PDF created 2024-04-05.

### C35 (T1) — verifica: confirmed

Home-country habit, Austria: the public employment service advises signing both CV and letter, and scanning the signature for digital applications (page updated 2025-09-23).

- Fonte: AMS Österreich (foreign institution) — <https://www.ams.at/arbeitsuchende/topicliste/lebenslauf-unterschreiben>
- Citazione: «Daher ist es ratsam, sowohl den Lebenslauf als auch das Bewerbungsschreiben zu unterschreiben.»
- Nota del verificatore: 'Diese Seite wurde aktualisiert am: 23. September 2025'.

### C36 (T1) — verifica: confirmed

Home-country habit, Germany: the federal employment agency says to scan the signature into e-mail applications, and that in an online form with free-text fields a signature is neither possible nor needed.

- Fonte: Bundesagentur für Arbeit (foreign institution) — <https://www.arbeitsagentur.de/bildung/bewerbung/anschreiben>
- Citazione: «Bei E-Mail-Bewerbungen kannst du deine Unterschrift einscannen und als digitales Bild in die Datei einfügen. […] Bei einem Online-Formular mit Freitextfeldern ist eine (digitale) Unterschrift in der Regel nicht möglich – und auch nicht nötig.»
- Nota del verificatore: Concerns the letter only; it does not support 'signing the CV is the German habit' (that comes from C6).

### C37 (T1) — verifica: confirmed

BACS weekly review 43/2025: phishing pages collect broad personal data valuable for later fraud; in a current case a 'digital signature' was requested together with name, address, IBAN and ID copies.

- Fonte: Bundesamt für Cybersicherheit BACS — <https://www.bacs.admin.ch/de/25w43-de>
- Citazione: «Bei einem aktuellen Fall ging es beispielsweise um eine angebliche Rückerstattung und es wurde neben den persönlichen Informationen auch nach einer digitalen Unterschrift gefragt.»
- Nota del verificatore: Week 43/2025; the list of requested data includes 'Digitale Unterschrift'.

### C38 (T1) — verifica: confirmed

BACS review of 2025 (week 52): profiles built from such data, the case with the digital signature being cited in the preceding sentence, enable identity theft, targeted social engineering and resale.

- Fonte: Bundesamt für Cybersicherheit BACS — <https://www.bacs.admin.ch/de/25w52-de>
- Citazione: «Die so erstellten Profile der Opfer sind für kriminelle Aktivitäten besonders wertvoll, da sie Identitätsdiebstahl, gezielte Social-Engineering-Angriffe oder den Weiterverkauf der Daten auf dem Schwarzmarkt ermöglichen.»
- Nota del verificatore: Week 52/2025; the sentence follows the digital-signature case.

### C39 (T1) — verifica: confirmed

BACS weekly review 12/2026: fictitious job offers are published on legitimate job portals and even in printed newspapers; all language regions are affected, a supposed company in Ticino included.

- Fonte: Bundesamt für Cybersicherheit BACS — <https://www.bacs.admin.ch/de/26w12-de>
- Citazione: «Die fiktiven Jobangebote werden auf den legitimen Jobportalen ausgeschrieben.»
- Nota del verificatore: Week 12/2026. Same page: the early variants were published 'vor allem auf italienischen ... Stellenportalen', relevant for candidates living in Italy.

### C40 (T1) — verifica: confirmed

BACS weekly review 12/2026: in the fake application process the victim is asked to upload CV, certificates and diplomas; the fraudsters obtain extensive personal information that can be misused for further fraud.

- Fonte: Bundesamt für Cybersicherheit BACS — <https://www.bacs.admin.ch/de/26w12-de>
- Citazione: «Zudem gelangen die Betrüger auf diesem Weg an umfangreiche persönliche Informationen, welche anschliessend für weitere Betrugsversuche missbraucht werden können.»
- Nota del verificatore: Same page.

### C41 (T2) — verifica: confirmed

Swiss Banking Ombudsman, case 2010/01: a bank checks a written payment order by comparing the signature on the order with the specimen deposited with the bank.

- Fonte: Schweizerischer Bankenombudsman — <https://bankingombudsman.ch/gefaelschter-zahlungsauftrag-wer-haftet/>
- Citazione: «Dies geschieht aufgrund eines Vergleichs der Unterschrift auf dem Auftrag mit dem bei der Bank deponierten Muster.»
- Nota del verificatore: Case 2010/01. The same paragraph adds that the bank may not limit itself to a signature comparison. A 16-year-old case summary is used in the present tense in the proposed notice.

### C42 (T2) — verifica: confirmed

Swiss Banking Ombudsman, case 2010/01: where the customer's signature was forged well, the bank was not grossly at fault on the signature check.

- Fonte: Schweizerischer Bankenombudsman — <https://bankingombudsman.ch/gefaelschter-zahlungsauftrag-wer-haftet/>
- Citazione: «Im vorliegenden Fall handelte es sich um eine recht gute Fälschung der Kundenunterschrift, weshalb der Ombudsman zum Schluss gelangte, dass der Bank diesbezüglich kein grobes Verschulden vorgeworfen werden kann.»
- Nota del verificatore: True 'diesbezüglich' only: in the same case the Ombudsman found the bank lacking in care overall and the loss was split.

### C43 (T2) — verifica: confirmed

Swiss Banking Ombudsman, case 2013/10 (USD 50,000 transferred on a forged order): the fraudster had the customer's signature among the basic data used.

- Fonte: Schweizerischer Bankenombudsman — <https://bankingombudsman.ch/betruegerischer-zahlungsauftrag/>
- Citazione: «zweifelsohne über gewisse Grunddaten des Kunden (Bankverbindung, Kontonummer, Unterschrift, Wissen um eine Passwortvereinbarung) verfügte»
- Nota del verificatore: Case 2013/10; the bank ended up paying 80%.

### C44 (T1) — verifica: confirmed

Kantonspolizei Zürich (fake rental-application form, a case analogous to a fake job application): handing over ID copies and official documents risks identity misuse.

- Fonte: Kantonspolizei Zürich, cybercrimepolice.ch — <https://cybercrimepolice.ch/de/faelle/datendiebstahl-bei-einer-mietbewerbung-ueber-ein-gefaelschtes-online-formular>
- Citazione: «Besonders heikel sind Ausweiskopien und weitere amtliche Unterlagen. Wer solche Dokumente preisgibt, riskiert Identitätsmissbrauch.»
- Nota del verificatore: Dated 15.04.2026. The page does not mention signatures.

### C45 (T2) — verifica: confirmed

German consumer organisation: on ID copies given to third parties, data not needed for identification, the signature included, should be blacked out.

- Fonte: Verbraucherzentrale Niedersachsen (foreign consumer organisation) — <https://www.verbraucherzentrale-niedersachsen.de/wissen/digitale-welt/datenschutz/ausweiskopien-mit-wasserzeichen-so-schuetzen-sie-sich-vor-identitaetsdiebstahl-120151>
- Citazione: «Für die Identifizierung nicht notwendige Angaben sind zu schwärzen. Dazu zählen etwa die Seriennummer, Größe, Augenfarbe oder Ihre Unterschrift.»

### C46 (T2) — verifica: confirmed

German consumer organisation on job scamming (as of 31 August 2026): an application really needs only name, a contact and a CV with qualifications; the same page says criminals place adverts on reputable job portals.

- Fonte: Verbraucherzentrale (foreign consumer organisation) — <https://www.verbraucherzentrale.de/wissen/digitale-welt/datenschutz/gefaelschte-stellenanzeigen-was-ist-jobscamming-28475>
- Citazione: «Welche Daten werden in einem Bewerbungsprozess wirklich gebraucht? Name, Kontaktmöglichkeit (E-Mail od. Adresse od. Telefonnummer), Lebenslauf mit Angaben zur Qualifikation (Ausbildung/Studium/ beruflicher Werdegang)»
- Nota del verificatore: 'Stand: 31. August 2026'.

### C47 (T1) — verifica: confirmed

UK company registry (2019): acknowledges concerns about the publication of signatures in documents accessible to third parties, in a post about protecting individuals from identity theft and fraud.

- Fonte: Companies House, UK (foreign government agency) — <https://companieshouse.blog.gov.uk/2019/06/27/protecting-your-personal-information/>
- Citazione: «aware of concerns over the publication of personal data such as full dates of birth, signatures, and residential addresses which have been used as a company’s registered office address»

### C48 (T1) — verifica: confirmed

BIZ Kanton Bern (p. 23, about online profiles): do not upload the whole dossier, because it could be spread without being asked.

- Fonte: BIZ Kanton Bern — <https://www.biz.bkd.be.ch/content/dam/biz_bkd/dokumente/de/angebote/informationsangebote/biz-publikationen/infoblaetter-und-broschueren/stellensuche-berufseinstieg-praktikum/m051-bewerbungsdossier-erwachsene.pdf>
- Citazione: «Verzichten Sie aber darauf, Ihr ganzes Dossier hochzuladen – es könnte ungefragt gestreut werden.»
- Nota del verificatore: p. 23, about LinkedIn-type profiles.

### C49 (T1) — verifica: confirmed

Swiss Data Protection Act (DSG, SR 235.1, status 1 September 2023), Art. 5 let. a: personal data are all information relating to an identified or identifiable natural person. An image of a named person's signature falls under this definition (my application of the text).

- Fonte: Fedlex (Bundesrecht) — <https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/2022/491/20230901/de/html/fedlex-data-admin-ch-eli-cc-2022-491-20230901-de-html.html>
- Citazione: «Personendaten: alle Angaben, die sich auf eine bestimmte oder bestimmbare natürliche Person beziehen»
- Nota del verificatore: The cited consolidation (1 September 2023) is superseded: Fedlex lists versions of 1 April 2025 and 7 July 2025. Wording of Art. 5 let. a is identical in the current version; cite that one.

### C50 (T1) — verifica: confirmed

DSG Art. 5 let. c no. 4: among sensitive personal data are only biometric data that uniquely identify a natural person (Italian text: 'i dati biometrici che identificano in modo univoco una persona fisica'; French: 'les données biométriques identifiant une personne physique de manière univoque').

- Fonte: Fedlex (Bundesrecht) — <https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/2022/491/20230901/de/html/fedlex-data-admin-ch-eli-cc-2022-491-20230901-de-html.html>
- Citazione: «biometrische Daten, die eine natürliche Person eindeutig identifizieren»
- Nota del verificatore: German, Italian and French texts verified; unchanged in the version of 7 July 2025.

### C51 (T1) — verifica: confirmed

Federal Council dispatch on the DSG revision (BBl 2017 6941, p. 7020): biometric data must rest on a specific technical procedure that allows unique identification or authentication; ordinary photographs are in principle not biometric data.

- Fonte: Bundesrat (Bundesblatt) — <https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/fga/2017/2057/de/pdf-a/fedlex-data-admin-ch-eli-fga-2017-2057-de-pdf-a.pdf>
- Citazione: «Diese Daten müssen zwingend auf einem spezifischen technischen Verfahren beruhen, das die eindeutige Identifizierung oder Authentifizierung einer Person erlaubt. Dies ist beispielsweise grundsätzlich nicht der Fall bei gewöhnlichen Fotografien.»
- Nota del verificatore: BBl 2017 7020.

### C52 (T1) — verifica: confirmed

EDÖB guide on biometric recognition systems (version 1.0, September 2009, before the revised act): the signature is listed as a behavioural biometric characteristic, in the context of recognition systems.

- Fonte: EDÖB — <https://www.edoeb.admin.ch/dam/en/sd-web/aPSaA7DAZbYu/leitfaden_zu_biometrischenerkennungssystemen_DE.pdf>
- Citazione: «Verhaltensspezifische Charakteristika - Unterschrift - Stimmbild - Gangart - Art des Tastenschreibens (keystroke)»
- Nota del verificatore: Section 1.3 table and footnote 3 ('Insbesondere die Unterschrift, die Stimme oder die Gangart').

### C53 (T1) — verifica: confirmed

GDPR Art. 4(14), Italian text as published by the Italian data protection authority: biometric data are personal data resulting from specific technical processing of physical, physiological or behavioural characteristics that allow or confirm unique identification.

- Fonte: Garante per la protezione dei dati personali (text of Regulation (EU) 2016/679) — <https://www.garanteprivacy.it/documents/10160/0/Regolamento+UE+2016+679.+Arricchito+con+riferimenti+ai+Considerando+Aggiornato+alle+rettifiche+pubblicate+sulla+Gazzetta+Ufficiale++dell%27Unione+europea+127+del+23+maggio+2018>
- Citazione: ««dati biometrici»: i dati personali ottenuti da un trattamento tecnico specifico relativi alle caratteristiche fisiche, fisiologiche o comportamentali di una persona fisica che ne consentono o confermano l'identificazione univoca, quali l'immagine facciale o i dati dattiloscopici»

### C54 (T1) — verifica: confirmed

GDPR recital 51 (Italian text): photographs fall under the definition of biometric data only when processed through a specific technical means allowing unique identification or authentication. By analogy the same holds for an image of a signature (my reading).

- Fonte: Garante per la protezione dei dati personali (text of Regulation (EU) 2016/679) — <https://www.garanteprivacy.it/documents/10160/0/Regolamento+UE+2016+679.+Arricchito+con+riferimenti+ai+Considerando+Aggiornato+alle+rettifiche+pubblicate+sulla+Gazzetta+Ufficiale++dell%27Unione+europea+127+del+23+maggio+2018>
- Citazione: «esse rientrano nella definizione di dati biometrici soltanto quando siano trattate attraverso un dispositivo tecnico specifico che consente l'identificazione univoca o l'autenticazione di una persona fisica»

### C55 (T1) — verifica: confirmed

Italian data protection authority, general provision on biometrics (12 November 2014): what it treats as biometric data in signing is the dynamic information captured with specific hardware while a handwritten signature is made ('firma grafometrica'), not a static image.

- Fonte: Garante per la protezione dei dati personali (foreign regulator) — <https://www.garanteprivacy.it/home/docweb/-/docweb-display/docweb/3556992>
- Citazione: «Il trattamento di dati biometrici costituiti da informazioni dinamiche associate all´apposizione a mano libera di una firma autografa avvalendosi di specifici dispositivi hardware»
- Nota del verificatore: Section 4.4; the annexed guidelines (section 3.2 'Dinamica di apposizione della firma autografa') say the same.

### C56 (T1) — verifica: confirmed

DSG Art. 6 para. 3: purpose limitation.

- Fonte: Fedlex (Bundesrecht) — <https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/2022/491/20230901/de/html/fedlex-data-admin-ch-eli-cc-2022-491-20230901-de-html.html>
- Citazione: «Personendaten dürfen nur zu einem bestimmten und für die betroffene Person erkennbaren Zweck beschafft werden; sie dürfen nur so bearbeitet werden, dass es mit diesem Zweck vereinbar ist.»
- Nota del verificatore: Unchanged in the version of 7 July 2025.

### C57 (T1) — verifica: confirmed

DSG Art. 6 para. 4: personal data are destroyed or anonymised as soon as they are no longer needed for the purpose. The law gives no fixed period.

- Fonte: Fedlex (Bundesrecht) — <https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/2022/491/20230901/de/html/fedlex-data-admin-ch-eli-cc-2022-491-20230901-de-html.html>
- Citazione: «Sie werden vernichtet oder anonymisiert, sobald sie zum Zweck der Bearbeitung nicht mehr erforderlich sind.»
- Nota del verificatore: Unchanged in the version of 7 July 2025.

### C58 (T1) — verifica: confirmed

DSG Art. 8 para. 1: controller and processor must ensure data security appropriate to the risk.

- Fonte: Fedlex (Bundesrecht) — <https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/2022/491/20230901/de/html/fedlex-data-admin-ch-eli-cc-2022-491-20230901-de-html.html>
- Citazione: «Der Verantwortliche und der Auftragsbearbeiter gewährleisten durch geeignete technische und organisatorische Massnahmen eine dem Risiko angemessene Datensicherheit.»
- Nota del verificatore: Unchanged in the version of 7 July 2025.

### C59 (T1) — verifica: confirmed

DSG Art. 19 para. 2: when collecting personal data the controller must at least state its identity and contact details, the purpose, and the recipients or categories of recipients.

- Fonte: Fedlex (Bundesrecht) — <https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/2022/491/20230901/de/html/fedlex-data-admin-ch-eli-cc-2022-491-20230901-de-html.html>
- Citazione: «er teilt ihr mindestens mit: a. die Identität und die Kontaktdaten des Verantwortlichen; b. den Bearbeitungszweck; c. gegebenenfalls die Empfängerinnen und Empfänger oder die Kategorien von Empfängerinnen und Empfängern, denen Personendaten bekanntgegeben werden.»
- Nota del verificatore: Unchanged in the version of 7 July 2025.

### C60 (T1) — verifica: confirmed

GDPR Art. 3(2)(a) (Italian text): the regulation applies to a controller not established in the EU when it offers goods or services to data subjects in the EU. Candidates living in Italy, France, Germany or Austria make this likely applicable to the service (my inference; not confirmed by a lawyer).

- Fonte: Garante per la protezione dei dati personali (text of Regulation (EU) 2016/679) — <https://www.garanteprivacy.it/documents/10160/0/Regolamento+UE+2016+679.+Arricchito+con+riferimenti+ai+Considerando+Aggiornato+alle+rettifiche+pubblicate+sulla+Gazzetta+Ufficiale++dell%27Unione+europea+127+del+23+maggio+2018>
- Citazione: «l'offerta di beni o la prestazione di servizi ai suddetti interessati nell'Unione, indipendentemente dall'obbligatorietà di un pagamento dell'interessato»
- Nota del verificatore: Quote found. The inference is understated: the site's own privacy policy already declares the GDPR applicable and is addressed to cross-border workers living in Italy.

### C61 (T1) — verifica: confirmed

Code of Obligations Art. 14 (status 1 January 2026): a signature is written by hand; a mechanical reproduction suffices only where customary; a qualified electronic signature is equivalent. An inserted image is therefore not a legal signature for form-bound acts; no source found says a cover letter is such an act.

- Fonte: Fedlex (Bundesrecht) — <https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/27/317_321_377/20260101/de/html/fedlex-data-admin-ch-eli-cc-27-317_321_377-20260101-de-html.html>
- Citazione: «Eine Nachbildung der eigenhändigen Schrift auf mechanischem Wege wird nur da als genügend anerkannt, wo deren Gebrauch im Verkehr üblich ist, insbesondere wo es sich um die Unterschrift auf Wertpapieren handelt, die in grosser Zahl ausgegeben werden.»
- Nota del verificatore: Art. 14 para. 2 found. The step 'an image is not a legal signature' must stay limited to form-bound acts: most Swiss transactions are form-free and other signature types can be used there (BAKOM), and doctrine mostly accepts signed-then-scanned documents even for written form (Federal Council report 2023).

### C62 (T1) — verifica: confirmed

Criminal Code Art. 251 no. 1 (status 1 January 2026): using another person's genuine signature to produce a false document, with intent to harm or to gain an unlawful advantage, is document forgery (up to five years).

- Fonte: Fedlex (Bundesrecht) — <https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/54/757_781_799/20260101/de/html/fedlex-data-admin-ch-eli-cc-54-757_781_799-20260101-de-html.html>
- Citazione: «die echte Unterschrift oder das echte Handzeichen eines andern zur Herstellung einer unechten Urkunde benützt»
- Nota del verificatore: The offence needs an 'Urkunde' and the stated intent; the recommendation's short version drops both.

### C63 (T1) — verifica: confirmed

Criminal Code Art. 179decies (in force since 1 September 2023): identity misuse is punishable on complaint.

- Fonte: Fedlex (Bundesrecht) — <https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/54/757_781_799/20260101/de/html/fedlex-data-admin-ch-eli-cc-54-757_781_799-20260101-de-html.html>
- Citazione: «Wer die Identität einer anderen Person ohne deren Einwilligung verwendet, um dieser zu schaden oder um sich oder einem Dritten einen unrechtmässigen Vorteil zu verschaffen, wird auf Antrag mit Freiheitsstrafe bis zu einem Jahr oder Geldstrafe bestraft.»

### C64 (T1) — verifica: confirmed

SECO brochure in Italian: in an application e-mail the 'signature' is a footer with address, phone and e-mail (heading 'Firma').

- Fonte: SECO / lavoro.swiss — <https://www.arbeit.swiss/api/media/fileservice/sdweb-docs-prod-arbeitswiss-files/files/2026/07/09/acb5f40b-ca57-4312-9a1e-b6e6e5eefab0.pdf>
- Citazione: «Inserisci in fondo alla mail il tuo indirizzo, numero di telefono e indirizzo di posta elettronica»

### C65 (T1) — verifica: confirmed

BIZ Kanton Bern: the application e-mail ends with a greeting and a signature block with contact details.

- Fonte: BIZ Kanton Bern — <https://www.biz.bkd.be.ch/content/dam/biz_bkd/dokumente/de/angebote/informationsangebote/biz-publikationen/infoblaetter-und-broschueren/stellensuche-berufseinstieg-praktikum/m051-bewerbungsdossier-erwachsene.pdf>
- Citazione: «Grussformel und Signatur mit Kontaktdaten (Name, Adresse, Telefon, Social Media)»

### C66 (T1) — verifica: confirmed

DSG Art. 19 para. 4: if personal data are disclosed abroad, the person must be told the country and, where applicable, the guarantees. Relevant if the image is stored with cloud processors outside Switzerland.

- Fonte: Fedlex (Bundesrecht) — <https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/2022/491/20230901/de/html/fedlex-data-admin-ch-eli-cc-2022-491-20230901-de-html.html>
- Citazione: «Werden die Personendaten ins Ausland bekanntgegeben, so teilt er der betroffenen Person auch den Staat oder das internationale Organ und gegebenenfalls die Garantien nach Artikel 16 Absatz 2 oder die Anwendung einer Ausnahme nach Artikel 17 mit.»
- Nota del verificatore: Unchanged in the version of 7 July 2025.

## Raccomandazione del ricercatore

WHAT THE SOURCES STATE

- No source says a cover letter sent as PDF must be signed to be valid or accepted. The wording is that of checklists: "nicht vergessen", "signez", "ricordati" (C4, C15, C22).
- Typed name only is explicitly acceptable online for jobs.ch and jobup.ch (C28, C29) and for the ETH Career Center, which says the signature can be scanned in or left out entirely (C7). SECO lets the letter be the e-mail text itself, where no handwritten signature is possible (C12, C19, C26). The Lugano models and the SDBB German fill-in template end with the typed name (C27, C2).
- A visible signature is still the stated convention in official guides. It is most consistent in French- and Italian-speaking Switzerland and for apprenticeships: orientation.ch, scan allowed (C13, C14); Vaud (C15-C17); Geneva, by hand or scanned (C18); orientamento.ch (C20, C21); Ticino UOSP (C22); a Ticino school template, print-sign-scan (C23); berufsberatung.ch, "digitale Unterschrift" (C1, C2); Graubünden and Thurgau checklists (C10, C11); Universität Basel (C8). Randstad and Manpower say "sign by hand" without addressing online sending (C30, C31).
- The CV is never signed in Switzerland (C6, C32). Signing CV and letter is the Austrian and German habit (C35, C36).
- Risk: no authority addresses a signature inside application documents (gap). The evidence is indirect. BACS reports fraudsters collecting a "digitale Unterschrift" with identity data, and that such profiles enable identity theft (C37, C38). Fake adverts on legitimate portals collect dossiers (C39, C40, C46). Swiss banks check written orders by signature comparison, and a good forgery can leave the bank without gross fault (C41-C43). Consumer advice is to black out the signature on ID copies sent to third parties (C45).
- Law: a signature image is personal data (C49). It is "besonders schützenswert" only as biometric data that uniquely identify, which presupposes a specific technical identification procedure (C50-C55). Purpose limitation, deletion, security and information duties apply (C56-C59, C66). An inserted image is not a legal signature (C61). Using someone's genuine signature on a document they did not approve is forgery (C62).

WHAT I RECOMMEND

1. Default output everywhere: the typed first and last name under the closing formula, in the body typeface. It is always truthful and is explicitly sufficient online (C7, C28, C29).
2. Offer, never require, a signature image that the candidate uploads (scan or photo of their own signature). It is the only way to follow the stated convention without the service inventing anything. Never generate a signature, and never use a handwriting-style font or "gez.", "signé", "f.to": each would assert a signature the candidate never made.
3. Prompt strength by target region (language region of the employer, not the UI language) and profile:
   - German-speaking, qualified or first job: "offered", collapsed, labelled optional (C7, C28).
   - German-speaking, apprenticeship: "recommended" (C1, C2, C10, C11).
   - French-speaking, all profiles: "recommended" (C13-C18; jobup.ch says unnecessary online, C29).
   - Italian-speaking, all profiles: "recommended" (C20-C23; Lugano shows typed name only, C27).
   - "Recommended" changes only the visibility of the step and the hint shown. With no upload the letter goes out with the typed name.
   - Letter pasted into an e-mail body, portal text field or chat: no image, typed name plus contact lines (C12, C36, C64, C65).
   - CV: never signed, never dated (C6, C32).
4. Tell the candidate on one screen before upload (wording in options): where the image goes, to whom the PDF is sent, that it cannot be recalled and that an image can be copied out of a PDF, the two risk facts (C39-C43), when it is deleted and how to delete it, and that the service never creates a signature. The privacy notice must name controller, purpose, recipients and any storage country outside Switzerland (C59, C66). Require an unticked confirmation, and show the signature in every letter preview with one-click removal.
5. Retention: the image is needed only to render the letters of the current order (C56, C57). Delete it when the last letter of the order is sent, at the latest 30 days after last use, and immediately on request. The 30 days are my proposal; no source gives a number. Store it like a credential (C58): encrypted, private, never in logs.
6. Never do the following with it:
   - place it on the CV, certificates, forms, declarations, consents or contracts (C62);
   - use it where a signed form or an e-signature is requested (hand that step to the candidate);
   - run signature recognition or any biometric analysis, which would make it sensitive data (C50-C55);
   - send it to an LLM, or use it for training, marketing or tests;
   - lift a signature from other documents of the candidate;
   - reuse it for a later order without new confirmation.
7. If the candidate wants a signature but will not upload one, offer the PDF for them to sign and send themselves.

TRADE-OFF

- In German-speaking Switzerland for qualified roles the convention is weak and waived online, so the typed name costs nothing.
- In French- and Italian-speaking Switzerland and for apprenticeships, omitting the signature has a presentational cost that no source quantifies, while the main Romandie portal calls it unnecessary online.
- The risk is real but indirect and unquantified. The image leaves the candidate's control with every PDF, the service writes to recipients the candidate may not have vetted, fake adverts exist, and Swiss banks still authenticate written orders by signature.
- The letter is valid without a signature and the service must not fabricate one, so the choice belongs to the informed candidate.

## Formulazioni e impostazioni proposte

### `letter.closing.typed_name`

- de: Freundliche Grüsse /  / {Vorname} {Nachname}
- fr: {formule de politesse}, mes meilleures salutations. /  / {Prénom} {Nom}
- it: Cordiali saluti /  / {Nome} {Cognome}
- en: Kind regards /  / {First name} {Last name}
- Vera quando: Always, when the candidate gave this first and last name. The name is set in the body typeface (no handwriting-style font) and no word implying a signature ('gez.', 'signé', 'f.to', 'signed') is added. Alignment follows the regional letter layout (left in German; right-hand block in French and Italian, per the prior study B.1).
- Base: C2, C7, C12, C19, C26, C27, C28, C29

### `letter.closing.uploaded_signature`

- de: Freundliche Grüsse / [hochgeladenes Unterschriftsbild der Kandidatin / des Kandidaten, ca. 40-50 mm breit] / {Vorname} {Nachname}
- fr: {formule de politesse}, mes meilleures salutations. / [image de signature importée par la candidate / le candidat, env. 40-50 mm de large] / {Prénom} {Nom}
- it: Cordiali saluti / [immagine della firma caricata dalla candidata / dal candidato, circa 40-50 mm di larghezza] / {Nome} {Cognome}
- en: Kind regards / [signature image uploaded by the candidate, about 40-50 mm wide] / {First name} {Last name}
- Vera quando: Only when (1) the image is a scan or photo of the candidate's own handwritten signature, uploaded by the candidate and altered only by crop, resize and background clean-up; (2) the candidate ticked ui.signature.consent; (3) the candidate approved this specific letter in a preview that shows the signature. Never for the CV or any other document.
- Base: C1, C2, C8, C13, C14, C18, C20, C21, C22, C23

### `ui.signature.hint.target_de`

- de: Unterschrift: optional. Für Online-Bewerbungen in der Deutschschweiz ist laut jobs.ch keine handschriftliche oder eingescannte Unterschrift erforderlich; laut dem Bewerbungsratgeber der ETH Zürich kann sie eingescannt eingefügt oder ganz weggelassen werden. berufsberatung.ch (Lehrstellen) und das BIZ Bern führen die Unterschrift in ihren Anleitungen zum Brief weiterhin auf. Ohne Bild endet Ihr Brief mit Ihrem getippten Namen.
- fr: Signature: facultative. Pour les candidatures en ligne en Suisse alémanique, jobs.ch indique qu'une signature manuscrite ou scannée n'est pas nécessaire, et le guide de candidature de l'EPF de Zurich précise qu'elle peut être insérée scannée ou totalement omise. berufsberatung.ch (apprentissage) et le BIZ de Berne la mentionnent toujours dans leurs consignes pour la lettre. Sans image, votre lettre se termine par votre nom dactylographié.
- it: Firma: facoltativa. Per le candidature online nella Svizzera tedesca jobs.ch indica che la firma a mano o scansionata non è necessaria, e la guida alle candidature dell'ETH di Zurigo dice che si può inserire scansionata oppure omettere del tutto. berufsberatung.ch (apprendistato) e il BIZ di Berna la prevedono ancora nelle loro indicazioni per la lettera. Senza immagine, la lettera si chiude con il tuo nome scritto a computer.
- en: Signature: optional. For online applications in German-speaking Switzerland, jobs.ch states that a handwritten or scanned signature is not required, and ETH Zurich's application guide says it can be scanned in or left out altogether. berufsberatung.ch (apprenticeships) and BIZ Bern still list a signature in their letter guidance. Without an image, your letter ends with your typed name.
- Vera quando: The letter is addressed to an employer in German-speaking Switzerland, and the cited pages still read as on 2026-10-03 (jobs.ch page dated 2026-02-06, ETH guide 2024, berufsberatung.ch, BIZ Bern M051-08.2025). Register (Sie/tu/vous) to be aligned with the site's existing copy.
- Base: C1, C2, C4, C7, C28

### `ui.signature.hint.target_fr`

- de: Unterschrift: optional, wird aber von den offiziellen Ratgebern der Romandie verlangt. orientation.ch, der Kanton Waadt und der Kanton Genf verlangen eine handschriftliche Unterschrift; orientation.ch und Genf lassen für Online-Bewerbungen eine eingescannte Unterschrift zu. Laut jobup.ch ist online keine handschriftliche oder eingescannte Unterschrift nötig. Ohne Bild endet Ihr Brief mit Ihrem getippten Namen.
- fr: Signature: facultative, mais demandée par les guides officiels romands. orientation.ch, le canton de Vaud et le canton de Genève demandent une signature manuscrite; orientation.ch et Genève admettent une signature scannée pour les candidatures en ligne. jobup.ch indique qu'en ligne une signature manuscrite ou scannée n'est pas nécessaire. Sans image, votre lettre se termine par votre nom dactylographié.
- it: Firma: facoltativa, ma richiesta dalle guide ufficiali della Svizzera romanda. orientation.ch, il Canton Vaud e il Canton Ginevra chiedono la firma a mano; orientation.ch e Ginevra ammettono la firma scansionata per le candidature online. jobup.ch indica che online la firma a mano o scansionata non è necessaria. Senza immagine, la lettera si chiude con il tuo nome scritto a computer.
- en: Signature: optional, but the official guides in French-speaking Switzerland ask for one. orientation.ch, the canton of Vaud and the canton of Geneva ask for a handwritten signature; orientation.ch and Geneva accept a scanned one for online applications. jobup.ch states that a handwritten or scanned signature is not necessary online. Without an image, your letter ends with your typed name.
- Vera quando: The letter is addressed to an employer in French-speaking Switzerland, and the cited pages still read as on 2026-10-03 (orientation.ch, Vaud OCOSP 2019/2023, Geneva DIP sheet, jobup.ch page dated 2026-02-09).
- Base: C13, C14, C15, C16, C17, C18, C29

### `ui.signature.hint.target_it`

- de: Unterschrift: optional, wird aber von den offiziellen Ratgebern der italienischen Schweiz verlangt. Die Berufsberatung des Kantons Tessin erinnert daran, den Brief zu unterschreiben, und orientamento.ch sieht die Unterschrift in der Schlussformel vor; eine Vorlage einer Tessiner Sekundarschule nennt für den E-Mail-Versand: ausdrucken, unterschreiben, einscannen. Die Musterbriefe der Stadt Lugano enden dagegen nur mit dem Namen. Ohne Bild endet Ihr Brief mit Ihrem getippten Namen.
- fr: Signature: facultative, mais demandée par les guides officiels de la Suisse italienne. L'office d'orientation du canton du Tessin rappelle de signer la lettre et orientamento.ch prévoit la signature dans la formule finale; un modèle d'une école secondaire tessinoise indique, pour l'envoi par e-mail, d'imprimer, de signer et de scanner la lettre. Les modèles de la Ville de Lugano se terminent en revanche par le seul nom. Sans image, votre lettre se termine par votre nom dactylographié.
- it: Firma: facoltativa, ma richiesta dalle guide ufficiali della Svizzera italiana. L'Ufficio dell'orientamento del Cantone Ticino ricorda di firmare la lettera e orientamento.ch prevede la firma nella formula di chiusura; un modello di una scuola media ticinese indica, per l'invio via e-mail, di stampare, firmare e scansionare la lettera. I modelli della Città di Lugano si chiudono invece con il solo nome. Senza immagine, la lettera si chiude con il tuo nome scritto a computer.
- en: Signature: optional, but the official guides in Italian-speaking Switzerland ask for one. The Ticino cantonal guidance office reminds applicants to sign the letter and orientamento.ch includes a signature in the closing; a Ticino middle-school template says to print, sign and scan the letter when sending by e-mail. The City of Lugano's model letters, by contrast, end with the name only. Without an image, your letter ends with your typed name.
- Vera quando: The letter is addressed to an employer in Italian-speaking Switzerland, and the cited documents still read as on 2026-10-03 (UOSP 'Candidarsi per un posto di tirocinio', orientamento.ch, Scuola media di Ambrì template 2020, Città di Lugano models).
- Base: C20, C21, C22, C23, C27

### `ui.signature.notice`

- de: Bevor Sie Ihre Unterschrift hochladen: / 1. Wir fügen das Bild nur in die Bewerbungsbriefe ein, die Sie freigeben, über Ihrem getippten Namen. Nie in den Lebenslauf, nie in andere Dokumente. / 2. Jeder Brief geht als PDF an den Arbeitgeber oder das Stellenportal der jeweiligen Bewerbung. Nach dem Versand können wir ihn nicht zurückholen, und wer ein PDF erhält, kann ein Bild daraus kopieren. / 3. Das Bundesamt für Cybersicherheit meldet gefälschte Stelleninserate auch auf legitimen Jobportalen, und laut dem Schweizerischen Bankenombudsman prüfen Banken schriftliche Zahlungsaufträge durch Unterschriftenvergleich. Laden Sie Ihre Unterschrift nur hoch, wenn Sie damit einverstanden sind. / 4. Wir löschen das Bild, {sobald der letzte Brief Ihres Auftrags versendet ist, spätestens 30 Tage nach der letzten Verwendung}; Sie können es jederzeit unter {Konto > Unterschrift} selbst löschen. / 5. Wir erstellen, zeichnen oder imitieren nie eine Unterschrift. Laden Sie nichts hoch, tragen Ihre Briefe nur Ihren getippten Namen.
- fr: Avant d'importer votre signature: / 1. Nous insérons l'image uniquement dans les lettres de motivation que vous validez, au-dessus de votre nom dactylographié. Jamais dans le CV, jamais dans un autre document. / 2. Chaque lettre est envoyée en PDF à l'employeur ou au portail d'emploi de la candidature concernée. Une fois envoyée, nous ne pouvons plus la retirer, et toute personne qui reçoit un PDF peut en copier une image. / 3. L'Office fédéral de la cybersécurité signale de fausses offres d'emploi, y compris sur des portails légitimes, et selon l'Ombudsman des banques suisses les banques vérifient les ordres de paiement écrits en comparant les signatures. N'importez votre signature que si cela vous convient. / 4. Nous supprimons l'image {dès que la dernière lettre de votre commande a été envoyée, au plus tard 30 jours après sa dernière utilisation}; vous pouvez la supprimer vous-même à tout moment sous {Compte > Signature}. / 5. Nous ne créons, ne redessinons et n'imitons jamais de signature. Si vous n'importez rien, vos lettres portent uniquement votre nom dactylographié.
- it: Prima di caricare la tua firma: / 1. Inseriamo l'immagine solo nelle lettere di candidatura che approvi, sopra il tuo nome scritto a computer. Mai nel CV, mai in altri documenti. / 2. Ogni lettera viene inviata in PDF al datore di lavoro o al portale di quella candidatura. Dopo l'invio non possiamo più ritirarla, e chi riceve un PDF può copiarne un'immagine. / 3. L'Ufficio federale della cibersicurezza segnala falsi annunci di lavoro anche su portali legittimi e, secondo l'Ombudsman delle banche svizzere, le banche verificano gli ordini di pagamento scritti confrontando la firma. Carica la firma solo se questo ti sta bene. / 4. Cancelliamo l'immagine {quando l'ultima lettera del tuo ordine è stata inviata, al più tardi 30 giorni dopo l'ultimo utilizzo}; puoi cancellarla tu in ogni momento in {Account > Firma}. / 5. Non creiamo, ridisegniamo né imitiamo mai una firma. Se non carichi nulla, le lettere riportano solo il tuo nome scritto a computer.
- en: Before you upload your signature: / 1. We insert the image only in the cover letters you approve, above your typed name. Never in your CV, never in any other document. / 2. Each letter is sent as a PDF to the employer or job portal of that application. Once sent, we cannot recall it, and whoever receives a PDF can copy an image out of it. / 3. The Swiss Federal Office for Cybersecurity reports fake job adverts even on legitimate job portals, and according to the Swiss Banking Ombudsman banks check written payment orders by comparing signatures. Upload your signature only if you are comfortable with that. / 4. We delete the image {when the last letter of your order has been sent, at the latest 30 days after its last use}; you can delete it yourself at any time under {Account > Signature}. / 5. We never create, redraw or imitate a signature. If you upload nothing, your letters carry your typed name only.
- Vera quando: Only if all five statements match the implemented behaviour: insertion limited to cover letters the candidate approved; each PDF really goes to the recipient of that application; the deletion job runs with the stated rule and a self-service delete exists at the stated place; no signature is ever generated or redrawn. The placeholders in braces must be replaced by the real rule and menu path. Point 3 rests on C39-C43 and must be re-checked if those pages change.
- Base: C37, C38, C39, C40, C41, C42, C43, C56, C57, C59

### `ui.signature.consent`

- de: Das ist meine eigene handschriftliche Unterschrift. Ich beauftrage frontaliereticino.ch, sie in die von mir freigegebenen Bewerbungsbriefe einzufügen und diese Briefe an die Empfänger meiner Bewerbungen zu senden.
- fr: Il s'agit de ma propre signature manuscrite. Je demande à frontaliereticino.ch de l'insérer dans les lettres de motivation que je valide et d'envoyer ces lettres aux destinataires de mes candidatures.
- it: Questa è la mia firma autografa. Chiedo a frontaliereticino.ch di inserirla nelle lettere di candidatura che approvo e di inviare tali lettere ai destinatari delle mie candidature.
- en: This is my own handwritten signature. I ask frontaliereticino.ch to insert it in the cover letters I approve and to send those letters to the recipients of my applications.
- Vera quando: Ticked by the candidate, never pre-ticked. For a candidate under 18 (apprenticeship profile): additionally confirmed by a parent or guardian until the legal check on minors is done (see gaps).
- Base: C56, C59, C62

### `ui.signature.preview.with`

- de: Dieser Brief wird mit dem Bild Ihrer Unterschrift versendet. [Aus diesem Brief entfernen]
- fr: Cette lettre sera envoyée avec l'image de votre signature. [Retirer de cette lettre]
- it: Questa lettera verrà inviata con l'immagine della tua firma. [Togli da questa lettera]
- en: This letter will be sent with your signature image. [Remove from this letter]
- Vera quando: The PDF that will be sent for this application actually contains the uploaded signature image.
- Base: C56, C62

### `ui.signature.preview.without`

- de: Dieser Brief endet mit Ihrem getippten Namen, ohne Unterschriftsbild.
- fr: Cette lettre se termine par votre nom dactylographié, sans image de signature.
- it: Questa lettera si chiude con il tuo nome scritto a computer, senza immagine della firma.
- en: This letter ends with your typed name, without a signature image.
- Vera quando: The PDF that will be sent for this application contains no signature image.
- Base: C7, C28, C29

### `message.closing.plain_text`

- de: Freundliche Grüsse / {Vorname} {Nachname} / {Adresse} / {Telefon} / {E-Mail}
- fr: Meilleures salutations / {Prénom} {Nom} / {Adresse} / {Téléphone} / {E-mail}
- it: Cordiali saluti / {Nome} {Cognome} / {Indirizzo} / {Telefono} / {E-mail}
- en: Kind regards / {First name} {Last name} / {Address} / {Phone} / {E-mail}
- Vera quando: Used when the letter or covering message is typed into an e-mail body, a portal text field or a chat hand-off. All contact lines were given by the candidate; lines without data are omitted. No image.
- Base: C12, C19, C26, C36, C64, C65

### `setting.signature.defaults`

- en: signature.output = typed_name for every region, profile and channel; uploaded_image only after upload, consent and per-letter approval. signature.prompt by target region (language region of the employer, not UI language) and profile: de + qualified/first job = offered (collapsed, labelled optional); de + apprenticeship = recommended; fr, all profiles = recommended; it, all profiles = recommended. Channel overrides: e-mail body, portal text field, chat hand-off = image disabled (typed name + contact lines). CV: signature and date always disabled.
- Vera quando: Configuration, not a statement to the candidate. 'Recommended' must be worded as in ui.signature.hint.*: it reports what the regional guides ask for, never a requirement.
- Base: C1-C36

### `setting.signature.retention`

- en: Keep the uploaded image only while it is needed to render the letters of the current order. Delete automatically when the last letter of the order has been sent and at the latest 30 days after the image was last used; delete immediately when the candidate removes it, withdraws consent or deletes the account. Backups expire within their normal rotation and are never used to restore a deleted signature for reuse. PDFs already generated keep the image and follow the general document retention rule, which the notice must state. Storage: encrypted, private bucket, no public or guessable URL; state the storage country in the privacy notice.
- Vera quando: May be promised to the candidate only once the deletion job and the self-service delete exist; until then the notice must not state a deletion date. The 30-day cap is a product proposal, not taken from a source.
- Base: C56, C57, C58, C66

### `setting.signature.never`

- en: Never: (1) generate, redraw, vectorise or imitate a signature, use a handwriting-style font as a signature, or lift a signature from another document of the candidate (ID, permit, old CV, certificates); (2) put the image on the CV, certificates, forms, declarations, consents, contracts, powers of attorney or any document the candidate has not approved with the signature visible; (3) use it where the recipient asks for a signed form or an electronic signature: hand that step to the candidate; (4) put it in e-mail bodies, portal text fields or chat messages; (5) add 'gez.', 'signé', 'f.to' or 'signed' next to a typed name; (6) run signature recognition, verification or any biometric analysis on it; (7) send it to an LLM or use it for training, examples, marketing or tests; (8) write it to logs, analytics, Remote Config or error reports; (9) reuse it for a later order without a new upload or explicit confirmation; (10) embed it above roughly 150 dpi at printed size (about 45 mm wide). Note for the team: an image embedded in a PDF can always be extracted by the recipient; low resolution limits reuse quality but does not prevent copying.
- Vera quando: Guardrails for the generator and the sending pipeline; each item must be enforced in code, not only in policy.
- Base: C6, C32, C50, C51, C52, C55, C56, C58, C61, C62, C63

## Lacune dichiarate

- No Swiss authority (EDÖB, BACS, Schweizerische Kriminalprävention) and no Swiss bank was found that addresses a scanned handwritten signature inside application documents. The risk evidence is indirect (C37-C47): signatures are collected by fraudsters, fake adverts collect dossiers, banks authenticate written orders by signature. No source measures how often a signature taken from an application is misused.
- No EDÖB statement was found on whether a signature image is biometric data under the revised act. The 2009 guide (C52) predates the law and concerns recognition systems. The classification 'ordinary personal data unless processed by a specific identification technique' is my reading of Art. 5 DSG, the dispatch and GDPR recital 51.
- No source quantifies how Swiss recruiters react to an unsigned PDF letter. A figure of about 80% of HR expecting a signature appeared only in a search snippet from a German commercial site (karrierebibel.de); the page was not opened and is not used.
- Adecco Switzerland: the two pages returned by search (adecco.com/de-ch and /fr-ch) answer 404, so there is no Swiss Adecco statement; only the German-market page could be opened (C33). Hays Switzerland (German and French pages) and Michael Page Switzerland were opened and say nothing about a signature.
- Italian-speaking Switzerland, adults: no institutional source addresses the PDF case. Lugano and SECO are silent, and the print-sign-scan instruction comes from one middle-school template of 2020 for apprentices (C23). No Italian-language Swiss portal statement on online applications was found; Manpower's Italian page says to sign by hand without addressing online sending (C31).
- Vaud guides (C15-C17) do not mention online sending; whether 'à la main' is meant for PDFs too is not stated. Randstad and Manpower likewise do not distinguish channels.
- University career services: only ETH, Basel and an old UZH sample were found. Nothing on the signature was found for UNIL, UNIGE, EPFL, USI or SUPSI career services; a UNIGE document requiring a 'Signature manuscrite' concerns admission to a master's programme, not job applications, and is not used.
- Retention: no source gives a period. Art. 6 para. 4 DSG states only the principle. The 30-day cap and the 'end of order' trigger are product proposals.
- Minors (apprenticeship candidates aged 14-16) uploading a signature: rules on consent and representation were not researched (GDPR Art. 8 with national age limits; Swiss civil law on capacity of judgement). A legal check is needed before offering the upload to under-18 profiles without a guardian's confirmation.
- Applicability of the GDPR to the service (C60), the identity of the controller and the storage countries were not verified: production and configuration were out of scope by instruction.
- EUR-Lex could not be opened (HTTP 202 with empty body, both by fetch and by the web-fetch tool). The GDPR text was taken from the consolidated PDF published by the Italian data protection authority; Art. 4 was cross-checked on cnil.fr and legislation.gov.uk.
- Could not be opened (404): the Graubünden leaflet in Italian 'Consigli per la lettera di candidatura', the Basel-Stadt 'Anleitung Lehrstellenbewerbung' and the Solothurn 'Bewerbungsbrief Merkblatt', all returned by search. The Ticino UOSP web page 'Dossier di candidatura e preparazione al colloquio' also answered 404; its PDF guide was opened instead (C22).
- SECO brochures: the German edition (03.2019) has no sample letter. For the French and Italian editions (02.2018) only the text layer was searched; any sample-letter image was not inspected. The French edition hosted on vd.ch is the older 2009 print.
- PDF quotes were extracted with PDFKit; line-break hyphens and extraction artefacts were normalised. Two quotes whose text layer is scrambled by column layout (C25, C4) were confirmed on the rendered page. Working copies are in a scratch directory (temporary, outside any repository).
- Side findings outside this topic that correct the prior study: (a) the orientamento.ch e-mail model uses 'Gentili signore e signori,' and 'porgo distinti saluti' (https://www.orientamento.ch/it/preparare-e-spedire-la-candidatura), and the SECO Italian brochure uses 'Distinti saluti' for the application e-mail, so both formulas do occur in Swiss institutional sources; (b) the SECO brochure exists in Italian and French on arbeit.swiss (C19, C26), although the prior study recorded a 404 for the Italian file.
- A read-only search of the site repository for existing signature handling returned no relevant code on the branch currently checked out (fix/newsletter-unsubscribe-persistence, not main); the code state was not mapped further because it belongs to another work item.
