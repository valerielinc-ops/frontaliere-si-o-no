import React, { useState, useMemo } from 'react';
import { useTranslation } from '@/services/i18n';
import { borderCrossings } from '@/data/borderCrossings';
import { MapContainer, TileLayer, CircleMarker, Popup, Marker } from 'react-leaflet';
import { MapPin, Filter, Info, AlertTriangle, Train, ArrowUpDown } from 'lucide-react';
import 'leaflet/dist/leaflet.css';

// ─── Municipality data (subset — key border municipalities with tax data) ───

interface Municipality {
  name: string;
  province: string;
  lat: number;
  lng: number;
  irpefAddizionale: number; // Addizionale comunale IRPEF (%)
  distanceKm: number; // Distance from nearest crossing
  avgRentMonthly: number; // Average rent €/month (bilocale)
  population: number;
  fascia: '1' | '1A' | '2'; // Frontier zone
}

// Representative border municipalities (Como, Varese, VB, SO provinces)
const MUNICIPALITIES: Municipality[] = [
  // ════════════════════════════════════════════════════════════════
  // COMO — Fascia 1 (confine diretto / < 10 km)
  // ════════════════════════════════════════════════════════════════
  { name: 'Como', province: 'CO', lat: 45.8081, lng: 9.0852, irpefAddizionale: 0.8, distanceKm: 3, avgRentMonthly: 750, population: 84000, fascia: '1' },
  { name: 'Cernobbio', province: 'CO', lat: 45.8472, lng: 9.0727, irpefAddizionale: 0.6, distanceKm: 4, avgRentMonthly: 850, population: 6800, fascia: '1' },
  { name: 'Ponte Chiasso (Maslianico)', province: 'CO', lat: 45.8389, lng: 9.0283, irpefAddizionale: 0.5, distanceKm: 0, avgRentMonthly: 550, population: 3300, fascia: '1' },
  { name: 'Uggiate con Ronago', province: 'CO', lat: 45.8280, lng: 8.9668, irpefAddizionale: 0.55, distanceKm: 3, avgRentMonthly: 580, population: 5500, fascia: '1' },
  { name: 'Bizzarone', province: 'CO', lat: 45.8362, lng: 8.9465, irpefAddizionale: 0.5, distanceKm: 1, avgRentMonthly: 530, population: 1600, fascia: '1' },
  { name: 'Cagno', province: 'CO', lat: 45.8285, lng: 8.9371, irpefAddizionale: 0.5, distanceKm: 2, avgRentMonthly: 500, population: 2100, fascia: '1' },
  { name: 'Rodero', province: 'CO', lat: 45.8258, lng: 8.9178, irpefAddizionale: 0.5, distanceKm: 3, avgRentMonthly: 520, population: 1400, fascia: '1' },
  { name: 'Solbiate', province: 'CO', lat: 45.8160, lng: 8.9350, irpefAddizionale: 0.5, distanceKm: 4, avgRentMonthly: 530, population: 2700, fascia: '1' },
  { name: 'Drezzo', province: 'CO', lat: 45.8405, lng: 8.9600, irpefAddizionale: 0.45, distanceKm: 2, avgRentMonthly: 490, population: 900, fascia: '1' },
  { name: 'Faloppio', province: 'CO', lat: 45.8169, lng: 8.9611, irpefAddizionale: 0.5, distanceKm: 5, avgRentMonthly: 550, population: 4900, fascia: '1' },
  { name: 'Ronago', province: 'CO', lat: 45.8370, lng: 8.9740, irpefAddizionale: 0.5, distanceKm: 2, avgRentMonthly: 520, population: 1700, fascia: '1' },
  { name: 'Moltrasio', province: 'CO', lat: 45.8585, lng: 9.0927, irpefAddizionale: 0.55, distanceKm: 5, avgRentMonthly: 750, population: 1700, fascia: '1' },
  { name: 'Carate Urio', province: 'CO', lat: 45.8673, lng: 9.1108, irpefAddizionale: 0.5, distanceKm: 7, avgRentMonthly: 650, population: 1200, fascia: '1' },
  { name: 'Laglio', province: 'CO', lat: 45.8778, lng: 9.1383, irpefAddizionale: 0.5, distanceKm: 8, avgRentMonthly: 900, population: 950, fascia: '1' },
  { name: 'Brienno', province: 'CO', lat: 45.8902, lng: 9.1535, irpefAddizionale: 0.5, distanceKm: 9, avgRentMonthly: 550, population: 400, fascia: '1' },
  { name: 'Argegno', province: 'CO', lat: 45.9164, lng: 9.1257, irpefAddizionale: 0.5, distanceKm: 8, avgRentMonthly: 580, population: 700, fascia: '1' },
  { name: 'Menaggio', province: 'CO', lat: 46.0200, lng: 9.2365, irpefAddizionale: 0.5, distanceKm: 8, avgRentMonthly: 700, population: 3200, fascia: '1' },
  { name: 'Porlezza', province: 'CO', lat: 46.0360, lng: 9.1287, irpefAddizionale: 0.5, distanceKm: 2, avgRentMonthly: 550, population: 4700, fascia: '1' },
  { name: 'Valsolda', province: 'CO', lat: 46.0400, lng: 9.0690, irpefAddizionale: 0.5, distanceKm: 1, avgRentMonthly: 450, population: 1600, fascia: '1' },
  { name: 'Claino con Osteno', province: 'CO', lat: 46.0100, lng: 9.0700, irpefAddizionale: 0.5, distanceKm: 1, avgRentMonthly: 420, population: 550, fascia: '1' },
  { name: 'Lanzo d\'Intelvi', province: 'CO', lat: 45.9748, lng: 9.0500, irpefAddizionale: 0.5, distanceKm: 5, avgRentMonthly: 480, population: 1400, fascia: '1' },
  { name: 'Campione d\'Italia', province: 'CO', lat: 45.9696, lng: 8.9708, irpefAddizionale: 0.0, distanceKm: 0, avgRentMonthly: 900, population: 1900, fascia: '1' },
  { name: 'Tremezzina', province: 'CO', lat: 45.9688, lng: 9.2217, irpefAddizionale: 0.5, distanceKm: 10, avgRentMonthly: 750, population: 5200, fascia: '1' },
  { name: 'Gravedona ed Uniti', province: 'CO', lat: 46.1462, lng: 9.3052, irpefAddizionale: 0.55, distanceKm: 5, avgRentMonthly: 480, population: 4200, fascia: '1' },
  { name: 'Dongo', province: 'CO', lat: 46.1268, lng: 9.2822, irpefAddizionale: 0.55, distanceKm: 6, avgRentMonthly: 450, population: 3400, fascia: '1' },
  { name: 'Domaso', province: 'CO', lat: 46.1541, lng: 9.3314, irpefAddizionale: 0.5, distanceKm: 4, avgRentMonthly: 460, population: 1400, fascia: '1' },
  { name: 'Colico', province: 'LC', lat: 46.1344, lng: 9.3742, irpefAddizionale: 0.6, distanceKm: 8, avgRentMonthly: 480, population: 7800, fascia: '1' },

  // ── COMO — Fascia 1A (10–20 km) ──
  { name: 'Olgiate Comasco', province: 'CO', lat: 45.7843, lng: 8.9678, irpefAddizionale: 0.7, distanceKm: 7, avgRentMonthly: 620, population: 11600, fascia: '1A' },
  { name: 'Lurate Caccivio', province: 'CO', lat: 45.7686, lng: 8.9878, irpefAddizionale: 0.6, distanceKm: 10, avgRentMonthly: 590, population: 10500, fascia: '1A' },
  { name: 'Appiano Gentile', province: 'CO', lat: 45.7361, lng: 8.9814, irpefAddizionale: 0.6, distanceKm: 12, avgRentMonthly: 600, population: 7700, fascia: '1A' },
  { name: 'Cantù', province: 'CO', lat: 45.7382, lng: 9.1271, irpefAddizionale: 0.75, distanceKm: 15, avgRentMonthly: 650, population: 40000, fascia: '1A' },
  { name: 'Mariano Comense', province: 'CO', lat: 45.6999, lng: 9.1773, irpefAddizionale: 0.7, distanceKm: 18, avgRentMonthly: 620, population: 24000, fascia: '1A' },
  { name: 'Erba', province: 'CO', lat: 45.8128, lng: 9.2226, irpefAddizionale: 0.7, distanceKm: 18, avgRentMonthly: 580, population: 16500, fascia: '1A' },
  { name: 'Lomazzo', province: 'CO', lat: 45.7028, lng: 9.0414, irpefAddizionale: 0.65, distanceKm: 14, avgRentMonthly: 580, population: 8500, fascia: '1A' },
  { name: 'Turate', province: 'CO', lat: 45.6596, lng: 9.0044, irpefAddizionale: 0.7, distanceKm: 18, avgRentMonthly: 570, population: 9100, fascia: '1A' },
  { name: 'Fino Mornasco', province: 'CO', lat: 45.7509, lng: 9.0454, irpefAddizionale: 0.6, distanceKm: 10, avgRentMonthly: 600, population: 10000, fascia: '1A' },
  { name: 'Lipomo', province: 'CO', lat: 45.7983, lng: 9.1124, irpefAddizionale: 0.6, distanceKm: 8, avgRentMonthly: 620, population: 5900, fascia: '1A' },
  { name: 'San Fermo della Battaglia', province: 'CO', lat: 45.7892, lng: 9.0652, irpefAddizionale: 0.55, distanceKm: 6, avgRentMonthly: 650, population: 4500, fascia: '1A' },
  { name: 'Montano Lucino', province: 'CO', lat: 45.7810, lng: 9.0500, irpefAddizionale: 0.6, distanceKm: 7, avgRentMonthly: 680, population: 5500, fascia: '1A' },
  { name: 'Grandate', province: 'CO', lat: 45.7771, lng: 9.0640, irpefAddizionale: 0.6, distanceKm: 7, avgRentMonthly: 630, population: 2900, fascia: '1A' },
  { name: 'Casnate con Bernate', province: 'CO', lat: 45.7535, lng: 9.0717, irpefAddizionale: 0.6, distanceKm: 9, avgRentMonthly: 580, population: 5200, fascia: '1A' },
  { name: 'Bulgarograsso', province: 'CO', lat: 45.7695, lng: 8.9453, irpefAddizionale: 0.6, distanceKm: 9, avgRentMonthly: 540, population: 4000, fascia: '1A' },
  { name: 'Guanzate', province: 'CO', lat: 45.7276, lng: 9.0169, irpefAddizionale: 0.6, distanceKm: 12, avgRentMonthly: 560, population: 5700, fascia: '1A' },

  // ════════════════════════════════════════════════════════════════
  // VARESE — Fascia 1 (confine diretto / < 10 km)
  // ════════════════════════════════════════════════════════════════
  { name: 'Lavena Ponte Tresa', province: 'VA', lat: 45.9639, lng: 8.8558, irpefAddizionale: 0.5, distanceKm: 0, avgRentMonthly: 550, population: 5500, fascia: '1' },
  { name: 'Luino', province: 'VA', lat: 46.0017, lng: 8.7467, irpefAddizionale: 0.6, distanceKm: 1, avgRentMonthly: 500, population: 14200, fascia: '1' },
  { name: 'Porto Ceresio', province: 'VA', lat: 45.9075, lng: 8.9042, irpefAddizionale: 0.5, distanceKm: 1, avgRentMonthly: 520, population: 3000, fascia: '1' },
  { name: 'Viggiù', province: 'VA', lat: 45.8700, lng: 8.8960, irpefAddizionale: 0.5, distanceKm: 2, avgRentMonthly: 500, population: 5300, fascia: '1' },
  { name: 'Clivio', province: 'VA', lat: 45.8649, lng: 8.9120, irpefAddizionale: 0.5, distanceKm: 1, avgRentMonthly: 480, population: 1900, fascia: '1' },
  { name: 'Saltrio', province: 'VA', lat: 45.8660, lng: 8.9276, irpefAddizionale: 0.5, distanceKm: 1, avgRentMonthly: 490, population: 3100, fascia: '1' },
  { name: 'Marchirolo', province: 'VA', lat: 45.9363, lng: 8.8371, irpefAddizionale: 0.5, distanceKm: 2, avgRentMonthly: 510, population: 3500, fascia: '1' },
  { name: 'Cugliate-Fabiasco', province: 'VA', lat: 45.9461, lng: 8.8218, irpefAddizionale: 0.5, distanceKm: 3, avgRentMonthly: 500, population: 3200, fascia: '1' },
  { name: 'Valganna', province: 'VA', lat: 45.9134, lng: 8.8150, irpefAddizionale: 0.5, distanceKm: 5, avgRentMonthly: 480, population: 1600, fascia: '1' },
  { name: 'Besano', province: 'VA', lat: 45.8850, lng: 8.8900, irpefAddizionale: 0.5, distanceKm: 2, avgRentMonthly: 480, population: 2500, fascia: '1' },
  { name: 'Bisuschio', province: 'VA', lat: 45.8704, lng: 8.8703, irpefAddizionale: 0.55, distanceKm: 4, avgRentMonthly: 520, population: 4400, fascia: '1' },
  { name: 'Cantello', province: 'VA', lat: 45.8483, lng: 8.8975, irpefAddizionale: 0.5, distanceKm: 3, avgRentMonthly: 530, population: 4700, fascia: '1' },
  { name: 'Arcisate', province: 'VA', lat: 45.8650, lng: 8.8550, irpefAddizionale: 0.6, distanceKm: 5, avgRentMonthly: 550, population: 10000, fascia: '1' },
  { name: 'Maccagno con Pino e Veddasca', province: 'VA', lat: 46.0417, lng: 8.7342, irpefAddizionale: 0.5, distanceKm: 1, avgRentMonthly: 450, population: 3100, fascia: '1' },
  { name: 'Germignaga', province: 'VA', lat: 45.9924, lng: 8.7261, irpefAddizionale: 0.55, distanceKm: 2, avgRentMonthly: 480, population: 3800, fascia: '1' },
  { name: 'Brezzo di Bedero', province: 'VA', lat: 45.9660, lng: 8.6960, irpefAddizionale: 0.5, distanceKm: 5, avgRentMonthly: 450, population: 1100, fascia: '1' },
  { name: 'Castello Cabiaglio', province: 'VA', lat: 45.9070, lng: 8.7690, irpefAddizionale: 0.5, distanceKm: 6, avgRentMonthly: 430, population: 530, fascia: '1' },
  { name: 'Cunardo', province: 'VA', lat: 45.9296, lng: 8.8027, irpefAddizionale: 0.5, distanceKm: 5, avgRentMonthly: 470, population: 2900, fascia: '1' },

  // ── VARESE — Fascia 1A (10–20 km) ──
  { name: 'Varese', province: 'VA', lat: 45.8183, lng: 8.8249, irpefAddizionale: 0.8, distanceKm: 12, avgRentMonthly: 650, population: 80000, fascia: '1A' },
  { name: 'Induno Olona', province: 'VA', lat: 45.8542, lng: 8.8375, irpefAddizionale: 0.6, distanceKm: 8, avgRentMonthly: 580, population: 10200, fascia: '1A' },
  { name: 'Gavirate', province: 'VA', lat: 45.8426, lng: 8.7242, irpefAddizionale: 0.6, distanceKm: 15, avgRentMonthly: 530, population: 9300, fascia: '1A' },
  { name: 'Besozzo', province: 'VA', lat: 45.8481, lng: 8.6656, irpefAddizionale: 0.55, distanceKm: 18, avgRentMonthly: 520, population: 9200, fascia: '1A' },
  { name: 'Cittiglio', province: 'VA', lat: 45.8924, lng: 8.6615, irpefAddizionale: 0.55, distanceKm: 14, avgRentMonthly: 480, population: 4000, fascia: '1A' },
  { name: 'Laveno-Mombello', province: 'VA', lat: 45.9104, lng: 8.6144, irpefAddizionale: 0.6, distanceKm: 10, avgRentMonthly: 500, population: 8800, fascia: '1A' },
  { name: 'Tradate', province: 'VA', lat: 45.7115, lng: 8.9043, irpefAddizionale: 0.7, distanceKm: 20, avgRentMonthly: 580, population: 18900, fascia: '1A' },
  { name: 'Saronno', province: 'VA', lat: 45.6249, lng: 9.0399, irpefAddizionale: 0.8, distanceKm: 28, avgRentMonthly: 650, population: 39000, fascia: '1A' },
  { name: 'Sesto Calende', province: 'VA', lat: 45.7272, lng: 8.6314, irpefAddizionale: 0.6, distanceKm: 22, avgRentMonthly: 520, population: 11300, fascia: '1A' },

  // ── VARESE — Fascia 2 ──
  { name: 'Busto Arsizio', province: 'VA', lat: 45.6116, lng: 8.8506, irpefAddizionale: 0.8, distanceKm: 30, avgRentMonthly: 600, population: 84000, fascia: '2' },
  { name: 'Gallarate', province: 'VA', lat: 45.6594, lng: 8.7912, irpefAddizionale: 0.75, distanceKm: 25, avgRentMonthly: 580, population: 54000, fascia: '2' },
  { name: 'Castellanza', province: 'VA', lat: 45.6083, lng: 8.8958, irpefAddizionale: 0.7, distanceKm: 30, avgRentMonthly: 560, population: 14400, fascia: '2' },

  // ════════════════════════════════════════════════════════════════
  // VERBANO-CUSIO-OSSOLA — Fascia 1
  // ════════════════════════════════════════════════════════════════
  { name: 'Verbania', province: 'VB', lat: 45.9257, lng: 8.5528, irpefAddizionale: 0.7, distanceKm: 5, avgRentMonthly: 500, population: 30000, fascia: '1' },
  { name: 'Domodossola', province: 'VB', lat: 46.1140, lng: 8.2922, irpefAddizionale: 0.65, distanceKm: 3, avgRentMonthly: 450, population: 18000, fascia: '1' },
  { name: 'Cannobio', province: 'VB', lat: 46.0588, lng: 8.6917, irpefAddizionale: 0.5, distanceKm: 1, avgRentMonthly: 480, population: 5100, fascia: '1' },
  { name: 'Stresa', province: 'VB', lat: 45.8833, lng: 8.5333, irpefAddizionale: 0.55, distanceKm: 8, avgRentMonthly: 550, population: 5000, fascia: '1' },
  { name: 'Baveno', province: 'VB', lat: 45.9058, lng: 8.5048, irpefAddizionale: 0.5, distanceKm: 7, avgRentMonthly: 500, population: 5000, fascia: '1' },
  { name: 'Omegna', province: 'VB', lat: 45.8769, lng: 8.4081, irpefAddizionale: 0.6, distanceKm: 10, avgRentMonthly: 450, population: 15700, fascia: '1' },
  { name: 'Gravellona Toce', province: 'VB', lat: 45.9289, lng: 8.4337, irpefAddizionale: 0.55, distanceKm: 8, avgRentMonthly: 430, population: 7800, fascia: '1' },
  { name: 'Villadossola', province: 'VB', lat: 46.0684, lng: 8.2636, irpefAddizionale: 0.6, distanceKm: 5, avgRentMonthly: 400, population: 6800, fascia: '1' },
  { name: 'Crevoladossola', province: 'VB', lat: 46.1519, lng: 8.3014, irpefAddizionale: 0.5, distanceKm: 2, avgRentMonthly: 380, population: 4700, fascia: '1' },
  { name: 'Varzo', province: 'VB', lat: 46.2050, lng: 8.2526, irpefAddizionale: 0.5, distanceKm: 1, avgRentMonthly: 350, population: 2100, fascia: '1' },
  { name: 'Trasquera', province: 'VB', lat: 46.2189, lng: 8.2068, irpefAddizionale: 0.4, distanceKm: 0, avgRentMonthly: 320, population: 200, fascia: '1' },
  { name: 'Cannero Riviera', province: 'VB', lat: 46.0186, lng: 8.6688, irpefAddizionale: 0.5, distanceKm: 3, avgRentMonthly: 500, population: 1000, fascia: '1' },
  { name: 'Ghiffa', province: 'VB', lat: 45.9527, lng: 8.5888, irpefAddizionale: 0.5, distanceKm: 5, avgRentMonthly: 480, population: 2400, fascia: '1' },
  { name: 'Oggebbio', province: 'VB', lat: 45.9820, lng: 8.6410, irpefAddizionale: 0.5, distanceKm: 4, avgRentMonthly: 460, population: 870, fascia: '1' },

  // ════════════════════════════════════════════════════════════════
  // SONDRIO — Fascia 1
  // ════════════════════════════════════════════════════════════════
  { name: 'Chiavenna', province: 'SO', lat: 46.3217, lng: 9.3997, irpefAddizionale: 0.6, distanceKm: 3, avgRentMonthly: 400, population: 7200, fascia: '1' },
  { name: 'Tirano', province: 'SO', lat: 46.2167, lng: 10.1667, irpefAddizionale: 0.6, distanceKm: 2, avgRentMonthly: 380, population: 9100, fascia: '1' },
  { name: 'Livigno', province: 'SO', lat: 46.5384, lng: 10.1357, irpefAddizionale: 0.4, distanceKm: 0, avgRentMonthly: 600, population: 6700, fascia: '1' },
  { name: 'Bormio', province: 'SO', lat: 46.4679, lng: 10.3709, irpefAddizionale: 0.5, distanceKm: 4, avgRentMonthly: 550, population: 4100, fascia: '1' },
  { name: 'Madesimo', province: 'SO', lat: 46.4333, lng: 9.3500, irpefAddizionale: 0.5, distanceKm: 2, avgRentMonthly: 500, population: 560, fascia: '1' },
  { name: 'Campodolcino', province: 'SO', lat: 46.3987, lng: 9.3500, irpefAddizionale: 0.5, distanceKm: 3, avgRentMonthly: 380, population: 1000, fascia: '1' },
  { name: 'Villa di Chiavenna', province: 'SO', lat: 46.3350, lng: 9.4050, irpefAddizionale: 0.5, distanceKm: 2, avgRentMonthly: 370, population: 1100, fascia: '1' },
  { name: 'Piuro', province: 'SO', lat: 46.3350, lng: 9.4210, irpefAddizionale: 0.5, distanceKm: 2, avgRentMonthly: 360, population: 2000, fascia: '1' },
  { name: 'Novate Mezzola', province: 'SO', lat: 46.2218, lng: 9.4536, irpefAddizionale: 0.5, distanceKm: 6, avgRentMonthly: 380, population: 1800, fascia: '1' },
  { name: 'Valdidentro', province: 'SO', lat: 46.4875, lng: 10.2819, irpefAddizionale: 0.5, distanceKm: 3, avgRentMonthly: 480, population: 4100, fascia: '1' },
  { name: 'Valfurva', province: 'SO', lat: 46.4483, lng: 10.4667, irpefAddizionale: 0.5, distanceKm: 5, avgRentMonthly: 420, population: 2600, fascia: '1' },

  // ── SONDRIO — Fascia 1A ──
  { name: 'Sondrio', province: 'SO', lat: 46.1700, lng: 9.8727, irpefAddizionale: 0.7, distanceKm: 15, avgRentMonthly: 420, population: 21500, fascia: '1A' },
  { name: 'Morbegno', province: 'SO', lat: 46.1362, lng: 9.5731, irpefAddizionale: 0.6, distanceKm: 12, avgRentMonthly: 400, population: 12300, fascia: '1A' },
  { name: 'Sondalo', province: 'SO', lat: 46.3333, lng: 10.3333, irpefAddizionale: 0.55, distanceKm: 8, avgRentMonthly: 400, population: 4100, fascia: '1A' },
  { name: 'Teglio', province: 'SO', lat: 46.1717, lng: 10.0667, irpefAddizionale: 0.55, distanceKm: 10, avgRentMonthly: 370, population: 4700, fascia: '1A' },

  // ════════════════════════════════════════════════════════════════
  // LECCO — Comuni di confine lacustre
  // ════════════════════════════════════════════════════════════════
  { name: 'Lecco', province: 'LC', lat: 45.8566, lng: 9.3977, irpefAddizionale: 0.8, distanceKm: 25, avgRentMonthly: 650, population: 48000, fascia: '1A' },
  { name: 'Bellano', province: 'LC', lat: 46.0422, lng: 9.3014, irpefAddizionale: 0.55, distanceKm: 10, avgRentMonthly: 480, population: 3300, fascia: '1' },
  { name: 'Varenna', province: 'LC', lat: 46.0107, lng: 9.2836, irpefAddizionale: 0.5, distanceKm: 12, avgRentMonthly: 600, population: 750, fascia: '1' },
  { name: 'Mandello del Lario', province: 'LC', lat: 45.9143, lng: 9.3170, irpefAddizionale: 0.6, distanceKm: 18, avgRentMonthly: 530, population: 10500, fascia: '1A' },
  { name: 'Merate', province: 'LC', lat: 45.6953, lng: 9.4206, irpefAddizionale: 0.7, distanceKm: 30, avgRentMonthly: 600, population: 15100, fascia: '2' },
];

