import { useRef, useState } from 'react';
import { PlayCircle } from 'lucide-react';
import { REWARDED_HOUSE_VIDEO_URL } from '@/services/rewardedHouseVideo';

export interface RewardedHouseVideoProps {
  onStarted?: () => void;
  onCompleted: () => void;
  onUnavailable: () => void;
}

/**
 * Clearly labelled first-party fallback for a consented Google no-fill.
 *
 * It is deliberately separate from GPT: it is not reported as a Google
 * impression and must only be treated as monetized when the asset is backed
 * by a direct sponsor or a GAM House campaign.
 */
export default function RewardedHouseVideo({
  onStarted,
  onCompleted,
  onUnavailable,
}: RewardedHouseVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [started, setStarted] = useState(false);

  const start = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      setStarted(true);
      onStarted?.();
      await video.play();
    } catch {
      setStarted(false);
      onUnavailable();
    }
  };

  return (
    <div className="space-y-3" data-testid="rewarded-house-video">
      <div className="rounded-stripe border border-info-border bg-info-subtle/60 p-3">
        <p className="text-sm font-semibold text-body">Contenuto di supporto Frontaliere Ticino</p>
        <p className="mt-1 text-xs leading-relaxed text-subtle">
          La pubblicità Google non è disponibile in questo momento. Guarda questo breve contenuto del servizio e, al termine, apriremo la candidatura.
        </p>
      </div>

      <video
        ref={videoRef}
        className="aspect-video w-full rounded-stripe bg-black object-cover"
        src={REWARDED_HOUSE_VIDEO_URL}
        preload="auto"
        playsInline
        aria-label="Contenuto di supporto Frontaliere Ticino"
        onEnded={onCompleted}
        onError={onUnavailable}
      />

      {!started && (
        <button
          type="button"
          onClick={start}
          className="inline-flex min-h-[50px] w-full items-center justify-center gap-2 rounded-stripe bg-accent px-4 py-3 text-sm font-semibold text-on-accent shadow-stripe-sm transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          data-testid="rewarded-house-video-start"
        >
          <PlayCircle className="h-4 w-4" aria-hidden="true" />
          Avvia il contenuto e continua
        </button>
      )}

      {started && (
        <p role="status" aria-live="polite" className="text-xs leading-relaxed text-muted">
          Guarda il contenuto fino alla fine per continuare.
        </p>
      )}
    </div>
  );
}
