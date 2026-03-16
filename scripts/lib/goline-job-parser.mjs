import { JSDOM } from 'jsdom';

function normalize(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/\u00a0/g, ' ');
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function textContent(node) {
  return normalize(decodeHtml(node?.textContent || ''));
}

function bulletTexts(listNode) {
  return [...(listNode?.querySelectorAll?.('li') || [])]
    .map((item) => textContent(item))
    .filter((item) => item.length >= 3);
}

export function parseGolineOpportunitiesPage(html = '') {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const root = document.querySelector('section.inner-page') || document.body;

  const roleHeading = [...root.querySelectorAll('h2')]
    .map((node) => textContent(node))
    .find((text) => /full stack developer/i.test(text));
  if (!roleHeading) {
    throw new Error('Could not find Goline job title on opportunities page');
  }

  const role = {
    title: roleHeading.replace(/\s*[–-]\s*Explore Opportunities\s*$/i, '').trim(),
    subtitle: '',
    intro: '',
    sections: [],
    applyUrl: '',
    location: 'Stabio',
    contractType: 'indefinite-term',
  };

  let current = null;
  for (const node of root.querySelectorAll('h3, p, ul, a')) {
    if (node.tagName === 'H3') {
      const heading = textContent(node);
      if (/Exciting Opportunities/i.test(heading)) {
        role.subtitle = heading;
        current = null;
        continue;
      }
      current = { heading, paragraphs: [], bullets: [] };
      role.sections.push(current);
      continue;
    }

    if (node.tagName === 'P') {
      const text = textContent(node);
      if (!text) continue;
      if (!role.intro && /GOLINE SA is seeking/i.test(text)) {
        role.intro = text;
      } else if (current) {
        current.paragraphs.push(text);
      }
      continue;
    }

    if (node.tagName === 'UL' && current) {
      current.bullets.push(...bulletTexts(node));
      continue;
    }

    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      const label = textContent(node);
      if (/resume|apply/i.test(label) && href) {
        role.applyUrl = href;
      }
    }
  }

  const workEnvironment = role.sections.find((section) => /Work Environment/i.test(section.heading));
  if (workEnvironment) {
    const locationBullet = workEnvironment.bullets.find((item) => /Location:/i.test(item));
    if (locationBullet) {
      const m = locationBullet.match(/Location:\s*([^,]+)/i);
      if (m) role.location = normalize(m[1]);
    }
    const contractBullet = workEnvironment.bullets.find((item) => /Contract:/i.test(item));
    if (contractBullet) {
      role.contractType = /indefinite/i.test(contractBullet) ? 'indefinite-term' : 'full-time';
    }
  }

  if (!role.applyUrl) {
    role.applyUrl = 'https://www.goline.ch/self-application/';
  }

  return role;
}

function sectionToMarkdown(heading, bullets = []) {
  if (!bullets.length) return '';
  return `## ${heading}\n${bullets.map((item) => `- ${item}`).join('\n')}`;
}

