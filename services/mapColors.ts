// Shared color constants for map/chart components that can't use Tailwind classes
// Uses Tailwind's color values for consistency
export const MAP_COLORS = {
 // Traffic-light status (green/yellow/red)
 success: '#22c55e', // green-500
 warning: '#eab308', // yellow-500
 danger: '#ef4444', // red-500

 // Score-based (positive/neutral/negative)
 positive: '#10b981', // emerald-500
 caution: '#f59e0b', // amber-500
 negative: '#ef4444', // red-500

 // Neutral / fallback
 neutral: '#94a3b8', // slate-400

 // Map markers and fills
 primary: '#3b82f6', // blue-500
 primaryStroke: '#1e40af', // blue-800
 accent: '#4f46e5', // indigo-600

 // Country-coded borders (Leaflet pathOptions)
 countryCH: '#dc2626', // red-600
 countryIT: '#16a34a', // green-600
} as const;
