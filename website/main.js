const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function buildStarfield() {
  const starfield = document.querySelector("[data-starfield]");
  if (!starfield) {
    return;
  }

  const fragment = document.createDocumentFragment();
  const starCount = 110;

  for (let index = 0; index < starCount; index += 1) {
    const star = document.createElement("span");
    const size = Math.random() * 2.4 + 0.8;

    star.className = "star";
    star.style.left = `${Math.random() * 100}%`;
    star.style.top = `${Math.random() * 100}%`;
    star.style.width = `${size}px`;
    star.style.height = `${size}px`;
    star.style.setProperty("--duration", `${2.8 + Math.random() * 4.2}s`);
    star.style.setProperty("--delay", `${Math.random() * 5}s`);

    fragment.appendChild(star);
  }

  starfield.appendChild(fragment);
}

function revealSections() {
  const nodes = document.querySelectorAll(".reveal");

  if (reduceMotion) {
    nodes.forEach((node) => node.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    {
      threshold: 0.14,
      rootMargin: "0px 0px -6% 0px",
    },
  );

  nodes.forEach((node) => observer.observe(node));
}

function wireParallax() {
  if (reduceMotion) {
    return;
  }

  const shell = document.querySelector(".parallax-shell");

  if (!shell) {
    return;
  }

  shell.addEventListener("pointermove", (event) => {
    const rect = shell.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;

    shell.style.setProperty("--shift-x", `${x * 18}px`);
    shell.style.setProperty("--shift-y", `${y * 18}px`);
  });

  shell.addEventListener("pointerleave", () => {
    shell.style.setProperty("--shift-x", "0px");
    shell.style.setProperty("--shift-y", "0px");
  });
}

function stampYear() {
  document.querySelectorAll("[data-year]").forEach((node) => {
    node.textContent = String(new Date().getFullYear());
  });
}

buildStarfield();
revealSections();
wireParallax();
stampYear();
