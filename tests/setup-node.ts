// Setup del project `node`: il corpo comune SENZA i matcher jest-dom.
//
// Unica differenza rispetto a tests/setup.tsx — vedi lì per la misura che
// motiva la separazione e per la verifica che nessun test del project node usi
// un matcher DOM. Il corpo (mock di firebase/analytics/leaflet/recharts/…,
// guardie `HAS_DOM`) è condiviso, non duplicato.
import './setup-common';
