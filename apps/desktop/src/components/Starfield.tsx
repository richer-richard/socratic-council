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

  const shootingStars = useMemo(() => {
    return Array.from({ length: 3 }, (_, i) => ({
      id: i,
      top: 10 + Math.random() * 30,
      delay: i * 5 + Math.random() * 3,
    }));
  }, []);

  return (
    <div className="starfield">
      {stars.map((star) => (
        <div
          key={star.id}
          className={`star star-${star.size}`}
          style={{
            left: `${star.x}%`,
            top: `${star.y}%`,
            "--duration": `${star.duration}s`,
            "--delay": `${star.delay}s`,
            "--base-opacity": star.size === "small" ? 0.4 : star.size === "medium" ? 0.6 : 0.8,
            "--peak-opacity": star.size === "small" ? 0.8 : 1,
          } as React.CSSProperties}
        />
      ))}
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
