// Elenco scuole Ticino estratto da FrontierGuide.tsx
export interface SchoolEntry {
 name: string;
 type: 'nido' | 'infanzia' | 'elementare' | 'media' | 'superiore';
 city: string;
 address?: string;
 website?: string;
 phone?: string;
 nature: 'pubblica' | 'privata' | 'paritaria';
 rating?: number; // 1-5
 notes?: string;
}

export const TICINO_SCHOOLS: SchoolEntry[] = [
 // ... (copiare qui tutto l'array da FrontierGuide.tsx)
];
