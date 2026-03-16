import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '@/services/i18n';

// Unique emoji set (deduplicated) — weights are handled at particle creation
const UNIQUE_EMOJIS = ['🇨🇭', '🪙', '💰', '💶', '💵', '🤑', '🇮🇹', '💳', '🏦', '💎', '✨', '⭐', '🌟', '💫', '🎉', '🎊', '🚀'];

// Weighted distribution: index into UNIQUE_EMOJIS with repetitions for probability
const WEIGHTED_POOL = [
  0,0,0,0,0,0,0,0,   // 🇨🇭 x8
  1,1,1,1,1,1,1,1,1,1, // 🪙 x10
  2,2,2,2,2,2,         // 💰 x6
  3,3,3,3,3,3,3,       // 💶 x7
  4,4,4,4,4,           // 💵 x5
  5,5,5,5,5,5,         // 🤑 x6
  6,6,6,6,6,           // 🇮🇹 x5
  7,7,7,               // 💳 x3
  8,8,                  // 🏦 x2
  9,9,9,               // 💎 x3
  10,10,               // ✨ x2
  11, 12, 13,          // ⭐ 🌟 💫
  14, 15, 16,          // 🎉 🎊 🚀
];

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  rotation: number; rotationSpeed: number;
  scale: number; emojiIdx: number;
  gravity: number;
}

function random(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

/** Pre-render each unique emoji onto an offscreen canvas at a given size. */
function buildEmojiAtlas(emojis: string[], size: number, dpr: number): Map<number, HTMLCanvasElement> {
  const atlas = new Map<number, HTMLCanvasElement>();
  const px = Math.round(size * dpr);
  for (let i = 0; i < emojis.length; i++) {
    const c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    const cx = c.getContext('2d');
    if (!cx) continue;
    cx.font = `${px * 0.8}px serif`;
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillText(emojis[i], px / 2, px / 2);
    atlas.set(i, c);
  }
  return atlas;
}

// Funny reset messages shown sequentially during countdown
const RESET_MESSAGES = [
  { emoji: '☢️', key: 'reset.msg1' },
  { emoji: '🔌', key: 'reset.msg2' },
  { emoji: '🧹', key: 'reset.msg3' },
  { emoji: '🇨🇭', key: 'reset.msg4' },
  { emoji: '🔑', key: 'reset.msg5' },
  { emoji: '🚀', key: 'reset.msg6' },
  { emoji: '✅', key: 'reset.msg7' },
];

/**
 * Canvas-based coin explosion for smooth 60fps animation.
 * Pre-renders emoji sprites once, then uses drawImage() (GPU-accelerated).
 * After explosion: funny countdown messages before page reload.
 */
export default function CoinExplosion({ onComplete }: { onComplete: () => void }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const [phase, setPhase] = useState<'explosion' | 'countdown'>('explosion');
  const [msgIndex, setMsgIndex] = useState(0);

  // Explosion phase
  useEffect(() => {
    if (phase !== 'explosion') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = window.innerWidth;
    const H = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    // Pre-render emoji sprites once (the expensive text shaping happens only here)
    const SPRITE_SIZE = 48;
    const atlas = buildEmojiAtlas(UNIQUE_EMOJIS, SPRITE_SIZE, dpr);

    const centerX = W / 2;
    const centerY = H / 2;

    // Generate 600 particles
    const particles: Particle[] = [];
    for (let i = 0; i < 600; i++) {
      const angle = random(0, Math.PI * 2);
      const speed = random(6, 30);
      particles.push({
        x: centerX + random(-40, 40),
        y: centerY + random(-40, 40),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - random(4, 16),
        rotation: random(0, 360),
        rotationSpeed: random(-18, 18),
        scale: random(0.5, 1.6),
        emojiIdx: WEIGHTED_POOL[Math.floor(Math.random() * WEIGHTED_POOL.length)],
        gravity: random(0.25, 0.55),
      });
    }

    const start = performance.now();
    const DURATION = 1500;
    const FADE_START = 600;
    const flashEl = document.getElementById('coin-flash');
    const halfSprite = SPRITE_SIZE / 2;

    const animate = (now: number) => {
      const elapsed = now - start;

      if (elapsed > DURATION) {
        setPhase('countdown');
        return;
      }

      const globalAlpha = elapsed > FADE_START
        ? Math.max(0, 1 - (elapsed - FADE_START) / (DURATION - FADE_START))
        : 1;

      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = globalAlpha;

      for (const p of particles) {
        // Physics (mutate in place)
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.vx *= 0.988;
        p.rotation += p.rotationSpeed;

        // Draw pre-rendered sprite via drawImage (fast!)
        const sprite = atlas.get(p.emojiIdx);
        if (!sprite) continue;
        const drawSize = SPRITE_SIZE * p.scale;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.drawImage(sprite, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
        ctx.restore();
      }

      if (flashEl && elapsed > 200) {
        flashEl.style.opacity = '0';
      }

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [phase]);

  // Countdown phase — show funny messages then call onComplete
  useEffect(() => {
    if (phase !== 'countdown') return;
    const interval = setInterval(() => {
      setMsgIndex(prev => {
        if (prev >= RESET_MESSAGES.length - 1) {
          clearInterval(interval);
          setTimeout(onComplete, 600);
          return prev;
        }
        return prev + 1;
      });
    }, 700);
    return () => clearInterval(interval);
  }, [phase, onComplete]);

  const overlay = (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Initial golden flash */}
      <div
        id="coin-flash"
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(circle, rgba(250,204,21,0.5) 0%, rgba(255,140,0,0.2) 50%, transparent 70%)',
          transition: 'opacity 150ms ease-out',
        }}
      />

      {/* Canvas for all particles — zero React re-renders */}
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          opacity: phase === 'countdown' ? 0 : 1,
          transition: 'opacity 400ms ease-out',
        }}
      />

      {/* Countdown messages after explosion */}
      {phase === 'countdown' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15, 23, 42, 0.92)',
            animation: 'countdownFadeIn 400ms ease-out',
          }}
        >
          <div style={{ textAlign: 'center', maxWidth: 420, padding: '0 24px' }}>
            {/* Progress bar */}
            <div style={{
              width: 280,
              height: 6,
              borderRadius: 3,
              background: 'rgba(255,255,255,0.15)',
              margin: '0 auto 32px',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                borderRadius: 3,
                background: 'linear-gradient(90deg, #facc15, #f97316)',
                width: `${((msgIndex + 1) / RESET_MESSAGES.length) * 100}%`,
                transition: 'width 500ms ease-out',
              }} />
            </div>

            {/* Current message */}
            <div
              key={msgIndex}
              style={{ animation: 'msgSlideIn 300ms ease-out' }}
            >
              <div style={{ fontSize: 48, marginBottom: 16 }}>
                {RESET_MESSAGES[msgIndex].emoji}
              </div>
              <p style={{
                color: 'white',
                fontSize: 18,
                fontWeight: 600,
                letterSpacing: 0.5,
                margin: 0,
              }}>
                {t(RESET_MESSAGES[msgIndex].key)}…
              </p>
            </div>

            {/* Completed messages (dimmed) */}
            <div style={{ marginTop: 24, opacity: 0.4 }}>
              {RESET_MESSAGES.slice(0, msgIndex).map((msg, i) => (
                <p key={i} style={{
                  color: 'white',
                  fontSize: 12,
                  margin: '4px 0',
                  textDecoration: 'line-through',
                }}>
                  {msg.emoji} {t(msg.key)} ✓
                </p>
              ))}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes countdownFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes msgSlideIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );

  return createPortal(overlay, document.body);
}
