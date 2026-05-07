/**
 * WeatherAttribution — CC-BY mandatory footer block for every page that
 * renders weather data. Met.no TOS specifically requires the textual
 * attribution "Weather forecast from MET Norway" with a link to met.no.
 * Open-Meteo and MeteoSwiss require CC-BY 4.0 attribution too.
 */

import React from 'react';

interface WeatherAttributionProps {
  /** ISO timestamp of the snapshot, displayed alongside the credit. */
  generatedAt?: string;
  className?: string;
}

const WeatherAttribution = ({ generatedAt, className = '' }: WeatherAttributionProps): React.ReactElement => {
  const formatted = generatedAt ? formatTs(generatedAt) : null;
  return (
    <p className={`text-xs text-muted leading-relaxed ${className}`} data-testid="weather-attribution">
      <span>Dati: </span>
      <a href="https://open-meteo.com/" rel="noopener" target="_blank" className="hover:text-link underline-offset-2 hover:underline">
        Open-Meteo
      </a>
      <span> · </span>
      <a href="https://www.met.no/" rel="noopener" target="_blank" className="hover:text-link underline-offset-2 hover:underline">
        Weather forecast from MET Norway
      </a>
      <span> · </span>
      <a href="https://www.meteoswiss.admin.ch/" rel="noopener" target="_blank" className="hover:text-link underline-offset-2 hover:underline">
        MeteoSwiss
      </a>
      {formatted ? (
        <>
          <span> · </span>
          <time dateTime={generatedAt}>Aggiornato {formatted}</time>
        </>
      ) : null}
      <span> · </span>
      <a href="https://creativecommons.org/licenses/by/4.0/" rel="noopener" target="_blank" className="hover:text-link underline-offset-2 hover:underline">
        CC-BY 4.0
      </a>
    </p>
  );
};

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm} ${hh}:${mi}`;
  } catch {
    return iso;
  }
}

export default WeatherAttribution;
