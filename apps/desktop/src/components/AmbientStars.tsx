import { useMemo } from "react";

interface Star {
  id: number;
  x: number;
  y: number;
  size: "small" | "medium";
  duration: number;
  delay: number;
}

const STAR_OPACITY = {
  small: { base: 0.15, peak: 0.35 },
  medium: { base: 0.25, peak: 0.45 },
} as const;

export function AmbientStars() {
  const stars = useMemo<Star[]>(() => {
    const generated: Star[] = [];
    const count = 50;

    for (let i = 0; i < count; i++) {
      generated.push({
        id: i,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: Math.random() < 0.7 ? "small" : "medium",
        duration: 2.5 + Math.random() * 4,
        delay: Math.random() * 6,
      });
    }

    return generated;
  }, []);

  const shootingStars = useMemo(() => {
    return Array.from({ length: 2 }, (_, i) => ({
      id: i,
      top: 10 + Math.random() * 45,
      delay: i * 6 + Math.random() * 4,
    }));
  }, []);

  return (
    <div className="starfield" aria-hidden="true">
      {stars.map((star) => {
        const opacity = STAR_OPACITY[star.size];
        return (
          <div
            key={star.id}
            className={`star star-${star.size}`}
            style={
              {
                left: `${star.x}%`,
                top: `${star.y}%`,
                "--duration": `${star.duration}s`,
                "--delay": `${star.delay}s`,
                "--base-opacity": opacity.base,
                "--peak-opacity": opacity.peak,
              } as React.CSSProperties
            }
          />
        );
      })}
      {shootingStars.map((star) => (
        <div
          key={`shooting-${star.id}`}
          className="shooting-star"
          style={{
            top: `${star.top}%`,
            animationDelay: `${star.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