type ColorMode = 'irpef' | 'distance' | 'rent';

// ─── Component ───────────────────────────────────────────────

const BorderMunicipalitiesMap: React.FC = () => {
  const { t } = useTranslation();
  const [colorMode, setColorMode] = useState<ColorMode>('irpef');
  const [selectedMunicipality, setSelectedMunicipality] = useState<Municipality | null>(null);
  const [filterProvince, setFilterProvince] = useState<string>('all');

  const provinces = useMemo(() => {
    const set = new Set(MUNICIPALITIES.map(m => m.province));
    return ['all', ...Array.from(set).sort()];
  }, []);

  const filtered = useMemo(() => {
    return filterProvince === 'all' ? MUNICIPALITIES : MUNICIPALITIES.filter(m => m.province === filterProvince);
  }, [filterProvince]);

  // Color functions
  const getColor = (m: Municipality): string => {
    switch (colorMode) {
      case 'irpef': {
        if (m.irpefAddizionale <= 0.5) return '#22c55e'; // green
        if (m.irpefAddizionale <= 0.65) return '#eab308'; // yellow
        return '#ef4444'; // red
      }
      case 'distance': {
        if (m.distanceKm <= 5) return '#22c55e';
        if (m.distanceKm <= 15) return '#eab308';
        return '#ef4444';
      }
      case 'rent': {
        if (m.avgRentMonthly <= 500) return '#22c55e';
        if (m.avgRentMonthly <= 650) return '#eab308';
        return '#ef4444';
      }
    }
  };

  const getRadius = (m: Municipality): number => {
    const pop = m.population;
    if (pop > 50000) return 12;
    if (pop > 20000) return 9;
    if (pop > 10000) return 7;
    return 5;
  };

  // Map center: adjusted to cover CO/VA/VB/SO/LC spread
  const center: [number, number] = [46.00, 9.10];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-teal-50 to-cyan-50 dark:from-teal-950/30 dark:to-cyan-950/30 rounded-2xl p-6 border border-teal-200 dark:border-teal-800">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-teal-100 dark:bg-teal-900/50 rounded-xl">
            <MapPin className="w-6 h-6 text-teal-600 dark:text-teal-400" />
          </div>
          <h2 className="text-2xl font-bold text-teal-900 dark:text-teal-100">{t('bordermap.title')}</h2>
        </div>
        <p className="text-teal-700 dark:text-teal-300 text-sm">{t('bordermap.subtitle')}</p>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700 flex flex-wrap gap-3 items-center">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-bold text-slate-600 dark:text-slate-300">{t('bordermap.colorBy')}:</span>
        </div>
        {([
          { mode: 'irpef' as const, label: t('bordermap.mode.irpef') },
          { mode: 'distance' as const, label: t('bordermap.mode.distance') },
          { mode: 'rent' as const, label: t('bordermap.mode.rent') },
        ]).map(({ mode, label }) => (
          <button
            key={mode}
            onClick={() => setColorMode(mode)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
              colorMode === mode
                ? 'bg-teal-600 text-white'
                : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
            }`}
          >
            {label}
          </button>
        ))}

        <span className="text-slate-300 dark:text-slate-600">|</span>

        <select
          value={filterProvince}
          onChange={(e) => setFilterProvince(e.target.value)}
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-0"
        >
          {provinces.map(p => (
            <option key={p} value={p}>{p === 'all' ? t('bordermap.allProvinces') : p}</option>
          ))}
        </select>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-green-500" />
          <span className="text-slate-600 dark:text-slate-400">
            {colorMode === 'irpef' ? '≤ 0.5%' : colorMode === 'distance' ? '≤ 5 km' : '≤ €500'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-yellow-500" />
          <span className="text-slate-600 dark:text-slate-400">
            {colorMode === 'irpef' ? '0.5–0.65%' : colorMode === 'distance' ? '5–15 km' : '€500–650'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-red-500" />
          <span className="text-slate-600 dark:text-slate-400">
            {colorMode === 'irpef' ? '> 0.65%' : colorMode === 'distance' ? '> 15 km' : '> €650'}
          </span>
        </div>
        <div className="flex items-center gap-1 text-slate-400">
          <Info className="w-3 h-3" />
          {t('bordermap.sizeByPop')}
        </div>
      </div>

      {/* Map */}
      <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 h-[500px]">
        <MapContainer center={center} zoom={9} style={{ height: '100%', width: '100%' }} scrollWheelZoom={true}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {/* Border crossings as markers */}
          {borderCrossings.map((bc, i) => (
            <CircleMarker
              key={`bc-${i}`}
              center={[bc.lat, bc.lng]}
              radius={4}
              pathOptions={{ color: '#1e40af', fillColor: '#3b82f6', fillOpacity: 0.9, weight: 2 }}
            >
              <Popup>
                <div className="text-xs">
                  <p className="font-bold">{bc.name}</p>
                  <p>{bc.type} — {bc.hours}</p>
                  <p>⏱ AM: {bc.avgWaitMorning}</p>
                </div>
              </Popup>
            </CircleMarker>
          ))}

          {/* Municipalities */}
          {filtered.map((m, i) => (
            <CircleMarker
              key={`m-${i}`}
              center={[m.lat, m.lng]}
              radius={getRadius(m)}
              pathOptions={{ color: getColor(m), fillColor: getColor(m), fillOpacity: 0.6, weight: 2 }}
              eventHandlers={{
                click: () => setSelectedMunicipality(m),
              }}
            >
              <Popup>
                <div className="text-xs space-y-1 min-w-[180px]">
                  <p className="font-black text-sm">{m.name}</p>
                  <p className="text-slate-500">{m.province} — {t('bordermap.fascia')} {m.fascia}</p>
                  <hr />
                  <p>📊 IRPEF add.: <b>{m.irpefAddizionale}%</b></p>
                  <p>📏 {t('bordermap.distCrossing')}: <b>{m.distanceKm} km</b></p>
                  <p>🏠 {t('bordermap.avgRent')}: <b>€{m.avgRentMonthly}/mese</b></p>
                  <p>👥 {t('bordermap.pop')}: <b>{m.population.toLocaleString('it-IT')}</b></p>
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>

      {/* Selected municipality detail card */}
      {selectedMunicipality && (
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-black text-slate-800 dark:text-slate-200">{selectedMunicipality.name}</h3>
            <span className="text-xs px-2 py-1 rounded-full bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 font-bold">
              {t('bordermap.fascia')} {selectedMunicipality.fascia}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
            <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
              <p className="text-xs text-slate-400">{t('bordermap.mode.irpef')}</p>
              <p className="text-xl font-black text-slate-800 dark:text-slate-200">{selectedMunicipality.irpefAddizionale}%</p>
            </div>
            <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
              <p className="text-xs text-slate-400">{t('bordermap.distCrossing')}</p>
              <p className="text-xl font-black text-slate-800 dark:text-slate-200">{selectedMunicipality.distanceKm} km</p>
            </div>
            <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
              <p className="text-xs text-slate-400">{t('bordermap.avgRent')}</p>
              <p className="text-xl font-black text-slate-800 dark:text-slate-200">€{selectedMunicipality.avgRentMonthly}</p>
            </div>
            <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
              <p className="text-xs text-slate-400">{t('bordermap.pop')}</p>
              <p className="text-xl font-black text-slate-800 dark:text-slate-200">{selectedMunicipality.population.toLocaleString('it-IT')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Info box */}
      <div className="bg-amber-50 dark:bg-amber-950/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-700 dark:text-amber-300">{t('bordermap.disclaimer')}</p>
      </div>
    </div>
  );
};

export default BorderMunicipalitiesMap;
