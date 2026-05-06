import { useMemo } from "react";

interface Star {
  id: number;
  x: number;
  y: number;
  size: "small" | "medium" | "large";
  duration: number;
  delay: number;
}

export function Starfield() {
  const stars = useMemo<Star[]>(() => {
    const generated: Star[] = [];
    const count = 150;

    for (let i = 0; i < count; i++) {
      const random = Math.random();
      let size: "small" | "medium" | "large";

      if (random < 0.6) size = "small";
      else if (random < 0.9) size = "medium";
      else size = "large";

      generated.push({
        id: i,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size,
        duration: 2 + Math.random() * 4,
        delay: Math.random() * 5,
      });
    }

    return generated;
  }, []);

  const shootingStars = useMemo(
    () => [
      {
        id: 0,
        startX: -15,
        startY: -15,
        endX: 115,
        endY: 115,
        angle: 30,
        duration: 10,
        delay: 0.5 + Math.random() * 2,
      },
      {
        id: 1,
        startX: -15,
        startY: 30,
        endX: 115,
        endY: 55,
        angle: 12,
        duration: 12,
        delay: 4 + Math.random() * 2,
      },
      {
        id: 2,
        startX: 30,
        startY: -15,
        endX: 55,
        endY: 115,
        angle: 70,
        duration: 13,
        delay: 8 + Math.random() * 2,
      },
    ],
    [],
  );

  return (
    <div className="starfield">
      {stars.map((star) => (
        <div
          key={star.id}
          className={`star star-${star.size}`}
          style={
            {
              left: `${star.x}%`,
              top: `${star.y}%`,
              "--duration": `${star.duration}s`,
              "--delay": `${star.delay}s`,
              "--base-opacity": star.size === "small" ? 0.4 : star.size === "medium" ? 0.6 : 0.8,
              "--peak-opacity": star.size === "small" ? 0.8 : 1,
            } as React.CSSProperties
          }
        />
      ))}
      {shootingStars.map((star) => (
        <div
          key={`shooting-${star.id}`}
          className="shooting-star shooting-star-bright"
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
