import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'public', 'images', 'publisher');

// Brand colors from the existing favicon/icon
const DARK_BG = '#1e293b';
const INDIGO = '#6366f1';

// ── Square Logo 1000x1000 ──────────────────────────────────────
const squareSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">
  <!-- Background -->
  <rect width="1000" height="1000" rx="160" fill="${INDIGO}"/>

  <!-- Inner card -->
  <rect x="120" y="120" width="760" height="760" rx="120" fill="${DARK_BG}"/>

  <!-- Search bar -->
  <rect x="200" y="220" width="600" height="120" rx="40" fill="#475569"/>
  <circle cx="280" cy="280" r="25" fill="none" stroke="#94a3b8" stroke-width="8"/>
  <line x1="297" y1="297" x2="320" y2="320" stroke="#94a3b8" stroke-width="8" stroke-linecap="round"/>
  <rect x="350" y="260" width="200" height="14" rx="7" fill="#94a3b8" opacity="0.5"/>
  <rect x="350" y="290" width="120" height="14" rx="7" fill="#94a3b8" opacity="0.3"/>

  <!-- Swiss flag (CH) -->
  <rect x="200" y="400" width="280" height="280" rx="50" fill="#dc2626"/>
  <rect x="310" y="440" width="60" height="200" rx="10" fill="white"/>
  <rect x="250" y="510" width="200" height="60" rx="10" fill="white"/>

  <!-- Italian flag (IT) -->
  <clipPath id="itClip">
    <rect x="520" y="400" width="280" height="280" rx="50"/>
  </clipPath>
  <g clip-path="url(#itClip)">
    <rect x="520" y="400" width="94" height="280" fill="#009246"/>
    <rect x="614" y="400" width="93" height="280" fill="white"/>
    <rect x="707" y="400" width="93" height="280" fill="#ce2b37"/>
  </g>

  <!-- Comparison arrows -->
  <g transform="translate(500, 750)" text-anchor="middle">
    <text font-family="system-ui, -apple-system, sans-serif" font-size="48" font-weight="700" fill="#94a3b8" letter-spacing="4">CH ⟷ IT</text>
  </g>
</svg>`;

// ── Rectangular Logo 400px wide ────────────────────────────────
// Height: keep reasonable ratio. Brand name + icon. ~400x100
const rectSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80" viewBox="0 0 400 80">
  <!-- Icon (mini version) -->
  <rect x="4" y="4" width="72" height="72" rx="14" fill="${DARK_BG}"/>

  <!-- CH mini -->
  <rect x="12" y="36" width="28" height="28" rx="6" fill="#dc2626"/>
  <rect x="22" y="40" width="8" height="20" rx="2" fill="white"/>
  <rect x="14" y="46" width="24" height="8" rx="2" fill="white"/>

  <!-- IT mini -->
  <clipPath id="itMini">
    <rect x="44" y="36" width="28" height="28" rx="6"/>
  </clipPath>
  <g clip-path="url(#itMini)">
    <rect x="44" y="36" width="10" height="28" fill="#009246"/>
    <rect x="54" y="36" width="9" height="28" fill="white"/>
    <rect x="63" y="36" width="9" height="28" fill="#ce2b37"/>
  </g>

  <!-- Search bar mini -->
  <rect x="12" y="12" width="56" height="18" rx="6" fill="#475569"/>

  <!-- Text: Frontaliere Ticino -->
  <!-- Baseline aligned vertically centered. With descender padding as per spec. -->
  <text x="92" y="38" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="26" font-weight="800" fill="${DARK_BG}" letter-spacing="-0.5">
    Frontaliere
  </text>
  <text x="92" y="64" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="22" font-weight="600" fill="#6366f1" letter-spacing="0.5">
    Ticino
  </text>
</svg>`;

// Generate PNGs
await sharp(Buffer.from(squareSvg)).png().toFile(join(outDir, 'logo-square-1000.png'));
console.log('✓ logo-square-1000.png (1000x1000)');

await sharp(Buffer.from(rectSvg)).png().toFile(join(outDir, 'logo-rect-400.png'));
console.log('✓ logo-rect-400.png (400x80)');

// Also generate 512x512 square variant
await sharp(Buffer.from(squareSvg)).resize(512, 512).png().toFile(join(outDir, 'logo-square-512.png'));
console.log('✓ logo-square-512.png (512x512)');

console.log('\nDone! Files saved to public/images/publisher/');
