// Traductions françaises — pages SEO temps d'attente aux douanes.
// Voir services/locales/it-border-wait.ts pour la note d'architecture.

const translations: Record<string, string> = {
  'borderWait.root.h1': "Temps d'attente aux douanes Tessin–Italie — en direct aujourd'hui",
  'borderWait.regional.h1': 'Douanes {region} — temps d\'attente',
  'borderWait.leaf.h1': "Temps d'attente à la douane {crossing} — aujourd'hui",
  'borderWait.updated': 'Mise à jour',
  'borderWait.waitMinutes': 'Minutes d\'attente',
  'borderWait.source.bazg': 'Données officielles Douane suisse',
  'borderWait.source.tomtom': 'Estimation TomTom (flux de circulation)',
  'borderWait.source.google': 'Estimation Google Maps',
  'borderWait.source.static': 'Moyennes historiques — données temps réel indisponibles',
  'borderWait.currentStatus': 'État actuel',
  'borderWait.hourlyToday': "Tendance horaire — aujourd'hui",
  'borderWait.weeklyPattern': 'Tendance hebdomadaire — 30 derniers jours',
  'borderWait.bestHours': 'Meilleures heures',
  'borderWait.worstHours': 'Pires heures',
  'borderWait.infoValico': 'Informations douane',
  'borderWait.webcamLive': 'Webcam en direct',
  'borderWait.webcamNote':
    "Les images se rafraîchissent automatiquement chaque minute lorsque la page est ouverte. Cliquez sur « Source » pour la version officielle.",
  'borderWait.webcamSource': 'Source',
  'borderWait.faq.title': 'Questions fréquentes',
  'borderWait.breadcrumbHome': 'Accueil',
  'borderWait.related': 'Voir aussi',
  'borderWait.nohistory':
    "Historique en construction : les tendances hebdomadaires apparaîtront dès que suffisamment de données seront collectées.",
};

export default translations;
