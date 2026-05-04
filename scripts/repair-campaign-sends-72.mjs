/** One-time: flags the 72 subscribers who received weekly_2026-05-04 but weren't captured by last_sent_at. */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const admin = (await import('firebase-admin')).default;
if (!admin.apps?.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const toAdd = ["albertomedico05@gmail.com","zoiamatteo53@gmail.com","zkostadinovski95@gmail.com","zapdani@hotmail.it","zamagnipaolo1@gmail.com","yelenia.73@gmail.com","weruschkafigura@gmail.com","vivins@libero.it","viktoriyaparmaksiz78@gmail.com","uboboss2000@yahoo.it","tonininadia@gmail.com","tiziano.casalta@gmail.com","tatyolly2002@gmail.com","tamara.80.tp@gmail.com","susannatomassini@gmail.com","superandrea.monti@gmail.com","stefanopiran76@gmail.com","stefanialamonaca9@gmail.com","smsmaggini@gmail.com","schenattimarco@gmail.com","scarcellagioacchino5@gmail.com","sarasalm848@gmail.com","saracarbo80@gmail.com","roberto.robustelli88@gmail.com","rinascerai79@gmail.com","riccardomoltomoli74@gmail.com","rav14jot@gmail.com","ramona.luca89@gmail.com","ramayanto61@gmail.com","petrilligiuseppe861@gmail.com","pellegrini.mrz@gmail.com","ostetrica.alessiabianco@gmail.com","monterosso.giuseppe0@gmail.com","mixalismath29@gmail.com","michele.balzano.73@gmail.com","meronigaia@gmail.com","mdtroiano6@gmail.com","mazzucatopamela137@gmail.com","mariafracap@gmail.com","margheritafrantolini@icloud.com","marcojacopobattaglia@gmail.com","marci.wite6@gmail.com","luigi@studiogargano.com","lindacatarraso@gmail.com","lina.crisalide97@gmail.com","j.bonatti@themaconsulting.ch","honig117@gmail.com","giulianocatrambone@gmail.com","giogiolutuana@gmail.com","giajviav@gmail.com","ghiromik@hotmail.com","g11advisory@gmail.com","felixbusso@gmail.com","fabiomara88@gmail.com","f.palmas00@icloud.com","ermelindachiumiento@gmail.com","epraderi@gmail.com","emanuluca.cavallo8089@hotmail.com","eltonshehu2212@gmail.com","elisabetta.iaria.73@gmail.com","elenacojocaru147@gmail.com","casaleing.marco@gmail.com","balcazarmarysol68@gmail.com","antonellatoma01@gmail.com","annabenvenuti1995@gmail.com","aneudyjoseynacio@gmail.com","alice.rosa2608@gmail.com","alice.mazzocato13@gmail.com","ali.amato98@gmail.com","alepat12021985@gmail.com","abarcaibeth@gmail.com","artemaimpianti@yahoo.it"];

const docRef = db.collection('newsletter_subscribers').doc('_meta_').collection('campaign_sends').doc('weekly_2026-05-04');
const existing = await docRef.get();
const existingSet = new Set((existing.data()?.sentEmails || []).map(e => e.toLowerCase()));
const newOnes = toAdd.filter(e => !existingSet.has(e.toLowerCase()));
console.log('Adding', newOnes.length, 'remaining emails to campaign_sends');
if (newOnes.length > 0) {
  await docRef.set({ sentEmails: FieldValue.arrayUnion(...newOnes), updatedAt: new Date() }, { merge: true });
}
const v = await docRef.get();
console.log('Total flagged:', (v.data()?.sentEmails || []).length);