export function buildGolineLocalizedContent(role) {
  const baseBullets = {
    responsibilities: role.sections.find((section) => /Key Responsibilities/i.test(section.heading))?.bullets || [],
    requirements: role.sections.find((section) => /Required Skills/i.test(section.heading))?.bullets || [],
    preferred: role.sections.find((section) => /Preferred Skills/i.test(section.heading))?.bullets || [],
    candidate: role.sections.find((section) => /Candidate Requirements/i.test(section.heading))?.bullets || [],
    work: role.sections.find((section) => /Work Environment/i.test(section.heading))?.bullets || [],
    process: role.sections.find((section) => /Interview Process/i.test(section.heading))?.bullets || [],
    why: role.sections.find((section) => /Why Join/i.test(section.heading))?.bullets || [],
  };

  return {
    en: {
      title: 'Web Full Stack Developer (Backend & Frontend)',
      slug: slugify(`web-full-stack-developer-backend-frontend-goline-sa-${role.location}-ticino-switzerland`),
      description: [
        `${role.title} at GOLINE SA in ${role.location}, Ticino. ${role.intro}`,
        sectionToMarkdown('Key Responsibilities', baseBullets.responsibilities),
        sectionToMarkdown('Required Skills and Experience', baseBullets.requirements),
        sectionToMarkdown('Preferred Skills', baseBullets.preferred),
        sectionToMarkdown('Candidate Requirements', baseBullets.candidate),
        sectionToMarkdown('Work Environment', baseBullets.work),
        sectionToMarkdown('Interview Process', baseBullets.process),
        sectionToMarkdown('Why Join GOLINE SA', baseBullets.why),
        `Apply here: ${role.applyUrl}`,
      ].filter(Boolean).join('\n\n'),
    },
    it: {
      title: 'Sviluppatore Web Full Stack (Backend e Frontend)',
      slug: slugify(`sviluppatore-web-full-stack-backend-e-frontend-goline-sa-${role.location}-ticino-svizzera`),
      description: [
        `GOLINE SA cerca uno Sviluppatore Web Full Stack (backend e frontend) per la sede di ${role.location}, in Canton Ticino. Il ruolo e pensato per profili esperti che vogliono lavorare su applicazioni web, integrazioni e soluzioni digitali in un contesto tecnico molto operativo.`,
        sectionToMarkdown('Responsabilita principali', [
          'Sviluppare e mantenere applicazioni web dinamiche lato frontend e backend.',
          'Realizzare siti, web application e API con attenzione a performance e sicurezza.',
          'Tradurre mockup e layout in implementazioni HTML e CSS di qualita.',
          'Mantenere e ottimizzare soluzioni esistenti basate su Laravel, PHP e WordPress.',
          'Lavorare con REST API, SOAP e architetture database come MS SQL Server, MySQL e MariaDB.',
          'Collaborare con il team usando sistemi di versionamento come Git, SVN e TFS.',
        ]),
        sectionToMarkdown('Competenze richieste', [
          'Almeno 5 anni di esperienza con JavaScript e PHP.',
          'Esperienza con framework MVC e CMS.',
          'Conoscenza di Bootstrap e di almeno uno tra Angular, React o Vue.js.',
          'Esperienza con strumenti di versionamento del codice per almeno 2 anni.',
          'Buona conoscenza degli strumenti Adobe come Photoshop, Illustrator o XD.',
          'Ottima comprensione di architetture web e integrazioni REST e SOAP.',
          'Italiano fluente ed inglese almeno livello B1.',
        ]),
        sectionToMarkdown('Competenze gradite', [
          'Conoscenza di TypeScript, Angular e Node.js.',
          'Esperienza con test software e relativi framework.',
          'Gestione di server hosting in ambienti Linux.',
          'Nozioni di SEO e social networking.',
        ]),
        sectionToMarkdown('Requisiti del candidato', [
          'Padronanza nativa o professionale completa della lingua italiana.',
          'Cittadinanza svizzera oppure UE/EFTA con diritto a vivere e lavorare in Svizzera.',
        ]),
        sectionToMarkdown('Contesto di lavoro', [
          `Sede di lavoro: ${role.location}, Canton Ticino, Svizzera.`,
          'Contratto a tempo indeterminato.',
          'Retribuzione commisurata all esperienza e definita in fase di colloquio.',
        ]),
        sectionToMarkdown('Iter di selezione', [
          'Prima fase con questionario tecnico per valutare competenze e seniority.',
          'Seconda fase con colloquio insieme al team leader per i profili selezionati.',
        ]),
        sectionToMarkdown('Perche candidarsi', [
          'Possibilita di crescita professionale e innovazione continua.',
          'Esposizione a tecnologie moderne e progetti web concreti.',
          'Ambiente di lavoro dinamico e collaborativo.',
        ]),
        `Candidatura: ${role.applyUrl}`,
      ].join('\n\n'),
    },
    de: {
      title: 'Web Full Stack Entwickler/in (Backend und Frontend)',
      slug: slugify(`web-full-stack-entwickler-backend-und-frontend-goline-sa-${role.location}-tessin-schweiz`),
      description: [
        `GOLINE SA sucht eine erfahrene Web-Full-Stack-Entwicklerin oder einen erfahrenen Web-Full-Stack-Entwickler fuer den Standort ${role.location} im Tessin. Die Rolle verbindet Backend, Frontend, Integrationen und operative Web-Projekte in einem technisch anspruchsvollen Umfeld.`,
        sectionToMarkdown('Hauptaufgaben', [
          'Dynamische Webanwendungen im Frontend und Backend entwickeln und pflegen.',
          'Websites, Webanwendungen und APIs erstellen.',
          'Mockups in saubere HTML- und CSS-Implementierungen umsetzen.',
          'Bestehende Laravel-, PHP- und WordPress-Loesungen pflegen und optimieren.',
          'Mit REST-, SOAP- und Datenbankarchitekturen wie MS SQL Server, MySQL und MariaDB arbeiten.',
          'Eng mit dem Team ueber Git, SVN oder TFS zusammenarbeiten.',
        ]),
        sectionToMarkdown('Erforderliche Kenntnisse', [
          'Mindestens 5 Jahre Erfahrung mit JavaScript und PHP.',
          'Praxis mit MVC-Frameworks und CMS.',
          'Kenntnisse in Bootstrap und mindestens einem der Frameworks Angular, React oder Vue.js.',
          'Mindestens 2 Jahre Erfahrung mit Versionsverwaltung.',
          'Sicherer Umgang mit Adobe-Tools wie Photoshop, Illustrator oder XD.',
          'Sehr gutes Verstaendnis von Webarchitekturen sowie REST- und SOAP-Schnittstellen.',
          'Fliessendes Italienisch und Englisch mindestens auf Niveau B1.',
        ]),
        sectionToMarkdown('Von Vorteil', [
          'Kenntnisse in TypeScript, Angular und Node.js.',
          'Erfahrung mit Softwaretests und Testframeworks.',
          'Kenntnisse im Hosting- und Servermanagement unter Linux.',
          'Grundwissen in SEO und Social Media.',
        ]),
        sectionToMarkdown('Rahmenbedingungen', [
          `Arbeitsort: ${role.location}, Tessin, Schweiz.`,
          'Unbefristeter Vertrag.',
          'Gehalt entsprechend Erfahrung, Besprechung im Interview.',
        ]),
        sectionToMarkdown('Bewerbungsprozess', [
          'Erste Phase mit technischem Fragebogen.',
          'Anschliessend Gespraech mit dem Team Lead fuer passende Kandidatinnen und Kandidaten.',
        ]),
        `Bewerbung: ${role.applyUrl}`,
      ].join('\n\n'),
    },
    fr: {
      title: 'Developpeur Web Full Stack (Backend et Frontend)',
      slug: slugify(`developpeur-web-full-stack-backend-et-frontend-goline-sa-${role.location}-tessin-suisse`),
      description: [
        `GOLINE SA recherche un ou une Developpeur Web Full Stack experimente(e) pour son site de ${role.location}, au Tessin. Le poste couvre le frontend, le backend, les integrations et l evolution continue d applications web dans un environnement technique concret.`,
        sectionToMarkdown('Responsabilites principales', [
          'Developper et maintenir des applications web dynamiques en frontend et backend.',
          'Creer des sites web, des applications web et des API.',
          'Transformer des maquettes en implementations HTML et CSS solides.',
          'Maintenir et optimiser des solutions Laravel, PHP et WordPress existantes.',
          'Travailler avec des API REST, SOAP et des bases de donnees comme MS SQL Server, MySQL et MariaDB.',
          'Collaborer avec l equipe via Git, SVN ou TFS.',
        ]),
        sectionToMarkdown('Competences requises', [
          'Au moins 5 ans d experience en JavaScript et PHP.',
          'Experience avec des frameworks MVC et des CMS.',
          'Connaissance de Bootstrap et d au moins un framework parmi Angular, React ou Vue.js.',
          'Au moins 2 ans d experience avec les outils de versioning.',
          'Bonne maitrise des outils Adobe comme Photoshop, Illustrator ou XD.',
          'Solide comprehension des architectures web et des integrations REST et SOAP.',
          'Italien courant et anglais minimum niveau B1.',
        ]),
        sectionToMarkdown('Competences appreciees', [
          'Connaissance de TypeScript, Angular et Node.js.',
          'Experience en tests logiciels et frameworks associes.',
          'Gestion de serveurs et d environnements Linux.',
          'Notions de SEO et de reseaux sociaux.',
        ]),
        sectionToMarkdown('Cadre de travail', [
          `Lieu de travail: ${role.location}, Tessin, Suisse.`,
          'Contrat a duree indeterminee.',
          'Salaire selon experience, a definir pendant le processus de recrutement.',
        ]),
        sectionToMarkdown('Processus de recrutement', [
          'Premiere etape avec questionnaire technique.',
          'Entretien avec le team leader pour les profils retenus.',
        ]),
        `Candidature: ${role.applyUrl}`,
      ].join('\n\n'),
    },
  };
}
