# Fonti: Formule della lettera nelle quattro lingue

Pagine lette il 3 ottobre 2026. Ricerca e verifica sono di due agenti distinti: il secondo ha riaperto ogni
fonte e cercato di confutare ogni affermazione. Le citazioni sono nella lingua della fonte; il testo della
ricerca è in inglese, come è stato prodotto. Le **decisioni** prese su queste fonti sono in
[`../decisioni.md`](../decisioni.md): dove la raccomandazione del ricercatore e la decisione differiscono,
vale la decisione.

Domanda: Letter formulas printed by the assisted application (German, French, Italian, English) checked against Swiss institutional sources

## Esito della verifica

- Affermazioni: 74; verdetti: 73 confirmed, 1 misread.
- La raccomandazione regge: no, vedi le obiezioni.

### Obiezioni del verificatore

- Summary. 73 of the 74 quotes are real and support their claims (all 43 URLs opened and re-read on 3 October 2026; IT15 is misread). The recommendation does not hold as written: three of the 13 changes overstep the sources (5, 12, 13), one proposed option can print a false statement (apprentice subject), the English part rests on a superseded edition, and at least five mismatches were missed. Changes 1, 2, 3, 8, 9, 10 and 11 survive, with the limits given below; changes 4 and 6 survive as improvements, not as mismatches.
- English: the source is out of date. The findings quote the Federal Chancellery's English Style Guide of 2016; the Chancellery's English page now offers the third edition (September 2024). That edition says no comma goes after the salutation or the sign-off, and prints «Dear Jamie Smith» for a recipient whose title is unknown. So the code's «Dear Sir or Madam,», «Dear Ms Muster,» and «Dear Anna Muster,» (all with a comma) differ from the current federal rule, which the table calls «matches». The gap «no Swiss source rules on the comma, none prints Dear First name Surname» is false. The pairing by formality stays («Dear Ms Smith … Yours sincerely», «Dear Jane … Kind regards»), so «Dear Sir or Madam» with «Kind regards» mixes two levels; keeping «Kind regards» remains an owner decision.
- Italian salutation without a contact is not a «match». Canton Ticino's orientation office (UOSP, August 2025: annotated model letter, three example letters, e-mail instructions) prints «Gentili Signore e Signori,» every time, and Canton Graubünden's Italian leaflet (2026) prints «Gentili signore e signori,». The Ticino directive the researcher cites (IT18) tells offices to avoid the traditional pair with two different adjectives. The code's «Gentili signore, egregi signori,» is backed by orientamento.ch and one Consiglio di Stato letter. The honest verdict is «sources diverge», and for Ticino the symmetric form is the better sourced one. The gap «no model application letter was found on ti.ch» is wrong: ti.ch/tirocinio links five of them.
- Change 12 (apprentice subject) can print a false statement. candidateType returns «apprentice» when the posting text merely mentions apprentices and the candidate has no job yet, and for any title with «trainee position» or «tirocinio». Run read-only: «Sachbearbeiter/in 80%» with «Betreuung der Lernenden» in the text gives apprentice; «Trainee Position Marketing» gives apprentice; «Stage / tirocinio formativo marketing» gives apprentice. The subject would then say «Bewerbung um die Lehrstelle als …» for a post that is not an apprenticeship. The option's own condition («the posting offers an apprenticeship place») is not checked by any code today.
- Change 12, wording. Apprenticeship titles already contain the word: the subject would read «Bewerbung um die Lehrstelle als Lehrstelle 2027: Informatiker/in EFZ» unless the trade is extracted, and the existing prefix stripper fails on «Lehrstelle 2027: …», «Kauffrau/Kaufmann EFZ (Lehrstelle 2027)» and «Apprenti-e …» (run). In Italian, «posto di apprendistato come» appears only on the orientamento.ch page; the SDBB model letter, Ticino UOSP and Graubünden all write «posto di tirocinio» (di / come / quale).
- Change 5 (closing line at the left margin in French and Italian) contradicts the researcher's own sources for a bare closing. KV Schweiz: «Bei Rechtsadressierung ist der Schluss üblicherweise rechts, 117 mm von links», and the SNV sample in the SKV preview is captioned «Adresse rechts … Briefschluss rechts». That is what the code does today. The official models that keep only the signature on the right have the closing as a sentence inside the body; a bare closing at the left with the signature on the right appears once (Lugano model 3). The change is sound only together with change 4 (French sentence); for the Italian «Cordiali saluti» it is an owner decision, not a mismatch.
- Change 13 (left margin 26 mm) rests on one T2 page. The official SDBB templates use 25.0 mm (French and Italian, w:left=1418) and 25.4 mm (German, 1440); Lugano uses 17.6 to 20 mm. The current 25 mm equals the national template. Also, the «correction to the prior study» about the KV margin is misplaced: section B.1 already says 26–30 mm; the 25 mm stands in the comment of assisted-letter.typ.
- German typography is not a full match. The code puts a no-break space before every % that follows a digit, compounds included: «80%-Pensum» becomes «80 %-Pensum» and «5%-Hürde» becomes «5 %-Hürde» (run). Schreibweisungen n. 555, right after the n. 554 the researcher quotes, says the sign joins the digit without a space in compounds. «80%-Pensum» is a frequent wording in Swiss applications.
- Salutation parsing: the four defects of change 9 are real, and more were missed (all run read-only). Surname particles are dropped when the posting gives honorific plus surname only: «Frau von Arx» gives «Sehr geehrte Frau Arx», «signora De Luca» gives «Gentile signora Luca,», «Sig.ra Della Santa» gives «Gentile signora Santa,». «Herrn Peter Müller» gives «Guten Tag Herrn Peter Müller». A single word gives «Guten Tag Müller» and «Dear Müller,». Two contacts are mixed: «Frau Muster / Herr Meier» gives «Sehr geehrte Frau Meier». An e-mail address gives «Guten Tag jobs@firma.ch».
- Gender is inferred from things that are not honorifics, against the code's own rule. «M.» is read as Monsieur in every language, so a first-name initial decides the gender: «M. Keller» in a German posting gives «Sehr geehrter Herr Keller», in an Italian one «Gentile signor Keller,». «Dott.» is read as male: «Dott. Maria Rossi» gives «Gentile signor Rossi,». The option «salutation_contact_male» lists «M.» as a safe honorific; it is one only in a French posting.
- The honorifics the options add are not safe for every posting. «Fr.» is also «Father» in English and «Frère» in French, and the code's own typography treats «Fr.» as the currency. «Hr.» must not match «HR»: the existing patterns are case-insensitive, so «HR Team» would become «Sehr geehrter Herr Team». Both need the full stop, the exact case and the posting's language before they count as an honorific.
- Date line: the table says place and date match, but the place is whatever stands before the first comma of the profile's location, and only «via …» is filtered. Run read-only: «Viale Varese 5, Como» gives «Viale Varese 5, 3 ottobre 2026»; «Bahnhofstrasse 1, 8001 Zürich» gives «Bahnhofstrasse 1, …»; «22100 Como (CO)» gives «22100 Como, …»; «Italia» gives «Italia, …». The option's condition («the candidate's own place of residence») is not guaranteed by the code. With change 1 this becomes «Rue du Lac 5, le 3 octobre 2026», and without a place the French line would start with a lower-case «le».
- Change 7 (lower-case the first Italian word by default) trades a mild fault for a worse one. Proper nouns that are not in the order line, such as the candidate's former employers, schools and places, would be lower-cased, and so would courtesy pronouns («La ringrazio» becomes «la ringrazio»). For the same reason decision e (ask for lower-case courtesy pronouns throughout) goes against most sources that show them: the Federal Chancellery (n. 126), the SDBB model, SECO and Graubünden use the capital; only the Lugano models and one Consiglio di Stato letter do not.
- IT15 does not say what the table uses it for. N. 84 is about non-binary addressees, states that official language has no codified solution, and offers name plus function as a possibility. «Gentile Nome Cognome,» for a contact of unknown gender is a fair analogy, not a match with a source. The German counterpart (DE16) does cover names that do not show the gender.
- German salutation with a named contact: the table says «matches», but BIZ Bern (adults, August 2025), which the researcher cites, uses «Guten Tag Frau/Herr Nachname», and KV says both forms are right, «Sehr geehrte» being the more formal. The verdict should read «sources diverge on register». This is no reason to change the code.
- Decision d (keep Dr./Prof.) is argued with one course handout and the English guide. The Federal Chancellery's Schreibweisungen n. 360 say academic titles are normally not given, which supports today's behaviour in German. In English the 2024 guide writes «Dr» without a full stop, and «Dear Dr Smith» needs no gender: that would also repair «Dr Anna Muster» giving «Dear Anna Muster,». In Italian the Chancellery's form for titled professionals is «Egregio Dottore / Gentile Dottoressa,» without the surname, which the findings do not mention.
- Change 4 (French closing sentence) is well supported, more than the researcher shows: besides the CSFO template and its three examples and Vaud's apprentice sheet, Vaud's adult leaflet (2019) and Neuchâtel's 2026 guide print the same kind of sentence. But it is an improvement, not a mismatch: orientation.ch itself lists the bare «Meilleures salutations» and SECO a bare «Sincères salutations». The code takes the last text block as the closing and the template prints it in the narrow right-hand column, so the template must change with it.
- Change 6 (singular label): solid in Italian (Lugano models 1 and 2, Consiglio di Stato). In French the sources diverge: SECO prints «Annexe:», CSFO example 3 prints «Annexes : dossier de candidature». German and English stay unsourced, as the researcher says.
- Change 10 (e-mail salutation and closing in code): today the e-mail body is one text written by the model, salutation and closing included. Adding the code's formulas without changing the schema and the stored drafts would print them twice. For Italian e-mails the sources split: SECO and Graubünden print «Distinti saluti», Ticino UOSP «porgo cordiali saluti».
- Flags. The code's French pattern «je serais ravi(e) de» matches the official CSFO example 3 word for word, so it marks a sentence of the official model as filler; the researcher cites only example 1, which the pattern does not match. The German patterns proposed in change 8 work on the quoted phrases (tested) but still miss «Ich würde mich über eine Einladung freuen» and «einer neuen Herausforderung».
- Smaller points. A posting's «Mrs» is turned into «Ms», although the federal guide says to keep the person's own preference. The French label prints «Annexes:» without a space before the colon, while the code's own CV heading uses one and CSFO and jobup print «Annexes :». Italian % (change 11): the space rule stands, but the same paragraph asks for «per cento» in running text.
- Checked and found clean: no proposed formula promises an outcome, states a right, or depends on nationality or permit, so nothing is aimed at a group it does not fit, apart from the apprentice subject. Not opened: the HSG sample cover letter (the host does not resolve) and the Neuchâtel typing directives (the link now redirects to a press page).

### Prove contrarie o mancanti nella ricerca

- **claim**: Gap «English: no Swiss institutional source rules on a comma after the salutation or the closing», and the table rows that call «Dear Sir or Madam,» and «Dear Ms {Surname},» a match
  **source**: https://www.bk.admin.ch/dam/en/sd-web/s-KLxST1P9Ke/English%20Style%20Guide.pdf (Federal Chancellery, General Style Guide, third edition, September 2024; listed on https://www.bk.admin.ch/en/style-guides-for-english-language-translators)
  **quote**: Note: In UK English, no comma or colon is placed after the salutation or sign-off and no full-stop after the contractions 'Mr', 'Ms', 'Mx', 'Dr'.
- **claim**: Gap and table: no source prints «Dear {First name Surname}» for a contact whose title is unknown
  **source**: https://www.bk.admin.ch/dam/en/sd-web/s-KLxST1P9Ke/English%20Style%20Guide.pdf
  **quote**: If you do not know the recipient’s preferred title, you can simply use a person’s first name with their surname. Dear Jamie Smith
- **claim**: EN02 and decision c: the 2016 sentence against «Kind regards» in formal letters is gone; the current edition pairs closings by level of formality
  **source**: https://www.bk.admin.ch/dam/en/sd-web/s-KLxST1P9Ke/English%20Style%20Guide.pdf
  **quote**: As in a letter, in an email the salutation and sign off should match the level of formality.
- **claim**: Decision d for English: the title is written «Dr», without a full stop
  **source**: https://www.bk.admin.ch/dam/en/sd-web/s-KLxST1P9Ke/English%20Style%20Guide.pdf
  **quote**: As it is a contraction, there is no final point.
- **claim**: Table: Italian salutation without a contact «matches»; gap: no model application letter on ti.ch
  **source**: https://www4.ti.ch/fileadmin/DECS/DS/UOSP/download/Tirocinio/Lettera_di_motivazione_con_nuvolette.pdf (Canton Ticino, UOSP, August 2025; linked from https://www4.ti.ch/index.php?id=97269; read on the rendered page because the text boxes overlap)
  **quote**: Gentili Signore e Signori, [note beside it:] Formula da usare se non conosci il nome del destinatario. Se invece lo conosci, puoi utilizzare: Gentile signora Cognome, Gentile signor Cognome,
- **claim**: Same point, and the e-mail option in Italian
  **source**: https://www4.ti.ch/fileadmin/DECS/DS/UOSP/download/Tirocinio/Candidatura_istruzioni_per_l_uso_-_e-mail.pdf (Canton Ticino, UOSP, August 2025)
  **quote**: Oggetto: Candidatura tirocinio – [Nome della professione] … Gentili Signore e Signori, mi chiamo [Nome Cognome] … Nell’attesa di una risposta, porgo cordiali saluti.
- **claim**: Option subject_apprentice (Italian): «Candidatura per un posto di apprendistato come {professione}»
  **source**: https://www4.ti.ch/fileadmin/DECS/DS/UOSP/download/Tirocinio/Lettera_-_Esempio_2.docx (Canton Ticino, UOSP)
  **quote**: Candidatura posto di tirocinio come Nome professione
- **claim**: Same option, and the Italian salutations: a second canton of Italian-speaking Switzerland
  **source**: https://www.gr.ch/DE/institutionen/verwaltung/ekud/afb/Dokumente%20AfB/260128-bslb-Consigli%20per%20la%20lettera%20di%20candidatura.pdf (Canton Graubünden, Amt für Berufsbildung, PDF of 20 August 2026)
  **quote**: Oggetto, in grassetto («Candidatura per un posto di tirocinio come professione») … Formula di apertura («Gentile signora Cognome, / Egregio signor Cognome» oppure «Gentili signore e signori,»)
- **claim**: Same option: the SDBB's own Italian model letter uses «tirocinio»
  **source**: https://media.sdbb.ch/asset/186e8601-f413-4a1a-bd5c-c06abf155121/Lettera_di_motivazione.pdf
  **quote**: Candidatura per il posto di tirocinio di...
- **claim**: Option email_salutation_and_closing (Italian «Cordiali saluti»): a 2026 cantonal source prints «Distinti saluti» in the application e-mail
  **source**: https://www.gr.ch/DE/institutionen/verwaltung/ekud/afb/Dokumente%20AfB/250918-bslb-Il%20dossier%20di%20candidatura.pdf (Canton Graubünden, PDF of 25 August 2026)
  **quote**: Gentile signora / Egregio signor ..., in allegato riceve la mia candidatura per il posto a concorso quale «...». Sarei lieto/a di essere invitato/a a un colloquio di presentazione personale. Distinti saluti
- **claim**: Table: German typography «matches» (DE15)
  **source**: https://www.bk.admin.ch/dam/de/sd-web/YVHazXZRkqKn/schreibweisungen.pdf (n. 555)
  **quote**: In Zusammensetzungen werden die Begriffszeichen % und ‰ ohne Leerzeichen → 250 an die vorangehende Ziffer angeschlossen.
- **claim**: Decision d: keep «Dr.» / «Prof.» in the German salutation
  **source**: https://www.bk.admin.ch/dam/de/sd-web/YVHazXZRkqKn/schreibweisungen.pdf (n. 360, heading «Akademische Titel normalerweise nicht angeben»)
  **quote**: Akademische Titel und Grade wie «Prof. Dr.», «Dr.», «Dr. h. c.» usw. werden nur angegeben, wenn ausdrücklich hervorgehoben werden soll, dass die erwähnte Person den betreffenden Titel oder Grad trägt.
- **claim**: Decision d for Italian: the Chancellery's form for titled professionals
  **source**: https://www.bk.admin.ch/dam/it/sd-web/gSEkvTH4mFka/istruzioni_dellacancelleriafederaleperlaredazionedeitestiufficia.pdf (n. 122, row «Professionisti con titolo»)
  **quote**: Egregio Avvocato / Dottore / Professore, … Gentile Avvocata / Dottoressa / Professoressa,
- **claim**: Change 5: closing line at the left margin in right-addressed (French and Italian) letters
  **source**: https://www.kfmv.ch/wissen/berufsalltag/praxistipps/professionelle-briefe-schreiben
  **quote**: (Bei Rechtsadressierung ist der Schluss üblicherweise rechts, 117 mm von links.)
- **claim**: Change 5, same point in the SNV sample letters
  **source**: https://verlagskv.ch/wp-content/uploads/blick-ins-buch/regeln_computerschreiben_22a_blick_ins_buch_1.pdf
  **quote**: Adresse rechts, Leitwörter auf waagrechter Linie, Briefschluss rechts
- **claim**: Change 13: left margin 26 mm instead of 25 mm
  **source**: https://media.sdbb.ch/asset/0090f850-1d2a-4eeb-ab79-10ddf1e53fd1/Exemple-de-lettre-a-completer.docx (word/document.xml; the Italian template has the same value, the German one w:left="1440")
  **quote**: <w:pgMar w:top="1248" w:right="1418" w:bottom="1134" w:left="1418" w:header="567" w:footer="709" w:gutter="0"/>
- **claim**: Change 6: «Annexe» in the singular for a single enclosure
  **source**: https://media.sdbb.ch/asset/5505cef6-0cb7-40b3-b89e-a858516ee3d6/Exemple-de-lettre-3-Anissa.pdf (CSFO example letter 3, linked from orientation.ch)
  **quote**: Annexes : dossier de candidature
- **claim**: French flag «je serais ravi(e) de»: the official model uses the flagged sentence
  **source**: https://media.sdbb.ch/asset/5505cef6-0cb7-40b3-b89e-a858516ee3d6/Exemple-de-lettre-3-Anissa.pdf
  **quote**: Je serais ravie de venir me présenter dans votre entreprise pour un entretien ou un stage d’observation.
- **claim**: Table: German salutation with a named contact «matches»
  **source**: https://www.biz.bkd.be.ch/content/dam/biz_bkd/dokumente/de/angebote/informationsangebote/biz-publikationen/infoblaetter-und-broschueren/stellensuche-berufseinstieg-praktikum/m051-bewerbungsdossier-erwachsene.pdf
  **quote**: Sprechen Sie die Kontaktperson mit ihrem Namen an («Guten Tag Frau Frei»).
- **claim**: Gap «Vaud: the adult guide gives no salutation or closing formula» (missed evidence; it supports changes 1 and 4 for adults and shows the date on the right)
  **source**: https://www.vd.ch/fileadmin/user_upload/themes/formation/orientation/fichiers_pdf/publications/postuler_adultes_2lettre_web.pdf (Canton Vaud, OCOSP, June 2019)
  **quote**: Romainmôtier, le 20 septembre 20.. … Madame, … je vous prie, Madame, de recevoir mes meilleurs messages.
- **claim**: Missed evidence for the French e-mail option (supports the closing sentence)
  **source**: https://www.ne.ch/sites/default/files/2026-08/OCOSP_rediger_candidature_apprentissage.pdf (Canton Neuchâtel, OCOSP, 2026 edition)
  **quote**: Dans l'attente de votre retour, je vous adresse Madame, Monsieur, mes meilleures salutations.

## Affermazioni e fonti

### IT01 (T1) — verifica: confirmed

For apprenticeship letters orientamento.ch gives «Gentile signora …» for a woman, «Egregio signor …» for a man, and «Gentili signore, egregi signori» when the name is unknown (lower-case «signora/signor»).

- Fonte: SDBB/CSFO – orientamento.ch — <https://www.orientamento.ch/it/scrivere-la-lettera-di-motivazione>
- Citazione: «Gentile signora Bernasconi / Egregio signor Bernasconi … Gentili signore, egregi signori: se non si conosce il nome della persona responsabile»
- Nota del verificatore: Quote found on the live page (it needs a session cookie; fetched 3 Oct 2026). The page is about apprenticeship letters only.

### IT02 (T1) — verifica: confirmed

orientamento.ch closes with «Cordiali saluti», then signature and name, and asks for a list of the enclosures («allegati»).

- Fonte: SDBB/CSFO – orientamento.ch — <https://www.orientamento.ch/it/scrivere-la-lettera-di-motivazione>
- Citazione: «Cordiali saluti, firma elettronica, nome e cognome … Fai un elenco degli allegati. In caso di mancanza di spazio puoi semplicemente scrivere «Dossier di candidatura».»

### IT03 (T1) — verifica: confirmed

orientamento.ch: the place is the candidate's place of residence, followed by the date; the subject is bold and, for an apprenticeship, reads «Candidatura per un posto di apprendistato come …».

- Fonte: SDBB/CSFO – orientamento.ch — <https://www.orientamento.ch/it/scrivere-la-lettera-di-motivazione>
- Citazione: «Indica il tuo luogo di residenza e la data. … Candidatura per un posto di apprendistato come … L’oggetto deve essere formattato in grassetto.»
- Nota del verificatore: True for the page. The SDBB model letter linked from the same page writes «Candidatura per il posto di tirocinio di...», so even SDBB is not uniform on this wording.

### IT04 (T1) — verifica: confirmed

The SDBB model letter writes the salutations with capitals («Gentile Signora», «Egregio Signor», «Gentili Signore, Egregi Signori»), ends them with a comma and starts the text in lower case.

- Fonte: SDBB/CSFO – model letter — <https://media.sdbb.ch/asset/186e8601-f413-4a1a-bd5c-c06abf155121/Lettera_di_motivazione.pdf>
- Citazione: «Gentile Signora XXX [o] Egregio Signor XXX [o] Gentili Signore, Egregi Signori, … indicare l’annuncio a cui si risponde, descrivere la propria situazione scolastica»
- Nota del verificatore: The lower-case line is a template instruction («indicare l’annuncio…»); the later instructions start with capitals, so the lower case after the comma is deliberate.

### IT05 (T1) — verifica: confirmed

In the SDBB model (DOCX) the closing is a sentence in the body at the left margin, with capitalised courtesy pronouns; only the recipient, «Luogo, data» and the signature are indented to the right (w:ind left 4248 + firstLine 708 twips, read in the file's XML); the enclosures label is «Allegati:».

- Fonte: SDBB/CSFO – model letter — <https://media.sdbb.ch/asset/1a53d46e-bfe2-4080-8597-508148ef3900/Lettera-di-motivazione-da-completare.docx>
- Citazione: «In attesa di un gentile riscontro, Le / Vi porgo i miei migliori saluti. … Nome Cognome … Firma a mano … Allegati:»
- Nota del verificatore: Read in the DOCX XML: recipient, «Luogo, data», «Nome Cognome» and «Firma a mano» carry w:ind left=4248 firstLine=708; the closing sentence and «Allegati:» are not indented. Page margin left = 1418 twips = 25.0 mm.

### IT06 (T1) — verifica: confirmed

Città di Lugano, model 1: place and date on the right without an article, «Gentile signor …,» for a man, lower-case start after the comma, lower-case courtesy forms, and the singular «Allegato:» for a single enclosure.

- Fonte: Città di Lugano — <https://www.lugano.ch/dam/jcr:54161143-834e-4624-a8ed-6941e5b66ce1/mod-lettera-candidatura-1.docx>
- Citazione: «Lugano, 15 marzo 2022 … Gentile signor Bianchi, … ho sentito spesso parlare della sua azienda conosciuta per le varie tipologie di lavaggi … Allegato: Curriculum Vitae»

### IT07 (T1) — verifica: confirmed

Città di Lugano, model 3 (reply to a posting): «Gentili signori,» when no name is given, lower-case start, «Cordiali saluti.» as its own line at the left margin (the signature is tabbed to the right), plural «Allegati:».

- Fonte: Città di Lugano — <https://www.lugano.ch/dam/jcr:458dd22b-1985-4740-a584-05ff011f52dd/mod-lettera-candidatura-3.docx>
- Citazione: «Gentili signori, … in riferimento all’annuncio come “Ausiliari/e di pulizia” pubblicato sul sito “job-room” … Cordiali saluti. … Allegati: curriculum vitae, certificati di lavoro e referenze»

### IT08 (T1) — verifica: confirmed

Città di Lugano, model 2: «Gentile signora …,» and courtesy pronouns in lower case inside the closing sentence («la sua», «le porgo»).

- Fonte: Città di Lugano — <https://www.lugano.ch/dam/jcr:be1e4c48-a695-4aa5-82c6-607ceabb3297/mod-lettera-candidatura-2.docx>
- Citazione: «Gentile signora Silver, … La ringrazio per la sua particolare attenzione e, in attesa di una sua gentile risposta, le porgo cordiali saluti.»

### IT09 (T1) — verifica: confirmed

Federal Chancellery, Italian instructions n. 122: the opening vocative is not abbreviated, is followed by a comma, and the first line of the letter starts in lower case.

- Fonte: Cancelleria federale – Istruzioni per la redazione dei testi ufficiali in italiano (8.5.2023, stato 15.12.2025) — <https://www.bk.admin.ch/dam/it/sd-web/gSEkvTH4mFka/istruzioni_dellacancelleriafederaleperlaredazionedeitestiufficia.pdf>
- Citazione: «Dopo il vocativo di apertura (che non va abbreviato ed è seguito dalla virgola), la prima riga della lettera inizia con la lettera minuscola:»
- Nota del verificatore: Scope: letters written by federal offices.

### IT10 (T1) — verifica: confirmed

Same instructions, letters to private persons: «Egregio / Gentile Signor …» for a man (both accepted), «Gentile Signora …» for a woman, and for several addressees «Gentili Signore, Egregi Signori,» or «Gentili Signore e Signori,».

- Fonte: Cancelleria federale – Istruzioni per la redazione dei testi ufficiali in italiano — <https://www.bk.admin.ch/dam/it/sd-web/gSEkvTH4mFka/istruzioni_dellacancelleriafederaleperlaredazionedeitestiufficia.pdf>
- Citazione: «Egregio / Gentile Signor ... (Cognome), … Gentile Signora ... (Cognome), … Gentili Signore, Egregi Signori, oppure Gentili Signore e Signori,»
- Nota del verificatore: The same table has a row the findings do not use: «Professionisti con titolo: Egregio Avvocato / Dottore / Professore, – Gentile Avvocata / Dottoressa / Professoressa,».

### IT11 (T1) — verifica: confirmed

Same instructions, closings for private addressees: a sentence, or simply «Cordiali saluti». «Distinti saluti» does not appear in the document.

- Fonte: Cancelleria federale – Istruzioni per la redazione dei testi ufficiali in italiano — <https://www.bk.admin.ch/dam/it/sd-web/gSEkvTH4mFka/istruzioni_dellacancelleriafederaleperlaredazionedeitestiufficia.pdf>
- Citazione: «Voglia gradire, gentile Signora Cognome, i nostri migliori saluti. In attesa di ..., Le porgo i miei più cordiali saluti. Cordiali saluti»
- Nota del verificatore: «distinti» does not occur anywhere in the PDF (raw and layout text searched).

### IT12 (T1) — verifica: confirmed

Same instructions: the date is day in figures, month in letters, year; the first of the month is written «1°».

- Fonte: Cancelleria federale – Istruzioni per la redazione dei testi ufficiali in italiano — <https://www.bk.admin.ch/dam/it/sd-web/gSEkvTH4mFka/istruzioni_dellacancelleriafederaleperlaredazionedeitestiufficia.pdf>
- Citazione: «Il giorno e l’anno si scrivono in cifre arabe, il mese in lettere, nell’ordine indicato qui di seguito: … Berna, 12 maggio 2019 Berna, 1° maggio 2019»
- Nota del verificatore: «1°» is used throughout the document (1° gennaio 2021, 1° giugno 2023).

### IT13 (T1) — verifica: confirmed

Same instructions: courtesy forms in correspondence (pronouns and possessives that refer to the addressee) take a capital letter.

- Fonte: Cancelleria federale – Istruzioni per la redazione dei testi ufficiali in italiano — <https://www.bk.admin.ch/dam/it/sd-web/gSEkvTH4mFka/istruzioni_dellacancelleriafederaleperlaredazionedeitestiufficia.pdf>
- Citazione: «Le forme di cortesia e di rispetto usate nella corrispondenza impongono l’uso dell’iniziale maiuscola.»
- Nota del verificatore: The rule excludes enclitic forms (informarla, porgerle).

### IT14 (T1) — verifica: confirmed

Same instructions: a protected (no-break) space stands between the figure and the % sign.

- Fonte: Cancelleria federale – Istruzioni per la redazione dei testi ufficiali in italiano — <https://www.bk.admin.ch/dam/it/sd-web/gSEkvTH4mFka/istruzioni_dellacancelleriafederaleperlaredazionedeitestiufficia.pdf>
- Citazione: «si conserva l’uso dello spazio protetto (CTRL+Shift+barra spaziatrice), qui simboleggiato dal segno «◊» tra la cifra e il simbolo percentuale»
- Nota del verificatore: Context left out: the same paragraph says the percentage is written out («per cento») in running text and the symbol belongs in brackets, tables, notes and technical texts.

### IT15 (T1) — verifica: misread

Federal Chancellery, guide to inclusive Italian (2nd edition 2023), n. 84: when the gender is not known, the person can be addressed with first name and surname («Gentile Mario Rossi, …»).

- Fonte: Cancelleria federale – Guida all’uso inclusivo della lingua italiana nei testi della Confederazione — <https://www.bk.admin.ch/dam/it/sd-web/Ahh8btiPHjjS/leitfaden-geschlechtergerechte-sprache.pdf>
- Citazione: «Se si conoscono nome e cognome della persona, una soluzione potrebbe consistere nell’impiegarli accompagnati, quando possibile, dall’esplicitazione della funzione senza marcatura di genere: … Gentile Mario Rossi, membro della Commissione federale X…»
- Nota del verificatore: The quote is there, but n. 84 is about non-binary addressees («il linguaggio ufficiale non offre al momento soluzioni codificate per rivolgersi a persone non binarie»), gives the form only as a possibility («potrebbe») and adds the function after the name. It does not say «when the gender is not known».

### IT16 (T1) — verifica: confirmed

SECO's Italian brochure: an application e-mail opens with «Gentile Signora XY» or «Egregio Signor XY» and closes with a formula such as «Distinti saluti» (sentence rejoined across the line breaks of a two-column PDF).

- Fonte: SECO – arbeit.swiss, «Come presentare una buona candidatura?» — <https://www.arbeit.swiss/api/media/fileservice/sdweb-docs-prod-arbeitswiss-files/files/2026/07/09/acb5f40b-ca57-4312-9a1e-b6e6e5eefab0.pdf>
- Citazione: «cominciare con una formula di apertura, ad esempio «Gentile Signora XY» o «Egregio Signor XY», e concludersi con una formula di chiusura quale «Distinti saluti».»
- Nota del verificatore: Brochure form. 711.253.i, 02.2018. Its sample letter also ends «Vi porgo i miei più distinti saluti».

### IT17 (T1) — verifica: confirmed

SECO's Italian examples of an e-mail subject use «Candidatura per la posizione di …», combine the post with the candidate's name, and write the percentage «50 %» with a space.

- Fonte: SECO – arbeit.swiss, «Come presentare una buona candidatura?» — <https://www.arbeit.swiss/api/media/fileservice/sdweb-docs-prod-arbeitswiss-files/files/2026/07/09/acb5f40b-ca57-4312-9a1e-b6e6e5eefab0.pdf>
- Citazione: «Puoi invece scrivere «Candidatura per la posizione di responsabile al 50 % – risposta al Vs. annuncio nel Corriere del Ticino», o «Candidatura di Elena Rossi per la posizione di assistente di studio medico».»

### IT18 (T1) — verifica: confirmed

Canton Ticino directive on inclusive language (26.10.2022): opening formulas come in symmetric pairs (Gentile avvocato X / Gentile avvocata X; Egregio signor X / Egregia signora X) and the traditional «Egregi Signori e Gentili Signore» is to be avoided.

- Fonte: Repubblica e Cantone Ticino – Consiglio di Stato — <https://www4.ti.ch/fileadmin/CAN/SGCDS/pari_opportunita/download/20221115_Allegato_2_Direttiva_linguaggio_inclusivo.pdf>
- Citazione: «N.B: evitare la tradizionale formula d’esordio “Egregi Signori e Gentili Signore”.»
- Nota del verificatore: The directive's symmetry rule also weighs against the code's own unnamed form (two different adjectives); the table lists this claim under «matches» without saying so.

### IT19 (T1) — verifica: confirmed

A letter of the Ticino Consiglio di Stato (17.10.2025) opens with «Gentili signore, egregi signori,», continues in lower case, and uses the singular «Allegato:» for one enclosure.

- Fonte: Repubblica e Cantone Ticino – Consiglio di Stato — <https://www4.ti.ch/fileadmin/POTERI/CdS/procedure_di_consultazione_federale/2025/25_5034_DI_Ordinanza_sull_Id-e.pdf>
- Citazione: «Gentili signore, egregi signori, … abbiamo ricevuto la vostra lettera del 20 giugno 2025 in merito alla summenzionata procedura di consultazione … Allegato: - Modulo di risposta per la procedura di consultazione»

### FR01 (T1) — verifica: confirmed

orientation.ch: «Madame,» or «Monsieur,» (without the surname) when the addressee is known, «Madame, Monsieur,» when not.

- Fonte: CSFO/SDBB – orientation.ch — <https://www.orientation.ch/fr/ecrire-une-lettre-de-motivation>
- Citazione: «(si tu sais à qui tu t'adresses) … Madame, Monsieur, … (mettre les deux si le destinataire précis n'est pas connu)»

### FR02 (T1) — verifica: confirmed

orientation.ch: place of residence and date with «le»; the apprenticeship subject reads «Candidature pour la place d'apprentissage de …» and may be bold.

- Fonte: CSFO/SDBB – orientation.ch — <https://www.orientation.ch/fr/ecrire-une-lettre-de-motivation>
- Citazione: «Cornaux, le 16 mars 2026 … Candidature pour la place d'apprentissage de … L'intitulé peut être mis en caractères gras.»

### FR03 (T1) — verifica: confirmed

orientation.ch lists «Meilleures salutations» as the closing, then the handwritten or scanned signature, then the enclosures.

- Fonte: CSFO/SDBB – orientation.ch — <https://www.orientation.ch/fr/ecrire-une-lettre-de-motivation>
- Citazione: «Salutations … Meilleures salutations … Signature manuscrite. … Liste des pièces jointes: CV, copie des certificats, copie des rapports de stage, etc.»
- Nota del verificatore: This is the page's own list: the bare «Meilleures salutations» the code prints today.

### FR04 (T1) — verifica: confirmed

CSFO example letter 1: date at the left margin with «le», subject with elision («d’agente»), «Madame,» followed by a capital, and the closing as a full sentence that repeats the salutation.

- Fonte: CSFO/SDBB – example letter — <https://media.sdbb.ch/asset/808d9e83-4c34-4734-a734-97983a0fb92f/Exemple-de-lettre-1-Levicia.pdf>
- Citazione: «Morges, le 11 mars 2026 … Candidature à une place d’apprentissage d’agente d’exploitation CFC … Madame, … Permettez-moi tout d’abord de vous remercier … je vous prie de recevoir, Madame, mes meilleures salutations.»

### FR05 (T1) — verifica: confirmed

CSFO example letter 2 (no named contact): «Madame, Monsieur,», a closing sentence that repeats it, and «Annexes :» with a space before the colon.

- Fonte: CSFO/SDBB – example letter — <https://media.sdbb.ch/asset/0debcc26-1174-422e-8121-fed3bba0a27f/Exemple-de-lettre-2-Emirhan.pdf>
- Citazione: «Madame, Monsieur, … Dans l’attente de votre réponse, je vous prie de recevoir, Madame, Monsieur, mes salutations les meilleures. … Annexes :»

### FR06 (T1) — verifica: confirmed

CSFO fill-in template (DOCX): «Lieu, date» is not indented (left margin); the recipient and the signature are indented to the right (w:ind left 4248 + firstLine 708 twips, read in the file's XML); the closing is a sentence in the body.

- Fonte: CSFO/SDBB – model letter — <https://media.sdbb.ch/asset/0090f850-1d2a-4eeb-ab79-10ddf1e53fd1/Exemple-de-lettre-a-completer.docx>
- Citazione: «Lieu, date … Madame [ou] Monsieur, [ou] Madame, Monsieur, … Dans l’attente de nouvelles de votre part, je vous prie de recevoir, Madame [ou] Monsieur, [ou] Madame, Monsieur, mes meilleures salutations.»
- Nota del verificatore: Read in the DOCX XML. Page margin left = 1418 twips = 25.0 mm.

### FR07 (T1) — verifica: confirmed

Canton Vaud (OCOSP), structure of a letter: recipient, «LIEU + DATE» and signature on a 9 cm tab (right-hand side), salutation «Madame ou Monsieur ou Madame, Monsieur,», enclosures under «ANNEXES».

- Fonte: Canton de Vaud – OCOSP — <https://www.vd.ch/fileadmin/user_upload/themes/formation/orientation/fichiers_pdf/apprentissage/Recherche_place_apprentissage_p11.pdf>
- Citazione: «Tabulation à 9 cm … LIEU + DATE … FORMULE D’APPEL … Madame ou Monsieur ou Madame, Monsieur, … SIGNATURE (à la main) … ANNEXES»
- Nota del verificatore: The subject on this sheet is «Votre offre de place d’apprentissage pour le métier de».

### FR08 (T1) — verifica: confirmed

Canton Vaud: the closing is a sentence that repeats the salutation and ends with «mes meilleures salutations».

- Fonte: Canton de Vaud – OCOSP — <https://www.vd.ch/fileadmin/user_upload/themes/formation/orientation/fichiers_pdf/apprentissage/Recherche_place_apprentissage_p11.pdf>
- Citazione: «Dans l’attente de votre réponse et en vous remerciant pour votre attention, je vous prie, Madame, Monsieur, de recevoir mes meilleures salutations.»

### FR09 (T1) — verifica: confirmed

Canton Vaud, e-mail example in the apprenticeship brochure (2026 file): «Madame, Monsieur,» followed by a capital, and the same closing sentence in the e-mail.

- Fonte: Canton de Vaud – OCOSP — <https://www.vd.ch/fileadmin/user_upload/themes/formation/orientation/fichiers_pdf/publications/rechappr.pdf>
- Citazione: «Madame, Monsieur, Vous trouverez ci-joint mon dossier de candidature pour la place d’apprentissage de… … Dans l’attente de vos nouvelles je vous prie de recevoir, Madame, Monsieur, mes meilleures salutations.»
- Nota del verificatore: Brochure of April 2024, reprint 2026.

### FR10 (T1) — verifica: confirmed

SECO leaflet «Le dossier de candidature» (716.209.f, 08.2018), sample letter of an adult: date with «le», «Madame,», closing sentence with «sentiments distingués», singular «Annexe:» for one enclosure.

- Fonte: SECO (leaflet 716.209.f), copy hosted by the Canton of Jura — <https://www.jura.ch/Htdocs/Files/v/d25f75e424261a6e94073f84c61dd56d6afd5f1fb6fb506aaa375b479473ceeb.pdf/Brochure-le-dossier-de-candidature-716_209_f.pdf?download=1>
- Citazione: «Villemodèle, le 22 octobre 2007 … Madame, à l’assurance de mes sentiments distingués. … Annexe: dossier de candidature»
- Nota del verificatore: Leaflet 716.209.f, 08.2018 (sample letter dated 2007). Every block of the sample starts at the same left edge.

### FR11 (T1) — verifica: confirmed

SECO brochure (French): an application e-mail begins with «Madame/Monsieur» and ends with a classic formula such as «Sincères salutations» (sentence rejoined across the line breaks of a two-column PDF).

- Fonte: SECO – arbeit.swiss, «Qu’est-ce qu’une bonne candidature ?» (711.253.f, 02.2018) — <https://www.arbeit.swiss/api/media/fileservice/sdweb-docs-prod-arbeitswiss-files/files/2026/07/09/5f476989-18b8-4a22-ab63-a7bddb9f0473.pdf>
- Citazione: «commencera par « Madame/Monsieur» et s’achèvera par une formule de politesse classique (p. ex. « Sincères salutations »).»

### FR12 (T1) — verifica: confirmed

SECO brochure (French) recommends a direct style rather than «Je serais heureux …».

- Fonte: SECO – arbeit.swiss, «Qu’est-ce qu’une bonne candidature ?» — <https://www.arbeit.swiss/api/media/fileservice/sdweb-docs-prod-arbeitswiss-files/files/2026/07/09/5f476989-18b8-4a22-ab63-a7bddb9f0473.pdf>
- Citazione: «Style direct (p. ex. « Vous remerciant de l’attention que vous voudrez bien porter à ma candidature … » plutôt que : « Je serais heureux … »)»

### FR13 (T1) — verifica: confirmed

SECO's French examples of an e-mail subject: «Candidature pour le poste de …» and «… au poste d’assistante» (with elision), combining the post and the candidate's name.

- Fonte: SECO – arbeit.swiss, «Qu’est-ce qu’une bonne candidature ?» — <https://www.arbeit.swiss/api/media/fileservice/sdweb-docs-prod-arbeitswiss-files/files/2026/07/09/5f476989-18b8-4a22-ab63-a7bddb9f0473.pdf>
- Citazione: «« Candidature pour le poste de responsable à 50 %, en réponse à votre annonce parue dans Le Temps ». Ou : « Dossier de candidature de Sarah Meier au poste d’assistante»

### FR14 (T1) — verifica: confirmed

Federal Chancellery table of forms of address: to a private person «Monsieur,» / «Madame,» with «salutations distinguées»; to a company «Mesdames et Messieurs,» with «salutations distinguées» (cells of one table, in reading order).

- Fonte: Chancellerie fédérale – «Formules d'appel et de salutations avec modèles d'adresses» (2011) — <https://www.bk.admin.ch/dam/fr/sd-web/HSAaOyOLuVnw/objekt_29794.pdf>
- Citazione: «Monsieur, Madame, … salutations distinguées … Voyages organisés (Suisse) S.A. Rue de Lausanne 37A 1201 Genève … Mesdames et Messieurs, … salutations distinguées»
- Nota del verificatore: PDF dated 15 April 2011.

### FR15 (T1) — verifica: confirmed

Federal Chancellery instructions for French texts (May 2016): a date is written «le 23 janvier 2016»; the ordinal of the first is «1er».

- Fonte: Chancellerie fédérale – Instructions sur la présentation des textes officiels en français — <https://www.bk.admin.ch/dam/fr/sd-web/t4P98Y1Vnyz-/objekt_55266.pdf>
- Citazione: «le 23 janvier 2016, les années 50 (et non les années cinquante) … On écrit 1er qui donne 1re au féminin ; 2e, 3e, 4e, etc., sans changement au féminin.»
- Nota del verificatore: Weak for the date line: «le 23 janvier 2016» is an example in the chapter on writing numbers in figures, and «1er» is the general rule on ordinals. The «le» of the date line rests on FR02, FR04 and FR10.

### FR16 (T1) — verifica: confirmed

Same instructions: a no-break space separates a number from what follows, the % sign included.

- Fonte: Chancellerie fédérale – Instructions sur la présentation des textes officiels en français — <https://www.bk.admin.ch/dam/fr/sd-web/t4P98Y1Vnyz-/objekt_55266.pdf>
- Citazione: «pour séparer les nombres des termes ou des abréviations qui les suivent ou les précèdent … 10 heures, 50 francs, 18 janvier 33 millions 3 %, 10 kg»

### FR17 (T1) — verifica: confirmed

Federal Chancellery, guide to inclusive French (2nd edition 2023): a person's full name followed by a comma is not a correct salutation in French.

- Fonte: Chancellerie fédérale – «Pour un usage inclusif du français dans les textes de la Confédération» — <https://www.bk.admin.ch/dam/fr/sd-web/Ahh8btiPHjjS/leitfaden-geschlechtergerechte-sprache.pdf>
- Citazione: «Le nom complet d’une personne, suivi d’une virgule, ne respecte pas les règles du français courant.»

### FR18 (T2) — verifica: confirmed

jobup.ch advises addressing the contact by name and its sample letter writes «Madame Modèle,»; its date has «le» and its subject shows the elision and a reference in brackets.

- Fonte: jobup.ch (JobCloud) — <https://www.jobup.ch/fr/job-coach/conseils-checklistes/lettre-de-motivation-exemples-et-structure/>
- Citazione: «Adressez-vous directement à votre interlocuteur en utilisant son nom, si vous le connaissez. … Genève, le 6 février 2026 … Candidature au poste d’infirmière diplômée en chirurgie interdisciplinaire (numéro de référence 12345) … Madame Modèle,»

### FR19 (T2) — verifica: confirmed

jobup.ch: closing formula for a qualified candidate «Veuillez agréer mes meilleures salutations».

- Fonte: jobup.ch (JobCloud) — <https://www.jobup.ch/fr/job-coach/conseils-checklistes/lettre-de-motivation-exemples-et-structure/>
- Citazione: «ajoutez une formule de politesse cordiale, telle que « Veuillez agréer mes meilleures salutations » et votre nom.»

### FR20 (T1) — verifica: confirmed

The official CSFO example letter itself uses the conditional «Je serais très heureuse de …» that SECO advises against.

- Fonte: CSFO/SDBB – example letter — <https://media.sdbb.ch/asset/808d9e83-4c34-4734-a734-97983a0fb92f/Exemple-de-lettre-1-Levicia.pdf>
- Citazione: «Je serais très heureuse de vous rencontrer pour un entretien ou un stage d’observation»
- Nota del verificatore: Example 3 of the same series has «Je serais ravie de venir me présenter…», which the code's pattern does match; example 1 is not matched because of «très».

### DE01 (T1) — verifica: confirmed

berufsberatung.ch: «Sehr geehrte Frau …» / «Sehr geehrter Herr …» with the name, «Sehr geehrte Damen und Herren» when the name is not known.

- Fonte: SDBB – berufsberatung.ch — <https://www.berufsberatung.ch/de/bewerbungsbrief-schreiben>
- Citazione: «Sehr geehrte Frau Muster / Sehr geehrter Herr Muster … Sehr geehrte Damen und Herren, wenn du den Namen der zuständigen Person nicht kennst»

### DE02 (T1) — verifica: confirmed

berufsberatung.ch: closing «Freundliche Grüsse», then signature and name; the enclosures are listed as «Beilagen».

- Fonte: SDBB – berufsberatung.ch — <https://www.berufsberatung.ch/de/bewerbungsbrief-schreiben>
- Citazione: «Freundliche Grüsse, digitale Unterschrift, dein Vor- und Nachname. … Liste die Beilagen auf. Bei Platzmangel kannst du auch nur «Bewerbungsunterlagen» schreiben.»

### DE03 (T1) — verifica: confirmed

berufsberatung.ch: place of residence and date; the subject is bold and, for an apprenticeship, reads «Bewerbung um die Lehrstelle als …».

- Fonte: SDBB – berufsberatung.ch — <https://www.berufsberatung.ch/de/bewerbungsbrief-schreiben>
- Citazione: «Nenne deinen Wohnort und das Datum. … Bewerbung um die Lehrstelle als … Der Betreff wird fett formatiert.»

### DE04 (T1) — verifica: confirmed

SDBB example letter (DOCX, no paragraph is indented: every block is at the left margin): «Aarau, 11. Februar 2026», salutation without a comma, next line with a capital, «Freundliche Grüsse» without a comma, «Beilagen:».

- Fonte: SDBB – example letter (2026) — <https://media.sdbb.ch/asset/fec44651-2e46-42e7-b639-0c3dadb0941e/Bewerbungsbrief-zum-Ausfullen.docx>
- Citazione: «Aarau, 11. Februar 2026 … Sehr geehrte Frau Zaugg … Besten Dank für Ihre telefonische Auskunft. … Freundliche Grüsse … Beilagen:»
- Nota del verificatore: No paragraph has an indent in the DOCX XML. Page margin left = 1440 twips = 25.4 mm.

### DE05 (T1) — verifica: confirmed

SDBB example letter 2: the recipient is a department («Personalabteilung») and the salutation is «Sehr geehrte Damen und Herren», without a comma and followed by a capital.

- Fonte: SDBB – example letter (2026) — <https://media.sdbb.ch/asset/8e21ff33-bc10-496b-8aac-b633154c521b/Vorlage-Bewerbungsbrief-2-Elias.pdf>
- Citazione: «Personalabteilung … Sehr geehrte Damen und Herren … Gerne bewerbe ich mich um Ihre Lehrstelle»

### DE06 (T1) — verifica: confirmed

BIZ Kanton Bern (adults): address the contact by name, for example «Guten Tag Frau Frei», and end with a positive sentence without the conditional.

- Fonte: BIZ Kanton Bern – «Tipps für das Bewerbungsdossier» (M051, 08.2025) — <https://www.biz.bkd.be.ch/content/dam/biz_bkd/dokumente/de/angebote/informationsangebote/biz-publikationen/infoblaetter-und-broschueren/stellensuche-berufseinstieg-praktikum/m051-bewerbungsdossier-erwachsene.pdf>
- Citazione: «Sprechen Sie die Kontaktperson mit ihrem Namen an («Guten Tag Frau Frei»). … Schliessen Sie mit einem konkreten, positiven Satz (kein Konjunktiv wie «würde»).»
- Nota del verificatore: «Guten Tag Frau Frei» is honorific plus surname: for a named contact this source differs from the code's «Sehr geehrte Frau …».

### DE07 (T1) — verifica: confirmed

BIZ Kanton Bern lists three stock phrases to avoid.

- Fonte: BIZ Kanton Bern – «Tipps für das Bewerbungsdossier» — <https://www.biz.bkd.be.ch/content/dam/biz_bkd/dokumente/de/angebote/informationsangebote/biz-publikationen/infoblaetter-und-broschueren/stellensuche-berufseinstieg-praktikum/m051-bewerbungsdossier-erwachsene.pdf>
- Citazione: «Vermeiden Sie Floskeln und formelle Sprache wie «Hiermit bewerbe ich mich…», «Mit Interesse habe ich gelesen…», «Ich suche eine neue Herausforderung…».»

### DE08 (T1) — verifica: confirmed

BIZ Kanton Bern: German (not Swiss) spellings such as the sharp s stand out in a Swiss application (the leaflet prints the Greek letter β for ß).

- Fonte: BIZ Kanton Bern – «Tipps für das Bewerbungsdossier» — <https://www.biz.bkd.be.ch/content/dam/biz_bkd/dokumente/de/angebote/informationsangebote/biz-publikationen/infoblaetter-und-broschueren/stellensuche-berufseinstieg-praktikum/m051-bewerbungsdossier-erwachsene.pdf>
- Citazione: «Es fällt auf, wenn Sie deutsche statt Schweizer Schreibweisen verwenden (z.B. β statt ss oder den Lebenslauf datieren/unterschreiben).»

### DE09 (T1) — verifica: confirmed

BIZ Kanton Bern letter template: «Guten Tag Frau/Herr Nachname», «Freundliche Grüsse», enclosures optional; e-mail subject «Bewerbung als XY»; «Sehr geehrte Damen und Herren» only as a last resort.

- Fonte: BIZ Kanton Bern – «Tipps für das Bewerbungsdossier» — <https://www.biz.bkd.be.ch/content/dam/biz_bkd/dokumente/de/angebote/informationsangebote/biz-publikationen/infoblaetter-und-broschueren/stellensuche-berufseinstieg-praktikum/m051-bewerbungsdossier-erwachsene.pdf>
- Citazione: «Guten Tag Frau/Herr Nachname … Freundliche Grüsse … Optional: Beilagen erwähnen … Aussagekräftige Betreffzeile «Bewerbung als XY» − Persönliche Anrede, nur im Notfall «Sehr geehrte Damen und Herren»»

### DE10 (T1) — verifica: confirmed

SECO brochure (German): the application e-mail begins with «Sehr geehrte/r Frau/Herr …» and ends with a usual formal greeting, for example «Mit freundlichen Grüssen».

- Fonte: SECO – arbeit.swiss, «Wie bewerbe ich mich richtig?» — <https://www.arbeit.swiss/api/media/fileservice/sdweb-docs-prod-arbeitswiss-files/files/2026/06/03/06ed7935-ac82-4aa8-a2a6-29ae54ce9f2f.pdf>
- Citazione: «Die Bewerbungs-E-Mail beginnt mit «Sehr geehrte/r Frau/Herr ...» und endet mit einem üblichen, formellen Gruss (z. B. «Mit freundlichen Grüssen»).»

### DE11 (T1) — verifica: confirmed

SECO brochure (German): direct language instead of «Ich würde mich freuen …»; e-mail subject examples name the post, or the dossier with the candidate's name (first sentence rejoined across a line break).

- Fonte: SECO – arbeit.swiss, «Wie bewerbe ich mich richtig?» — <https://www.arbeit.swiss/api/media/fileservice/sdweb-docs-prod-arbeitswiss-files/files/2026/06/03/06ed7935-ac82-4aa8-a2a6-29ae54ce9f2f.pdf>
- Citazione: «Direkte Sprache (z. B. «Ich freue mich, von Ihnen zu hören» und nicht: «Ich würde mich freuen …») … «Bewerbung als Sachbearbeiterin 50 %, Ihr Stelleninserat in der Südostschweiz» oder «Bewerbungsdossier von Sarah Meier als Praxisassistentin»»

### DE12 (T1) — verifica: confirmed

Federal Chancellery leaflet on official letters: «Sehr geehrte Frau …» with «Freundliche Grüsse» is the safe pair.

- Fonte: Schweizerische Bundeskanzlei – Merkblatt Behördenbriefe (Langfassung) — <https://www.bk.admin.ch/dam/de/sd-web/XWeMahlRYRh8/merkblatt-behoerdenbriefe-langfassung.pdf>
- Citazione: «Mit der höflichen Anrede «Sehr geehrte Frau Kunz» und der Grussformel «Freundliche Grüsse» können Sie kaum fehlgehen.»
- Nota del verificatore: Scope: letters from authorities to private persons.

### DE13 (T1) — verifica: confirmed

Federal Chancellery spelling guide (4th edition 2017): the ß is not written in Switzerland; double s replaces it.

- Fonte: Schweizerische Bundeskanzlei – Leitfaden zur deutschen Rechtschreibung — <https://www.bk.admin.ch/dam/de/sd-web/GApRW2tzdhqZ/rechtschreibleitfaden-2017.pdf>
- Citazione: «Dieser Buchstabe wurde in der Schweiz seit den 1950er-Jahren langsam verdrängt und wird seit den 1970er-Jahren nicht mehr geschrieben. Man schreibt stattdessen Doppel-s: ss.»

### DE14 (T1) — verifica: confirmed

Federal Chancellery Schreibweisungen: dates run day / month / year with the month written out («2. September 2006»).

- Fonte: Schweizerische Bundeskanzlei – Schreibweisungen (2. Auflage 2013, korr. 2015) — <https://www.bk.admin.ch/dam/de/sd-web/YVHazXZRkqKn/schreibweisungen.pdf>
- Citazione: «In Texten ist die Reihenfolge für Daten: Tag / Monat / Jahr. … 2. September 2006»

### DE15 (T1) — verifica: confirmed

Federal Chancellery Schreibweisungen (n. 554): a fixed (no-break) space stands between a figure and the % sign.

- Fonte: Schweizerische Bundeskanzlei – Schreibweisungen — <https://www.bk.admin.ch/dam/de/sd-web/YVHazXZRkqKn/schreibweisungen.pdf>
- Citazione: «Nach Ziffern folgt ein Festabstand … damit Ziffern und dazugehöriges Begriffszeichen beim Zeilensprung nicht auseinandergerissen werden»
- Nota del verificatore: The quoted sentence goes on «(Ausnahme: in Zusammensetzungen → 555)». N. 555 forbids the space in compounds, and the code inserts it there.

### DE16 (T1) — verifica: confirmed

Federal Chancellery guide to gender-fair German (3rd edition 2023, as of 13.6.2024), n. 59: when the name does not show the gender, «Guten Tag» with first name and surname is suitable.

- Fonte: Schweizerische Bundeskanzlei – Leitfaden «Geschlechtergerechte Sprache» — <https://www.bk.admin.ch/dam/de/sd-web/Ahh8btiPHjjS/leitfaden-geschlechtergerechte-sprache.pdf>
- Citazione: «Für nichtbinäre Personen und Personen, deren Name keine Rückschlüsse auf das Geschlecht zulässt, kann sich die Anrede mit Guten Tag eignen: … Guten Tag Kim Müller»

### DE17 (T1) — verifica: confirmed

University of Fribourg course material (not a career service): in German-speaking Switzerland no comma follows the salutation and the next sentence starts with a capital; academic titles are kept in the salutation.

- Fonte: Universität Freiburg – course material «Tipps für den E-Mail-Verkehr» (B. Etterich, 2021) — <https://moodle.unifr.ch/pluginfile.php/1943922/mod_resource/content/1/Offizielle%20E-Mails.pdf>
- Citazione: «Titel nicht vergessen. … Sehr geehrte Frau Dr. Müller … In der Deutschschweiz steht nach der Anrede kein Komma und man beginnt den nächsten Satz gross: Sehr geehrte Frau Professorin Vielen Dank für Ihre rasche Antwort.»
- Nota del verificatore: Tier too high: a lecturer's course handout on the university Moodle (PDF of 16 March 2021), not a guideline of the institution. T2 at most.

### DE18 (T1) — verifica: confirmed

UZH Career Services (German page): subject «Bewerbung als …» without the word «Betreff»; place and date left or right; the three standard salutations; closing «Freundliche Grüsse».

- Fonte: Universität Zürich – Career Services — <https://www.careerservices.uzh.ch/de/ratgeber/bewerbung/bewerbungsdossier/Anschreiben.html>
- Citazione: «Betreffzeile: «Bewerbung als …» (ohne das Wort «Betreff») … Ort und Datum (links oder rechts) … (z.B. «Sehr geehrte Frau …», «Sehr geehrter Herr …», «Sehr geehrte Damen und Herren») … Schlussformel (z.B. «Freundliche Grüsse»).»

### DE19 (T1) — verifica: confirmed

UZH Career Services (German page): avoid the conditional «würde mich freuen, wenn…»; the formal «Sie» stays standard even when the posting uses «du».

- Fonte: Universität Zürich – Career Services — <https://www.careerservices.uzh.ch/de/ratgeber/bewerbung/bewerbungsdossier/Anschreiben.html>
- Citazione: «Vermeide: zu vorsichtige Formulierungen im Konjunktiv («würde mich freuen, wenn…»); formuliere klar und positiv. … Im Motivationsschreiben selbst ist die formelle Sie‑Anrede nach wie vor Standard, auch wenn das Unternehmen dich im Inserat duzt.»

### DE20 (T1) — verifica: confirmed

Canton Thurgau writing rules (2021): letters of departments and offices close with «Freundliche Grüsse» or «Mit freundlichen Grüssen».

- Fonte: Kanton Thurgau – Schreibweisungen für die Kantonale Verwaltung — <https://weiter.tg.ch/mod/resource/view.php?id=3149>
- Citazione: «Interne und externe Schreiben der Departemente und Ämter: Freundliche Grüsse oder Mit freundlichen Grüssen»
- Nota del verificatore: The URL redirects to the PDF dated 25 March 2021.

### DE21 (T2) — verifica: confirmed

KV Schweiz: the letter ends with «Freundliche Grüsse», signature and name; in a right-addressed letter the closing block is on the right at 117 mm.

- Fonte: Kaufmännischer Verband Schweiz — <https://www.kfmv.ch/wissen/berufsalltag/praxistipps/professionelle-briefe-schreiben>
- Citazione: «Schreiben Sie zum Schluss: «Freundliche Grüsse». Setzen Sie Ihre Unterschrift und Ihren Namen darunter. … (Bei Rechtsadressierung ist der Schluss üblicherweise rechts, 117 mm von links.)»
- Nota del verificatore: The bracketed sentence contradicts proposed change 5 for a bare closing line.

### DE22 (T2) — verifica: confirmed

KV Schweiz measures: left margin 26–30 mm, right 15–20 mm; first address line 52 mm from the top; left addressing starts at 26 mm, right addressing at 117 mm.

- Fonte: Kaufmännischer Verband Schweiz — <https://www.kfmv.ch/wissen/berufsalltag/praxistipps/professionelle-briefe-schreiben>
- Citazione: «Der linke Rand ist 26-30mm breit, der rechte 15-20mm. … Die erste Zeile der Adresse des Adressaten beginnt 52mm von oben. … Linksadressierungen beginnen 26mm von links, Rechtsadressierungen 117mm von links.»

### DE23 (T2) — verifica: confirmed

Verlag SKV (sample letter after SN 010 130): left addressing prevails in Switzerland; greeting and enclosure note are at the left margin too.

- Fonte: Verlag SKV – «Regeln Computerschreiben» (preview) — <https://verlagskv.ch/wp-content/uploads/blick-ins-buch/regeln_computerschreiben_22a_blick_ins_buch_1.pdf>
- Citazione: «In der Schweiz hat sich die Linksadressierung weitgehend durchgesetzt; neben der Adresse befinden sich auch der Gruss und der Beilagevermerk am linken Textrand.»
- Nota del verificatore: The same preview captions the right-addressed SNV sample «Adresse rechts, … Briefschluss rechts».

### DE24 (T2) — verifica: confirmed

jobs.ch names as worn-out sentences an opening with «Mit grossem Interesse bin ich …» and a closing with the inverted conditional «… würde ich mich sehr freuen».

- Fonte: jobs.ch (JobCloud) — <https://www.jobs.ch/de/job-coach/anschreiben-floskeln-beispiele/>
- Citazione: «„Mit grossem Interesse bin ich auf Ihr Stelleninserat gestossen.“ … „Über eine Einladung zu einem Vorstellungsgespräch würde ich mich sehr freuen.“»

### EN01 (T1) — verifica: confirmed

Federal Chancellery English Style Guide (2016), section 18: «Dear Sir or Madam» pairs with «Yours faithfully», «Dear Mr/Ms/Dr Smith» with «Yours sincerely».

- Fonte: Swiss Federal Chancellery – English Language Service, Style Guide — <https://www.bk.admin.ch/dam/de/sd-web/bD27v9UrK3X3/NEU_English%2BStyle%2BGuide.pdf>
- Citazione: «Addressee unknown: Dear Sir or Madam or To whom it may concern ... Yours faithfully … Addressee known: Dear Mr/Ms/Dr Smith ... Yours sincerely»
- Nota del verificatore: The quote is in the 2016 edition at the cited URL. That edition is superseded: the Chancellery's English page offers the third edition (September 2024), which keeps the two pairs and adds Mx.

### EN02 (T1) — verifica: confirmed

Same guide: «Kind regards» or «Best regards» belong to informal communication and should generally be avoided in formal letters.

- Fonte: Swiss Federal Chancellery – English Language Service, Style Guide — <https://www.bk.admin.ch/dam/de/sd-web/bD27v9UrK3X3/NEU_English%2BStyle%2BGuide.pdf>
- Citazione: «Kind regards or Best regards … However, this should generally be avoided in formal letters.»
- Nota del verificatore: Only in the superseded 2016 edition. The 2024 edition no longer has «should generally be avoided in formal letters»; it pairs «Dear Jane … Kind regards» and «Dear Ms/Mr/Mx/Dr Smith … Yours sincerely».

### EN03 (T1) — verifica: confirmed

Same guide: «Ms» is the default title for a woman; «Mr» or «Ms» may be used only when the gender is certain.

- Fonte: Swiss Federal Chancellery – English Language Service, Style Guide — <https://www.bk.admin.ch/dam/de/sd-web/bD27v9UrK3X3/NEU_English%2BStyle%2BGuide.pdf>
- Citazione: «As a matter of courtesy, use Ms in English unless you know the person concerned prefers otherwise … if you use Mr or Ms, you must obviously be sure of the gender of the person in question.»
- Nota del verificatore: Unchanged in the 2024 edition.

### EN04 (T1) — verifica: confirmed

Same guide: no space before the % sign; dates as day, month written out, year, without «th».

- Fonte: Swiss Federal Chancellery – English Language Service, Style Guide — <https://www.bk.admin.ch/dam/de/sd-web/bD27v9UrK3X3/NEU_English%2BStyle%2BGuide.pdf>
- Citazione: «With figures, use the per cent sign (%) with no space. … Dates. Write out the month, preceded by a simple figure for the day (no th etc.). … 25 July 2007»
- Nota del verificatore: Unchanged in the 2024 edition (it adds a hard space inside the date).

### EN05 (T1) — verifica: confirmed

Same guide: the title «Dr» is kept when the original gives it.

- Fonte: Swiss Federal Chancellery – English Language Service, Style Guide — <https://www.bk.admin.ch/dam/de/sd-web/bD27v9UrK3X3/NEU_English%2BStyle%2BGuide.pdf>
- Citazione: «Doctor. The title Dr should be given when it appears in the original (except in combined titles, as above), regardless of whether the holder is a doctor of medicine or not.»
- Nota del verificatore: The 2024 edition adds «As it is a contraction, there is no final point.»

### EN06 (T1) — verifica: confirmed

UZH Career Services (English page): salutations «Dear Ms …», «Dear Mr …», «Dear Sir or Madam»; closing for example «Kind regards».

- Fonte: University of Zurich – Career Services — <https://careerservices.uzh.ch/en/ratgeber/bewerbung/bewerbungsdossier/Anschreiben.html>
- Citazione: «Salutation: try to find the specific contact person (for example «Dear Ms …», «Dear Mr …», «Dear Sir or Madam») … Closing phrase (for example «Kind regards»)»

### EN07 (T1) — verifica: confirmed

UZH Career Services (English page): employer's address on the left, subject «Application for …» without the word «Subject», place and date left or right.

- Fonte: University of Zurich – Career Services — <https://careerservices.uzh.ch/en/ratgeber/bewerbung/bewerbungsdossier/Anschreiben.html>
- Citazione: «Below on the left (with some space): name and (optional) full address of the employer or the contact person … Subject line: «Application for …» (without the word «Subject») … Place and date (left or right)»

### EN08 (T1) — verifica: confirmed

UZH Career Services (English page): avoid the conditional «I would be happy if…» in the closing.

- Fonte: University of Zurich – Career Services — <https://careerservices.uzh.ch/en/ratgeber/bewerbung/bewerbungsdossier/Anschreiben.html>
- Citazione: «Avoid: language that is too careful and uses the conditional («I would be happy if…»); write in a clear and positive way.»

### EN09 (T1) — verifica: confirmed

University of Basel (English page): subject in bold without the word «subject»; closing «Yours sincerely» or «Kind regards»; enclosures may be indicated.

- Fonte: University of Basel – Career Counseling — <https://www.unibas.ch/en/Studies/Advice-and-Support/Career-Counseling/Counseling/Tips-for-Applications-and-Interviews.html>
- Citazione: «Subject (highlighted in bold, but the term "subject" is not written) … Greeting ("Yours sincerely"; "Kind regards") … possibly indication of enclosures»

### EN10 (T1) — verifica: confirmed

ZHAW Career Services (English page): when the name is not known, the formal salutation is «Dear Sir or Madam».

- Fonte: ZHAW School of Management and Law – Career Services — <https://career.sml.zhaw.ch/en/for-students/tips-and-tools/cv-and-letter-of-motivation/cover-letter/>
- Citazione: «Address your contact person directly. If you do not know their name, use the formal salutation: “Dear Sir or Madam”»

### EN11 (T1) — verifica: confirmed

Counselling centre of the Bern universities (English page): the attached documents are called «Enclosures».

- Fonte: Kanton Bern – Beratungsstelle der Berner Hochschulen — <https://www.bst.bkd.be.ch/en/start/themen/berufseinstieg-laufbahn/berufseinstieg/bewerbung.html>
- Citazione: «Enclosures (study diplomas, work references, language and other diplomas)»
- Nota del verificatore: It names the documents of the dossier, not a label printed at the foot of a letter.

## Raccomandazione del ricercatore

Most of what the code prints matches the Swiss institutional sources; 13 points differ and 5 are owner decisions where the sources themselves diverge. None of the proposed wordings adds a fact about the candidate.

HOW THIS WAS CHECKED
- Code read, not edited: assistedApplicationAiDraftCore.js, assistedApplicationAiPrompts.js, templates/assisted-letter.typ and assistedApplicationAiDocuments.js (legacy renderer) under functions/src/, plus scripts/assisted-application/lib/draft.mjs.
- The "code prints" column comes from running those functions read-only in node.
- Every quote was re-checked against a local copy of the page, PDF or DOCX in the study's scratch directory (scratch, outside the repositories). Inside a quote " … " marks an omission between verbatim fragments.

1. TABLE (element | code prints | sources say | verdict | claims)

GERMAN
- Salutation, no contact | «Sehr geehrte Damen und Herren» (no comma) | same form, no comma, next line capitalised | matches | DE01, DE05, DE17, DE18
- Salutation, contact with Frau/Herr | «Sehr geehrte Frau {Nachname}» / «Sehr geehrter Herr {Nachname}» (no comma; Dr./Prof. dropped) | same; one university source and the federal English guide keep the title | matches; title handling differs | DE01, DE04, DE12, DE17, EN05
- Salutation, contact without honorific | «Guten Tag {Vorname Nachname}» | Federal Chancellery: «Guten Tag Kim Müller» | matches | DE16, DE06
- Line after the salutation | left as the model wrote it (capital) | capital | matches | DE04, DE05, DE17
- Closing | «Freundliche Grüsse» (no comma) | same everywhere; «Mit freundlichen Grüssen» also accepted | matches | DE02, DE04, DE09, DE12, DE18, DE20, DE21, DE10
- Enclosures | «Beilagen: Lebenslauf, …» (plural even for one item) | «Beilagen» | matches; singular not sourced in German | DE02, DE04, DE09
- Subject | «Bewerbung als {Titel}», bold, no «Betreff» | same for adults; apprentices «Bewerbung um die Lehrstelle als …» | matches (qualified); differs (apprentice) | DE18, DE09, DE11, DE03
- Date | «{Ort}, 3. Oktober 2026» | «Aarau, 11. Februar 2026» | matches | DE04, DE14, DE03
- Typography | ß to ss; no-break space in «80 %» and after CHF | no ß; fixed space before % | matches | DE13, DE08, DE15
- Layout | all blocks left; left margin 25 mm; address line at 52 mm | all left; KV: margin 26–30 mm, address at 52 mm | matches (margin 1 mm under KV) | DE04, DE23, DE22, DE18
- Flags (advisory) | «hiermit bewerbe ich mich», «mit grossem Interesse habe ich», «ich würde mich (sehr) freuen», «neue Herausforderung», «Teamplayer» | the sources list these clichés, but the regexes miss «Mit Interesse habe ich gelesen», «Mit grossem Interesse bin ich …» and the inverted «würde ich mich sehr freuen» (checked by running the function) | differs (coverage) | DE07, DE06, DE11, DE19, DE24

FRENCH
- Salutation, no contact or name without honorific | «Madame, Monsieur,» | orientation.ch and Vaud: same; Federal Chancellery to a company: «Mesdames et Messieurs,»; a full name plus comma is not correct French | matches the career-service sources | FR01, FR05, FR07, FR14, FR17
- Salutation, contact with Madame/Monsieur | «Madame,» / «Monsieur,» (no surname) | institutional sources: same; jobup writes «Madame Modèle,» | matches T1; T2 diverges | FR01, FR04, FR10, FR14, FR18
- Line after the salutation | left as written (capital) | capital | matches | FR04, FR09
- Closing | bare «Meilleures salutations», in the right-hand block above the signature | orientation.ch lists it, but every model letter prints a sentence in the body that repeats the salutation; adult models use «sentiments distingués», «Sincères salutations», «salutations distinguées» | differs (form and place) | FR03, FR04, FR05, FR06, FR08, FR10, FR11, FR14, FR19
- Enclosures | «Annexes: CV, …» (plural even for one item) | «Annexes»; «Annexe:» for one | matches; singular differs | FR03, FR05, FR07, FR10
- Subject | «Candidature au poste de {titre}», no elision («de Infirmier/ère») | «au poste d’infirmière», «au poste d’assistante»; apprentices «Candidature pour la place d'apprentissage de …» | differs (elision; apprentice wording) | FR18, FR13, FR04, FR02
- Date | «{Lieu}, 3 octobre 2026»; on the 1st «1 mars 2026» | «Cornaux, le 16 mars 2026»; «1er» | differs | FR02, FR04, FR10, FR15
- Typography | no-break space in «80 %» | same | matches | FR16
- Layout | recipient, place and date, closing and signature at 117 mm | recipient and signature right; date right in Vaud, left in the CSFO template and examples | matches (recipient, signature); sources diverge (date) | FR06, FR07, FR04, DE22
- Flags (advisory) | «par la présente», «je me permets de», «nouveau défi», «je serais ravi/heureux de» | SECO advises against «Je serais heureux …»; the CSFO example uses it | sources diverge; the rest is not sourced | FR12, FR20

ITALIAN
- Salutation, no contact | «Gentili signore, egregi signori,» | orientamento.ch and the Consiglio di Stato: same; Chancellery also «Gentili Signore e Signori,»; Lugano «Gentili signori,» | matches | IT01, IT19, IT10, IT07, IT18
- Salutation, signora | «Gentile signora {Cognome},» | same | matches | IT01, IT08, IT10
- Salutation, signor | «Gentile signor {Cognome},» | Lugano: same; Chancellery: «Egregio / Gentile Signor»; orientamento.ch and SECO: «Egregio signor» | sources diverge | IT06, IT10, IT01, IT04, IT16
- Salutation, contact without honorific | «Gentile {Nome Cognome},» | Chancellery: «Gentile Mario Rossi, …» | matches | IT15
- First word after the comma | lower-cased only if it is one of 26 listed words; otherwise left to the model | always lower case; courtesy pronouns capital for the Chancellery and the SDBB model, lower case in Lugano and in the Consiglio di Stato letter | partly matches | IT09, IT04, IT06, IT07, IT19, IT13, IT05, IT08
- Closing | «Cordiali saluti», in the right-hand block | same wording in orientamento.ch, Lugano, Chancellery; SECO «Distinti saluti»; the models put it at the left margin | matches (wording); differs (place) | IT02, IT07, IT11, IT16, IT05
- Enclosures | «Allegati: Curriculum vitae, …» (plural even for one item) | «Allegati:»; «Allegato:» for one | matches; singular differs | IT02, IT05, IT07, IT06, IT19
- Subject | «Candidatura per la posizione di {titolo}» | SECO: same words; apprentices «Candidatura per un posto di apprendistato come …» | matches (qualified); differs (apprentice) | IT17, IT03
- Date | «{Luogo}, 3 ottobre 2026»; on the 1st «1 marzo 2026» | «Lugano, 15 marzo 2022»; «1° maggio 2019» | matches except the 1st | IT06, IT12
- Typography | protects an existing space before %, never inserts one («80%» stays) | protected space before % | differs (minor) | IT14, IT17
- Layout | recipient, place and date, signature right | same | matches | IT05, IT06
- Flags (advisory) | «con la presente», «mi pregio», «nuova sfida», «team player» | no Swiss source lists them | not sourced | none

ENGLISH
- Salutation, no contact | «Dear Sir or Madam,» | same | matches | EN01, EN06, EN10
- Salutation, contact with honorific | «Dear Ms {Surname},» / «Dear Mr {Surname},» (Dr dropped) | same; «Dr» kept when given | matches; title handling differs | EN01, EN03, EN05, EN06
- Salutation, contact without honorific | «Dear {First name Surname},» | no source prints this form; the federal guide only requires a known gender for Mr/Ms | consistent; form not sourced | EN03
- Closing | «Kind regards» (no comma) | UZH and Basel accept it; the federal guide prefers «Yours faithfully» / «Yours sincerely» in formal letters | sources diverge | EN06, EN09, EN01, EN02
- Enclosures | «Enclosures: CV, …» | «Enclosures» | matches | EN09, EN11
- Subject | «Application for the position of {title}» | «Application for …», bold, no «Subject» | matches | EN07, EN09
- Date | «{Place}, 3 October 2026» | «25 July 2007» | matches | EN04
- Layout and typography | all left; «25%» untouched | address left; no space before % | matches | EN07, EN04
- Flags (advisory) | «I am writing to», «team player», «perfect fit», «new challenge» | UZH: avoid «I would be happy if…» (not flagged) | not sourced | EN08

ALL LANGUAGES
- E-mail subject | «{subject} – {Name} ({reference})» | SECO examples combine post and name | matches | DE11, IT17, FR13, DE09
- E-mail body | salutation and closing are the model's; code only normalises ß and % | SECO gives the formulas per language | not guaranteed by code | DE10, FR11, IT16, DE17
- Length flags | under 150 or over 380 words (advisory); a placeholder blocks | sources say one A4 page, no word count | product's own proxy | none
- Prompt bans | filler openers, clichés, em dashes, salary, age, nationality, marital status, health, phone, e-mail, URL; German conditional in the closing sentence | conditional ban is sourced | matches | DE06, DE11, DE19

2. MISMATCHES AS CONCRETE CHANGES (my recommendations)
1. French date: print «{Lieu}, le 3 octobre 2026», and «le 1er mars 2026» on the first of the month. FR02, FR04, FR10, FR15
2. Italian date: print «1° marzo 2026» on the first of the month. IT12
3. French subject: write «d’» instead of «de» before a vowel or a mute h. FR18, FR13, FR04
4. French closing: print a sentence as the last body line, repeating the salutation actually printed: «Je vous prie de recevoir, Madame, Monsieur, mes meilleures salutations.» FR06, FR08, FR04, FR05
5. French and Italian layout: closing line at the left margin; only the signature stays in the right-hand block. FR06, IT05, IT07
6. Enclosure label in the singular when only the CV leaves: «Allegato», «Annexe» (by analogy «Beilage», «Enclosure»). IT06, IT19, FR10
7. Italian first word: lower-case by default instead of a word list, keeping the capital for an acronym or a proper noun found in the order line. IT09, IT04, IT19
8. German flags: use /mit (?:(?:sehr )?gro(?:ss|ß)em )?interesse (?:habe|bin) ich/i and /würde(?: ich)? mich (?:sehr )?freuen/i (both tested against the quoted phrases). DE07, DE24, DE19
9. Salutation input, four defects found by running letterSalutation:
   - a department as contact prints «Guten Tag Personalabteilung» instead of the unnamed form;
   - «Dr. med. Hans Muster» prints «Guten Tag med. Hans Muster»;
   - «Hr. Meier» / «Fr. Müller» are not read as Herr / Frau;
   - a bracket after the name stays in the salutation.
   DE05, DE17
10. Application e-mail: build its salutation and closing with the same functions as the letter, so German has no comma and Italian a lower-case start. DE10, DE17, FR09, FR11, IT16
11. Italian %: insert the no-break space as for German and French. IT14, IT17
12. Apprentice subject when candidateType is apprentice: «Bewerbung um die Lehrstelle als …», «Candidature pour la place d'apprentissage de …», «Candidatura per un posto di apprendistato come …». DE03, FR02, IT03
13. Left margin 26 mm instead of 25 mm (the right-hand column stays at 117 mm). DE22
Two side findings: the PDF subject line is not passed through swissTypography while the e-mail subject is, and the legacy renderer puts the recipient left and the date right in every language.

3. WHERE THE SOURCES DIVERGE (owner decision; today's output is defensible)
a. Italian male form: keep «Gentile signor» (Lugano, accepted by the Chancellery, symmetric as the Ticino directive asks) or switch to «Egregio signor» (orientamento.ch, SECO). I would keep it. IT06, IT10, IT18, IT01, IT16
b. French date position: I would move it to the left margin as in the national CSFO template; only Vaud puts it right. FR06, FR04, FR07
c. English closing: I would keep «Kind regards» (two career services name it for cover letters); the strictly formal pair is «Yours sincerely» with a name and «Yours faithfully» with «Dear Sir or Madam». EN06, EN09, EN01, EN02
d. Titles: I would keep «Dr.» / «Prof.» in the salutation when the posting gives both title and honorific. DE17, EN05
e. Italian courtesy pronouns: I would ask the model for lower case throughout, as in the Lugano models and as the code already lower-cases «le / la / vi»; the federal style is the capital. IT08, IT19, IT13, IT05

4. CORRECTIONS TO THE PRIOR STUDY (B.1 to B.4)
- «Gentili Signore e Signori» does appear in an institutional source (Federal Chancellery). IT10
- «Distinti saluti» does appear in a Swiss source (SECO's Italian brochure, for the e-mail). IT16
- The template comment says the official templates put place and date on the right in French; the CSFO template and its three examples put them on the left. FR06, FR04
- The KV left margin is 26–30 mm, not 25 mm. DE22

## Formulazioni e impostazioni proposte

### `salutation_no_contact`

- de: Sehr geehrte Damen und Herren (no comma, next line with a capital)
- fr: Madame, Monsieur,
- it: Gentili signore, egregi signori, (next line in lower case)
- en: Dear Sir or Madam,
- Vera quando: The posting names no contact person, or names only a department (HR, Personalabteilung, Ufficio del personale, Service du personnel).
- Base: DE01, DE05, FR01, FR07, IT01, IT19, EN01, EN10

### `salutation_contact_female`

- de: Sehr geehrte Frau {Nachname}
- fr: Madame,
- it: Gentile signora {Cognome},
- en: Dear Ms {Surname},
- Vera quando: The posting itself writes a female honorific before the contact's name (Frau, Fr., Madame, Mme, signora, sig.ra, Ms, Mrs). Never inferred from the first name.
- Base: DE01, DE12, FR01, FR14, IT01, IT10, EN01, EN03

### `salutation_contact_male`

- de: Sehr geehrter Herr {Nachname}
- fr: Monsieur,
- it: Gentile signor {Cognome}, (as printed today; orientamento.ch and SECO print: Egregio signor {Cognome},)
- en: Dear Mr {Surname},
- Vera quando: The posting itself writes a male honorific before the contact's name (Herr, Hr., Monsieur, M., signor, sig., Mr). Never inferred from the first name.
- Base: DE01, FR01, FR14, IT06, IT10, IT01, IT16, EN01

### `salutation_contact_without_honorific`

- de: Guten Tag {Vorname Nachname}
- fr: Madame, Monsieur,
- it: Gentile {Nome Cognome},
- en: Dear {First name Surname},
- Vera quando: The posting names a person without any honorific; the name is copied as the posting writes it, without titles or brackets.
- Base: DE16, FR17, IT15, EN03

### `closing`

- de: Freundliche Grüsse
- fr: Je vous prie de recevoir, Madame, Monsieur, mes meilleures salutations.
- it: Cordiali saluti
- en: Kind regards (strictly formal alternative: Yours sincerely with a name, Yours faithfully with Dear Sir or Madam)
- Vera quando: Always: the formula states no fact. In French the words between the commas must repeat the salutation actually printed (Madame / Monsieur / Madame, Monsieur).
- Base: DE02, DE12, FR06, FR08, IT02, IT11, EN06, EN09, EN01

### `enclosures_label_one`

- de: Beilage
- fr: Annexe
- it: Allegato
- en: Enclosure
- Vera quando: Exactly one document leaves with the letter (normally the CV).
- Base: IT06, IT19, FR10 (German and English singular by analogy, not sourced)

### `enclosures_label_several`

- de: Beilagen
- fr: Annexes
- it: Allegati
- en: Enclosures
- Vera quando: Two or more documents really leave with the letter; every item listed is a file actually attached.
- Base: DE02, DE04, FR03, FR05, IT02, IT07, EN09, EN11

### `place_and_date`

- de: {Wohnort}, 3. Oktober 2026
- fr: {Lieu}, le 3 octobre 2026
- it: {Luogo}, 3 ottobre 2026
- en: {Place}, 3 October 2026
- Vera quando: The place is the candidate's own place of residence as given in the profile (otherwise the date alone); the date is the day the letter is generated.
- Base: DE03, DE04, FR02, FR04, IT03, IT06, EN04

### `date_first_of_month`

- de: 1. März 2026
- fr: le 1er mars 2026
- it: 1° marzo 2026
- en: 1 March 2026
- Vera quando: The letter is generated on the first day of a month.
- Base: DE14, FR15, IT12, EN04

### `subject_qualified`

- de: Bewerbung als {Stellentitel}
- fr: Candidature au poste de {titre} (d’{titre} before a vowel or mute h)
- it: Candidatura per la posizione di {titolo}
- en: Application for the position of {title}
- Vera quando: The job title is copied from the posting.
- Base: DE18, DE09, FR18, FR13, IT17, EN07

### `subject_apprentice`

- de: Bewerbung um die Lehrstelle als {Beruf}
- fr: Candidature pour la place d'apprentissage de {profession} (d’{profession} before a vowel or mute h)
- it: Candidatura per un posto di apprendistato come {professione}
- en: (not sourced; keep: Application for the position of {title})
- Vera quando: candidateType is apprentice and the posting offers an apprenticeship place; the profession is copied from the posting.
- Base: DE03, FR02, FR04, IT03

### `email_salutation_and_closing`

- de: Same salutation as the letter, no comma, next line with a capital; Freundliche Grüsse
- fr: Madame, / Monsieur, / Madame, Monsieur, then the letter's closing sentence
- it: Same salutation as the letter, comma, lower-case start; Cordiali saluti
- en: Same salutation as the letter; Kind regards
- Vera quando: Same conditions as the letter's salutation; built by the same code, not by the model.
- Base: DE10, DE17, FR09, FR11, IT16

## Lacune dichiarate

- Geneva: ge.ch (dossier de candidature pour l'apprentissage dual) and the Cité des métiers du Grand Genève page on CV and letter were opened; neither states a salutation or a closing formula, and no Geneva model letter was found.
- German: no institutional source says in words that the closing takes no comma; every example simply omits it. The rule 'no comma after the salutation, next sentence capitalised' is stated in words only by University of Fribourg course material (DE17), which is not a career service; the Federal Chancellery's Schreibweisungen and Rechtschreibleitfaden only show examples.
- German and English: no source found for the singular label («Beilage:», «Enclosure:») with a single enclosure. The singular is attested for Italian (IT06, IT19) and French (FR10) only.
- English: no Swiss institutional source rules on a comma after the salutation or the closing, and none prints «Dear {First name Surname},» for a contact whose gender is unknown.
- Filler phrases: no Swiss institutional source lists the Italian or English phrases the code flags, nor the French «par la présente», «je me permets de», «nouveau défi». SECO's Italian brochure itself writes «nuove sfide professionali» and a conditional closing («Sarei felice di …»).
- Length: no source gives a word count; the sources say one A4 page. The 150 to 380 word thresholds are the product's own proxy.
- Ticino: no model application letter was found on ti.ch. The cantonal evidence is the 2022 inclusive-language directive and a 2025 letter of the Consiglio di Stato; the Città dei mestieri della Svizzera italiana was not found.
- Vaud: the adult guide (guide_postulation_adultes_WEB.pdf, opened) gives no salutation or closing formula; its example letters behind the QR code were not opened.
- E-mail body: what the model actually writes as salutation and closing in the application e-mail was not observed (no production access, by the rules of this task). The finding is only that the code does not fix them.
- SN 010130: the text of the standard is paid and was not read, as in the prior study; the measures rest on the KV Schweiz page (T2). Swiss Post was not consulted.
- The HSG sample cover letter (a PDF on a zhaw.ch host) could not be opened (DNS error), so its advice is not cited.
- French elision before h and before English job titles («Head of Sales») is my own rule of thumb, not a source statement; the sources only show the elision before vowels.
- Several Federal Chancellery documents are old: French forms of address 2011, Behördenbriefe 2010/2012, Schreibweisungen 2013/2015, French instructions and English Style Guide 2016, Rechtschreibleitfaden 2017. Only the Italian instructions (2023, as of 2025) and the inclusive-language guides (2023/2024) are recent.
