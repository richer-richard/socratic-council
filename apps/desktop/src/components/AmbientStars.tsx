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
  small: { base: 0.3, peak: 0.55 },
  medium: { base: 0.45, peak: 0.7 },
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

  const shootingStars = useMemo(
    () => [
      {
        id: 0,
        startX: -15,
        startY: -10,
        endX: 115,
        endY: 110,
        angle: 32,
        duration: 14,
        delay: 2 + Math.random() * 3,
      },
      {
        id: 1,
        startX: 30,
        startY: -15,
        endX: 60,
        endY: 115,
        angle: 65,
        duration: 16,
        delay: 9 + Math.random() * 3,
      },
    ],
    [],
  );

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
          style={
            {
              "--shoot-start-x": `${star.startX}vw`,
              "--shoot-start-y": `${star.startY}vh`,
              "--shoot-end-x": `${star.endX}vw`,
              "--shoot-end-y": `${star.endY}vh`,
              "--shoot-angle": `${star.angle}deg`,
              "--shoot-duration": `${star.duration}s`,
              animationDelay: `${star.delay}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
