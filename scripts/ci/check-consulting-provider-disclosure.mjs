import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SURFACES = [
  {
    file: 'build-plugins/staticPagesPlugin.ts',
    start: "} else if (canonicalPath === '/consulenza' || canonicalPath === '/consulenza/') {",
    end: "} else if (canonicalPath === '/about' || canonicalPath === '/about/') {",
    patterns: [
      /I consulenti sono specializzati nelle normative di entrambi i paesi/,
      /I professionisti utilizzano gli stessi parametri dei simulatori del sito/,
    ],
  },
  {
    file: 'build-plugins/editorialContent.ts',
    start: "'/consulenza': {",
    end: "// ───── Privacy",
    patterns: [
      /Consultants specialise in the regulations of both countries/,
      /Die Berater sind auf die Regelungen beider Länder spezialisiert/,
      /Les consultants sont spécialisés dans les réglementations des deux pays/,
    ],
  },
  {
    file: 'services/locales/it-vita.ts',
    start: "'consulting.subtitle':",
    end: "'consulting.popular':",
    patterns: [/sessione personalizzata con un esperto/, /'consulting\.trust\.experts': 'Esperti del settore'/],
  },
  {
    file: 'services/locales/en-vita.ts',
    start: "'consulting.subtitle':",
    end: "'consulting.popular':",
    patterns: [/personalized session with an expert/, /'consulting\.trust\.experts': 'Industry experts'/],
  },
  {
    file: 'services/locales/de-vita.ts',
    start: "'consulting.subtitle':",
    end: "'consulting.popular':",
    patterns: [/persönliche Sitzung mit einem Experten/, /'consulting\.trust\.experts': 'Branchenexperten'/],
  },
  {
    file: 'services/locales/fr-vita.ts',
    start: "'consulting.subtitle':",
    end: "'consulting.popular':",
    patterns: [/session personnalisée avec un expert/, /'consulting\.trust\.experts': 'Experts du secteur'/],
  },
  {
    file: 'services/seo/seo-pages.ts',
    start: ' consulting: {',
    end: '\n\n partners: {',
    patterns: [
      /esperto frontaliero/,
      /Prenota gratis/,
      /consulenza fiscale specializzata per lavoratori frontalieri/,
      /"provider"\s*:/,
    ],
  },
];

function section(source, start, end) {
  const startAt = source.indexOf(start);
  if (startAt < 0) return null;
  const endAt = source.indexOf(end, startAt + start.length);
  if (endAt < 0) return null;
  return source.slice(startAt, endAt);
}

export function findUnsupportedConsultingClaims(rootDir = ROOT) {
  const missing = [];
  const violations = [];

  for (const surface of SURFACES) {
    const filePath = path.resolve(rootDir, surface.file);
    if (!fs.existsSync(filePath)) {
      missing.push(surface.file);
      continue;
    }
    const source = fs.readFileSync(filePath, 'utf8');
    const scoped = section(source, surface.start, surface.end);
    if (scoped === null) {
      missing.push(`${surface.file}:consulting-section`);
      continue;
    }
    for (const pattern of surface.patterns) {
      if (pattern.test(scoped)) violations.push(`${surface.file}: ${pattern}`);
    }
  }

  return { missing, violations };
}

export function main(argv = process.argv.slice(2)) {
  const requested = argv[0];
  const result = findUnsupportedConsultingClaims(ROOT);

  if (requested && !fs.existsSync(path.resolve(requested))) {
    result.missing.push(requested);
  }

  if (result.missing.length || result.violations.length) {
    if (result.missing.length) console.error(`Missing consulting disclosure surfaces: ${result.missing.join(', ')}`);
    if (result.violations.length) console.error(`Unsupported consulting claims: ${result.violations.join('; ')}`);
    return 1;
  }

  console.log('consulting-provider-disclosure: unsupported provider/qualification claims = 0');
  return 0;
}

if ((() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})()) {
  process.exitCode = main();
}
