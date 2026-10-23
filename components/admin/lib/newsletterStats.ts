export interface NewsletterStats {
  subscriberCount: number | null;
  lastSend: string | null;
  recipients: string[];
}

export async function loadNewsletterStats(): Promise<NewsletterStats> {
  const { getFirestore, collection, query, where, getDocs, getCountFromServer, limit, doc, getDoc } = await import('firebase/firestore');
  const { app } = await import('@/services/firebase');
  const db = getFirestore(app);
  const activeSubscribers = query(collection(db, 'newsletter_subscribers'), where('isActive', '==', true));
  const countSnapshot = await getCountFromServer(activeSubscribers);
  const metaSnapshot = await getDoc(doc(db, 'newsletter_subscribers', '_meta_'));
  let lastSend: string | null = null;
  if (metaSnapshot.exists()) {
    const rawDate = metaSnapshot.data().last_sent_at;
    const date = rawDate?.toDate?.() ?? new Date(rawDate);
    if (!Number.isNaN(date.getTime())) lastSend = date.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  const sampleSnapshot = await getDocs(query(activeSubscribers, limit(10)));
  const recipients: string[] = [];
  sampleSnapshot.forEach((entry) => {
    const email = entry.data().email;
    if (email && recipients.length < 10) {
      const [name, domain] = email.split('@');
      recipients.push(`${name.slice(0, 2)}***@${domain}`);
    }
  });
  return { subscriberCount: countSnapshot.data().count, lastSend, recipients };
}
