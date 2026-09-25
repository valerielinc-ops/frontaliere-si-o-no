// components/TicinoSchoolsData.ts
// This file exports the TICINO_SCHOOLS array for lazy loading in FrontierGuide

export type SchoolEntry = {
 name: string;
 type: 'nido' | 'infanzia' | 'elementare' | 'media' | 'superiore';
 city: string;
 address: string;
 website?: string;
 phone?: string;
 nature: 'pubblica' | 'privata' | 'paritaria';
 rating?: number; // 1-5
 notes?: string;
};

export const TICINO_SCHOOLS: SchoolEntry[] = [
 // Nidi (0-3)
 { name: 'Nido comunale di Chiasso', type: 'nido', city: 'Chiasso', nature: 'pubblica', address: 'Via Bossi 2a, 6830 Chiasso', phone: '+41 91 695 06 80', rating: 4 },
 { name: 'Nido L\'Aquilone', type: 'nido', city: 'Mendrisio', nature: 'privata', address: 'Via Penate 4, 6850 Mendrisio', phone: '+41 91 646 43 21', rating: 5, website: 'https://www.nido-aquilone.ch' },
 { name: 'Nido comunale di Stabio', type: 'nido', city: 'Stabio', nature: 'pubblica', address: 'Via Cantonale, 6855 Stabio', phone: '+41 91 647 16 05', rating: 4 },
 { name: 'Nido Il Girotondo', type: 'nido', city: 'Lugano', nature: 'privata', address: 'Via Nassa 21, 6900 Lugano', phone: '+41 91 923 56 78', rating: 5, website: 'https://www.ilgirotondo.ch' },
 { name: 'Nido La Coccinella', type: 'nido', city: 'Lugano', nature: 'privata', address: 'Via Trevano 6, 6900 Lugano', phone: '+41 91 966 31 21', rating: 4 },
 { name: 'Nido comunale di Bellinzona', type: 'nido', city: 'Bellinzona', nature: 'pubblica', address: 'Viale Stazione 18, 6500 Bellinzona', phone: '+41 91 825 21 31', rating: 4 },
 { name: 'Nido L\'Orsacchiotto', type: 'nido', city: 'Locarno', nature: 'privata', address: 'Via della Pace 8, 6600 Locarno', phone: '+41 91 752 18 90', rating: 4 },
 { name: 'Nido comunale di Agno', type: 'nido', city: 'Agno', nature: 'pubblica', address: 'Via Molinazzo 3, 6982 Agno', phone: '+41 91 605 19 20', rating: 4 },
 { name: 'Nido Il Sole', type: 'nido', city: 'Ponte Tresa', nature: 'privata', address: 'Via Lugano 15, 6988 Ponte Tresa', rating: 4 },
 { name: 'Nido Peter Pan', type: 'nido', city: 'Biasca', nature: 'privata', address: 'Via Leventina 3, 6710 Biasca', rating: 3 },

 // Scuola dell'infanzia (3-6)
 { name: 'Scuola dell\'infanzia Chiasso Centro', type: 'infanzia', city: 'Chiasso', nature: 'pubblica', address: 'Via Bossi, 6830 Chiasso', rating: 4 },
 { name: 'Scuola dell\'infanzia Mendrisio', type: 'infanzia', city: 'Mendrisio', nature: 'pubblica', address: 'Via Pontico, 6850 Mendrisio', rating: 4 },
 { name: 'Scuola dell\'infanzia Stabio', type: 'infanzia', city: 'Stabio', nature: 'pubblica', address: 'Via San Pietro, 6855 Stabio', rating: 4 },
 { name: 'Scuola dell\'infanzia Ligornetto', type: 'infanzia', city: 'Ligornetto', nature: 'pubblica', address: 'Via Principale, 6854 Ligornetto', rating: 4 },
 { name: 'Scuola dell\'infanzia Lugano Centro', type: 'infanzia', city: 'Lugano', nature: 'pubblica', address: 'Via Canova, 6900 Lugano', rating: 5 },
 { name: 'Scuola dell\'infanzia Massagno', type: 'infanzia', city: 'Massagno', nature: 'pubblica', address: 'Via San Gottardo, 6900 Massagno', rating: 4 },
 { name: 'Scuola dell\'infanzia Bellinzona', type: 'infanzia', city: 'Bellinzona', nature: 'pubblica', address: 'Viale H. Guisan, 6500 Bellinzona', rating: 4 },
 { name: 'Scuola dell\'infanzia Locarno', type: 'infanzia', city: 'Locarno', nature: 'pubblica', address: 'Via alla Morettina, 6600 Locarno', rating: 4 },
 { name: 'Scuola dell\'infanzia Agno', type: 'infanzia', city: 'Agno', nature: 'pubblica', address: 'Via Molinazzo, 6982 Agno', rating: 4 },
 { name: 'International School of Ticino', type: 'infanzia', city: 'Cadempino', nature: 'privata', address: 'Via Ponteggia 23, 6814 Cadempino', website: 'https://www.isticino.com', phone: '+41 91 971 29 65', rating: 5, notes: 'Curriculum internazionale IB, inglese/italiano' },
 { name: 'TASIS - The American School in Switzerland', type: 'infanzia', city: 'Montagnola', nature: 'privata', address: 'Via Collina d\'Oro 15, 6926 Montagnola', website: 'https://www.tasis.ch', phone: '+41 91 960 51 51', rating: 5, notes: 'Scuola americana, boarding school dal 1956' },

 // Scuola elementare (6-11)
 { name: 'Scuola elementare Chiasso', type: 'elementare', city: 'Chiasso', nature: 'pubblica', address: 'Via Bossi, 6830 Chiasso', rating: 4 },
 { name: 'Scuola elementare Mendrisio', type: 'elementare', city: 'Mendrisio', nature: 'pubblica', address: 'Via Zorzi, 6850 Mendrisio', rating: 4 },
 { name: 'Scuola elementare Stabio', type: 'elementare', city: 'Stabio', nature: 'pubblica', address: 'Via Cantonale, 6855 Stabio', rating: 4 },
 { name: 'Scuola elementare Lugano Centro', type: 'elementare', city: 'Lugano', nature: 'pubblica', address: 'Via Canova 8, 6900 Lugano', rating: 5 },
 { name: 'Scuola elementare Massagno', type: 'elementare', city: 'Massagno', nature: 'pubblica', address: 'Via San Gottardo, 6900 Massagno', rating: 4 },
 { name: 'Scuola elementare Viganello', type: 'elementare', city: 'Lugano', nature: 'pubblica', address: 'Via San Gottardo 54, 6962 Viganello', rating: 4 },
 { name: 'Scuola elementare Bellinzona', type: 'elementare', city: 'Bellinzona', nature: 'pubblica', address: 'Piazza Governo, 6500 Bellinzona', rating: 4 },
 { name: 'Scuola elementare Locarno', type: 'elementare', city: 'Locarno', nature: 'pubblica', address: 'Via Varesi, 6600 Locarno', rating: 4 },
 { name: 'Scuola elementare Biasca', type: 'elementare', city: 'Biasca', nature: 'pubblica', address: 'Via Leventina, 6710 Biasca', rating: 3 },
 { name: 'International School of Ticino (Primary)', type: 'elementare', city: 'Cadempino', nature: 'privata', address: 'Via Ponteggia 23, 6814 Cadempino', website: 'https://www.isticino.com', rating: 5, notes: 'Programma IB PYP, bilingue inglese/italiano' },
 { name: 'TASIS Elementary', type: 'elementare', city: 'Montagnola', nature: 'privata', address: 'Via Collina d\'Oro 15, 6926 Montagnola', website: 'https://www.tasis.ch', rating: 5, notes: 'Curriculum americano, ambiente internazionale' },

 // Scuola media (11-15)
 { name: 'Scuola media Chiasso', type: 'media', city: 'Chiasso', nature: 'pubblica', address: 'Via Livio 4, 6830 Chiasso', phone: '+41 91 816 41 11', rating: 4 },
 { name: 'Scuola media Mendrisio', type: 'media', city: 'Mendrisio', nature: 'pubblica', address: 'Via Industria, 6850 Mendrisio', phone: '+41 91 816 41 41', rating: 4 },
 { name: 'Scuola media Stabio', type: 'media', city: 'Stabio', nature: 'pubblica', address: 'Via Cantonale, 6855 Stabio', phone: '+41 91 816 41 61', rating: 4 },
 { name: 'Scuola media Lugano 1 (Besso)', type: 'media', city: 'Lugano', nature: 'pubblica', address: 'Via Besso 10, 6900 Lugano', phone: '+41 91 816 41 81', rating: 5, notes: 'Una delle scuole medie più grandi del cantone' },
 { name: 'Scuola media Lugano 2 (Pregassona)', type: 'media', city: 'Lugano', nature: 'pubblica', address: 'Via Pregassona, 6963 Pregassona', phone: '+41 91 816 42 01', rating: 4 },
 { name: 'Scuola media Viganello', type: 'media', city: 'Lugano', nature: 'pubblica', address: 'Via San Gottardo, 6962 Viganello', phone: '+41 91 816 42 21', rating: 4 },
 { name: 'Scuola media Bellinzona', type: 'media', city: 'Bellinzona', nature: 'pubblica', address: 'Via Nizzola 3, 6500 Bellinzona', phone: '+41 91 816 42 51', rating: 4 },
 { name: 'Scuola media Locarno', type: 'media', city: 'Locarno', nature: 'pubblica', address: 'Via Varesi, 6600 Locarno', phone: '+41 91 816 42 81', rating: 4 },
 { name: 'Scuola media Gordola', type: 'media', city: 'Gordola', nature: 'pubblica', address: 'Via Cantonale, 6596 Gordola', rating: 3 },
 { name: 'Scuola media Agno', type: 'media', city: 'Agno', nature: 'pubblica', address: 'Via Molinazzo, 6982 Agno', phone: '+41 91 816 42 91', rating: 4 },
 { name: 'Scuola media Ambrì', type: 'media', city: 'Ambrì', nature: 'pubblica', address: 'Via Leventina, 6775 Ambrì', rating: 3 },

 // Scuola superiore (15-19)
 { name: 'Liceo cantonale di Lugano 1', type: 'superiore', city: 'Lugano', nature: 'pubblica', address: 'Viale Carlo Cattaneo 4, 6900 Lugano', website: 'https://www.liceolugano.ch', phone: '+41 91 815 31 11', rating: 5, notes: 'Il più antico liceo del Ticino, fondato nel 1852' },
 { name: 'Liceo cantonale di Lugano 2', type: 'superiore', city: 'Savosa', nature: 'pubblica', address: 'Via Trevano, 6942 Savosa', website: 'https://www.liceolugano2.ch', phone: '+41 91 815 31 41', rating: 5 },
 { name: 'Liceo cantonale di Mendrisio', type: 'superiore', city: 'Mendrisio', nature: 'pubblica', address: 'Via dei Fichi, 6850 Mendrisio', website: 'https://www.liceomendrisio.ch', phone: '+41 91 816 58 11', rating: 5 },
 { name: 'Liceo cantonale di Bellinzona', type: 'superiore', city: 'Bellinzona', nature: 'pubblica', address: 'Viale Franscini 31, 6500 Bellinzona', website: 'https://www.liceobellinzona.ch', phone: '+41 91 814 18 11', rating: 5 },
 { name: 'Liceo cantonale di Locarno', type: 'superiore', city: 'Locarno', nature: 'pubblica', address: 'Via Cappuccini 46, 6600 Locarno', website: 'https://www.liceolocarno.ch', phone: '+41 91 816 06 11', rating: 4 },
 { name: 'Scuola cantonale di commercio (SCC)', type: 'superiore', city: 'Bellinzona', nature: 'pubblica', address: 'Viale Franscini 32, 6500 Bellinzona', website: 'https://www.scc.ti.ch', phone: '+41 91 814 01 11', rating: 4, notes: 'Formazione commerciale AFC + maturità professionale' },
 { name: 'Centro professionale commerciale (CPC) Lugano', type: 'superiore', city: 'Lugano', nature: 'pubblica', address: 'Via Brentani 18, 6900 Lugano', phone: '+41 91 815 10 11', rating: 4, notes: 'Apprendistato commerciale e maturità professionale' },
 { name: 'Centro professionale tecnico (CPT) Lugano-Trevano', type: 'superiore', city: 'Lugano', nature: 'pubblica', address: 'Via Trevano, 6952 Canobbio', website: 'https://www.cpttrevano.ti.ch', phone: '+41 91 815 10 51', rating: 4, notes: 'Formazione tecnica: informatica, elettronica, meccanica' },
 { name: 'SPAI Mendrisio', type: 'superiore', city: 'Mendrisio', nature: 'pubblica', address: 'Via Motta 7, 6850 Mendrisio', phone: '+41 91 816 58 31', rating: 4, notes: 'Scuola professionale artigianato e industria' },
 { name: 'TASIS High School', type: 'superiore', city: 'Montagnola', nature: 'privata', address: 'Via Collina d\'Oro 15, 6926 Montagnola', website: 'https://www.tasis.ch', phone: '+41 91 960 51 51', rating: 5, notes: 'American High School Diploma + IB Diploma, boarding' },
 { name: 'International School of Ticino (Secondary)', type: 'superiore', city: 'Cadempino', nature: 'privata', address: 'Via Ponteggia 23, 6814 Cadempino', website: 'https://www.isticino.com', phone: '+41 91 971 29 65', rating: 5, notes: 'IB MYP e DP, bilingue' },
 { name: 'Liceo artistico (CSIA)', type: 'superiore', city: 'Lugano', nature: 'pubblica', address: 'Via Brentani 16, 6900 Lugano', phone: '+41 91 815 10 71', rating: 4, notes: 'Arte, design e comunicazione visiva' },
];
