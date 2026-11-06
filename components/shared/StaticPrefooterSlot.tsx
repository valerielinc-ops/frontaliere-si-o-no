import React, { useLayoutEffect, useRef } from 'react';

/**
 * Slot che porta sopra il footer i blocchi statici emessi dal build dopo
 * `#root` (rail di discovery, pannello SEO, nav localizzata).
 *
 * Il build li scrive in fondo al `<body>` perche' devono restare fuori dalla
 * riconciliazione di React e leggibili senza JavaScript. Il footer pero' e'
 * renderizzato da React dentro `#root` (o dentro `#footer-root`): lasciati
 * dove nascono, quei blocchi finiscono SOTTO il footer, dopo il copyright,
 * dove nessuno li cerca. Qui vengono solo spostati nel DOM: l'HTML servito non
 * cambia, quindi ogni link resta nel documento statico che i crawler leggono.
 *
 * React non riconcilia i figli di un host element che renderizza senza figli,
 * percio' i nodi adottati sopravvivono ai re-render dello slot.
 */
const STATIC_PREFOOTER_SELECTOR =
  '#homepage-discovery, .seo-footer-block, .hp-discovery-block, .homepage-locale-main-nav';

const normalizePath = (path: string): string => (path.endsWith('/') ? path : `${path}/`);

// Il percorso con cui il documento e' stato servito: i blocchi appartengono a
// quella pagina. Letto al caricamento del modulo, prima di ogni navigazione SPA.
const ORIGIN_PATH = typeof window !== 'undefined' ? normalizePath(window.location.pathname) : '/';

// Catturati una volta sola e tenuti per riferimento: quando il footer cambia
// contenitore (inline <-> portal) React smonta lo slot insieme ai nodi adottati,
// e al rimontaggio vanno riappesi, non ricercati in un `<body>` che non li ha piu'.
let adopted: HTMLElement[] | null = null;

function collectStaticPrefooterNodes(): HTMLElement[] {
  if (adopted) return adopted;
  adopted = Array.from(document.body.children).filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.matches(STATIC_PREFOOTER_SELECTOR),
  );
  return adopted;
}

/** Solo per i test: azzera la cattura fra un caso e l'altro. */
export function resetStaticPrefooterForTests(): void {
  adopted = null;
}

interface StaticPrefooterSlotProps {
  /** Percorso corrente della SPA: lontano dalla pagina d'origine i blocchi sono stantii. */
  pathname: string;
  /** Percorso d'origine; default al percorso del documento servito. */
  originPath?: string;
}

const StaticPrefooterSlot: React.FC<StaticPrefooterSlotProps> = ({ pathname, originPath = ORIGIN_PATH }) => {
  const slotRef = useRef<HTMLDivElement>(null);

  // Layout effect: lo spostamento avviene nello stesso commit che monta il
  // footer, prima del paint, quindi non produce un layout shift visibile.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    for (const node of collectStaticPrefooterNodes()) {
      if (node.parentElement !== slot) slot.appendChild(node);
    }
  }, []);

  // Dopo una navigazione SPA i blocchi descrivono un'altra pagina: restano nel
  // DOM (tornando indietro riappaiono) ma non si mostrano sotto contenuti altrui.
  return <div ref={slotRef} className="static-prefooter" hidden={normalizePath(pathname) !== normalizePath(originPath)} />;
};

export default StaticPrefooterSlot;
