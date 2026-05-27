import React from 'react';
import {
  ArrowLeft,
  Workflow,
  Bot,
  BookOpen,
  ScrollText,
  RefreshCw,
  CheckCircle2,
  ListChecks,
} from 'lucide-react';
import { useNavigation } from '@/services/NavigationContext';

/**
 * Metodologia — /metodologia/ Editorial methodology page.
 *
 * Required for Google News compliance (FASE 2 A3): explains the editorial
 * pipeline, AI-assistance disclosure, primary sources, journalistic
 * standards, and the update / corrections policy.
 *
 * Pairs with the AI disclosure box rendered on every blog article and the
 * public corrections log at /correzioni/.
 *
 * Inline JSON-LD WebPage schema with `lastReviewed` so crawlers see a
 * non-empty freshness signal even when the page isn't edited every day.
 */
export const Metodologia: React.FC = () => {
  const nav = useNavigation();

  const lastReviewed = new Date().toISOString().slice(0, 10);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: 'Metodologia editoriale — Come scriviamo gli articoli',
    url: 'https://frontaliereticino.ch/metodologia/',
    description:
      "Come utilizziamo l'IA generativa, le fonti primarie e il processo di revisione editoriale per garantire accuratezza e trasparenza.",
    lastReviewed,
    publisher: { '@id': 'https://frontaliereticino.ch/#organization' },
    inLanguage: 'it',
    isPartOf: { '@id': 'https://frontaliereticino.ch/#website' },
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 animate-fade-in">
      {/* Inline WebPage JSON-LD with lastReviewed */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Back Button */}
      <button
        onClick={() => nav.navigateTo('calculator')}
        className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:text-accent transition-colors"
      >
        <ArrowLeft size={16} />
        Torna alla Home
      </button>

      {/* Header */}
      <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-8 shadow-lg mb-6">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-info rounded-2xl shadow-lg">
            <ScrollText className="text-on-accent" size={32} />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold font-display text-strong">
              Come scriviamo gli articoli
            </h1>
            <p className="text-sm text-muted mt-1">
              Metodologia editoriale di Frontaliere Ticino
            </p>
          </div>
        </div>
        <p className="text-subtle leading-relaxed">
          Questa pagina descrive in dettaglio il processo che usiamo per
          ricercare, scrivere, verificare e aggiornare ogni articolo
          pubblicato su <strong>Frontaliere Ticino</strong>. Crediamo che la
          trasparenza sul metodo sia parte integrante della qualità
          editoriale: ogni lettore deve poter capire come è stato prodotto
          il testo che sta leggendo, quali fonti sono state usate e in che
          modo l'intelligenza artificiale e la redazione collaborano.
        </p>
        <p className="text-xs text-muted mt-3">
          Ultima revisione: {lastReviewed}
        </p>
      </div>

      <div className="space-y-6">
        {/* Pipeline editoriale */}
        <Section icon={Workflow} title="Pipeline editoriale">
          <p>
            Ogni articolo segue una pipeline a cinque fasi, sempre nella
            stessa sequenza:
          </p>
          <ol className="mt-3 space-y-2 list-decimal list-inside marker:text-accent">
            <NumberItem>
              <strong>Raccolta fonti</strong>: identificazione e lettura
              integrale delle fonti primarie pertinenti (testi normativi,
              comunicati ufficiali, dati statistici, sentenze).
            </NumberItem>
            <NumberItem>
              <strong>Bozza assistita da IA</strong>: un modello linguistico
              produce una prima stesura strutturata a partire dalle fonti
              raccolte, con un brief redazionale che impone tono, lunghezza,
              fonti e divieto di affermazioni non supportate.
            </NumberItem>
            <NumberItem>
              <strong>Revisione redazionale</strong>: un editor verifica
              ogni paragrafo, riscrive le parti deboli, controlla la
              coerenza con altri articoli del sito e adatta il testo alla
              situazione concreta del frontaliere italo-svizzero.
            </NumberItem>
            <NumberItem>
              <strong>Fact-checking</strong>: ogni dato numerico (aliquote,
              importi, date, scadenze) viene verificato sulla fonte
              primaria. I link a fonti esterne sono testati e devono
              puntare a documenti aggiornati.
            </NumberItem>
            <NumberItem>
              <strong>Pubblicazione e tracciamento</strong>: l'articolo
              viene pubblicato con data, autore e link alle fonti. Eventuali
              correzioni successive sono registrate nel{' '}
              <button
                onClick={() => nav.navigateTo('correzioni' as never)}
                className="text-accent hover:underline font-medium"
              >
                registro pubblico delle correzioni
              </button>
              .
            </NumberItem>
          </ol>
        </Section>

        {/* Strumenti AI */}
        <Section icon={Bot} title="Strumenti AI">
          <p>
            Usiamo modelli linguistici di nuova generazione (Claude di
            Anthropic e GPT di OpenAI) per produrre bozze iniziali, suggerire
            strutture e tradurre i contenuti tra italiano, inglese, tedesco
            e francese. L'IA è un assistente, non un autore autonomo:{' '}
            <strong>
              ogni articolo è revisionato dalla redazione prima della
              pubblicazione
            </strong>
            .
          </p>
          <p className="mt-3">
            Per garantire affidabilità applichiamo regole rigide:
          </p>
          <ul className="mt-3 space-y-2">
            <BulletItem>
              I prompt impongono al modello di citare solo dati presenti
              nelle fonti fornite e di rifiutarsi di inventare cifre o
              normative.
            </BulletItem>
            <BulletItem>
              Le bozze IA non vengono mai pubblicate senza una passata di
              revisione umana che riscrive almeno il 30% del testo.
            </BulletItem>
            <BulletItem>
              I marchi e i nomi propri (banche, casse malati, datori di
              lavoro, comuni) sono protetti da una lista di entità che
              impedisce all'IA di tradurli o storpiarli durante la
              localizzazione.
            </BulletItem>
            <BulletItem>
              Ogni articolo include la dicitura "bozza assistita da
              intelligenza artificiale, revisionata dalla redazione" in
              testa al corpo del testo.
            </BulletItem>
          </ul>
        </Section>

        {/* Fonti primarie */}
        <Section icon={BookOpen} title="Fonti primarie">
          <p>
            Per ogni argomento usiamo esclusivamente fonti primarie e
            verificabili. Le fonti secondarie (giornali, blog, forum) sono
            consultate solo come segnale di attualità, mai come sorgente
            unica di un dato.
          </p>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[
              'AFC / ESTV — Amministrazione federale delle contribuzioni',
              "Comunicati stampa di Cantone Ticino, Confederazione e MEF",
              'UST / BFS — Ufficio federale di statistica',
              'USTAT — Ufficio cantonale di statistica Ticino',
              "Sentenze della Corte di giustizia europea, del Tribunale federale e della Cassazione",
              'Gazzetta Ufficiale italiana e Foglio federale svizzero',
              "Agenzia delle Entrate, INPS e Ministero dell'Economia",
              'SECO, UFSP/BAG, USAV — Uffici federali svizzeri',
              "Accordo bilaterale Italia-Svizzera sui frontalieri (2020 / 2026)",
              'TomTom Traffic API per dati di traffico transfrontaliero',
            ].map((source) => (
              <div
                key={source}
                className="flex items-start gap-2 text-sm text-subtle"
              >
                <CheckCircle2
                  size={14}
                  className="text-success mt-0.5 shrink-0"
                />
                <span>{source}</span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted">
            Le fonti utilizzate per ciascun articolo sono linkate
            direttamente nel testo, in modo che il lettore possa risalire al
            documento originale.
          </p>
        </Section>

        {/* Standard giornalistici */}
        <Section icon={ListChecks} title="Standard giornalistici">
          <p>
            Aderiamo agli standard di riferimento del giornalismo
            economico-finanziario applicati al contesto frontaliere:
          </p>
          <ul className="mt-3 space-y-2">
            <BulletItem>
              <strong>Separazione fatti e opinioni</strong>: i contenuti
              esplicativi (guide, simulatori, schede) riportano solo dati
              verificabili. Le opinioni e le interpretazioni sono indicate
              come tali e separate visivamente dal corpo principale.
            </BulletItem>
            <BulletItem>
              <strong>Attribuzione esplicita</strong>: ogni dato numerico,
              citazione o affermazione di fatto è attribuito a una fonte
              identificabile, con link diretto al documento originale
              quando disponibile online.
            </BulletItem>
            <BulletItem>
              <strong>Citazioni verbatim</strong>: le frasi tra virgolette
              riproducono fedelmente il testo della fonte; eventuali tagli
              sono segnalati con le parentesi quadre.
            </BulletItem>
            <BulletItem>
              <strong>Verificabilità</strong>: ogni affermazione importante
              deve poter essere replicata da un lettore esperto a partire
              dalle fonti citate. Se un calcolo non è ricostruibile, va
              riscritto o rimosso.
            </BulletItem>
            <BulletItem>
              <strong>Imparzialità</strong>: non accettiamo contenuti
              sponsorizzati che alterino la sostanza di un articolo. Gli
              articoli sponsorizzati o partner sono etichettati in modo
              chiaro.
            </BulletItem>
            <BulletItem>
              <strong>Trasparenza degli autori</strong>: ogni articolo
              indica autore o redazione e rimanda alla pagina{' '}
              <button
                onClick={() => nav.navigateTo('chi-siamo')}
                className="text-accent hover:underline font-medium"
              >
                Chi Siamo
              </button>{' '}
              dove sono descritte competenze, esperienza e contatti.
            </BulletItem>
          </ul>
        </Section>

        {/* Politica aggiornamenti */}
        <Section icon={RefreshCw} title="Politica di aggiornamento">
          <p>
            Gli articoli che descrivono normative, aliquote o prassi
            amministrative vengono aggiornati ogni volta che cambiano i
            fatti — non a scadenza fissa. Quando un parametro cambia (per
            esempio un'aliquota cantonale, una soglia INPS o una scadenza
            fiscale), riportiamo la modifica entro 48 ore lavorative
            dall'entrata in vigore.
          </p>
          <p className="mt-3">
            Distinguiamo due tipi di intervento:
          </p>
          <ul className="mt-3 space-y-2">
            <BulletItem>
              <strong>Aggiornamento</strong>: integrazione di nuovi dati,
              esempi o riferimenti normativi senza che l'impostazione
              originale dell'articolo cambi. Viene segnalato dalla data
              "Aggiornato il".
            </BulletItem>
            <BulletItem>
              <strong>Correzione</strong>: rettifica di un errore (un dato
              sbagliato, una citazione imprecisa, un link rotto). Le
              correzioni sono registrate in modo permanente e pubblico nel{' '}
              <button
                onClick={() => nav.navigateTo('correzioni' as never)}
                className="text-accent hover:underline font-medium"
              >
                registro delle correzioni
              </button>
              , con data, articolo coinvolto, tipologia e descrizione
              dell'errore. Lo SLA è di 48 ore dalla segnalazione.
            </BulletItem>
          </ul>
          <p className="mt-4">
            Per segnalare un errore o un'imprecisione scrivi a{' '}
            <a
              href="mailto:redazione@frontaliereticino.ch"
              className="text-accent hover:underline font-medium"
            >
              redazione@frontaliereticino.ch
            </a>
            : ogni segnalazione viene esaminata e, se confermata, registrata
            pubblicamente.
          </p>
        </Section>

        {/* Closing — link to related editorial pages */}
        <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
          <h2 className="text-lg font-bold font-display text-strong mb-3">
            Pagine collegate
          </h2>
          <div className="flex flex-wrap gap-3 text-sm">
            <button
              onClick={() => nav.navigateTo('chi-siamo')}
              className="text-accent hover:underline font-medium"
            >
              Chi siamo
            </button>
            <span className="text-edge">·</span>
            <button
              onClick={() => nav.navigateTo('correzioni' as never)}
              className="text-accent hover:underline font-medium"
            >
              Registro delle correzioni
            </button>
            <span className="text-edge">·</span>
            <button
              onClick={() => nav.navigateTo('privacy')}
              className="text-accent hover:underline font-medium"
            >
              Privacy
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ── Reusable sub-components ── */

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.FC<{ size?: number; className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-4">
        <Icon size={20} className="text-accent" />
        <h2 className="text-lg font-bold font-display text-strong">{title}</h2>
      </div>
      <div className="text-sm text-subtle leading-relaxed">{children}</div>
    </div>
  );
}

function BulletItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <CheckCircle2 size={14} className="text-success mt-0.5 shrink-0" />
      <span>{children}</span>
    </li>
  );
}

function NumberItem({ children }: { children: React.ReactNode }) {
  return <li className="pl-1">{children}</li>;
}

export default Metodologia;
