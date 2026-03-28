const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function buildStarfield() {
  const starfield = document.querySelector("[data-starfield]");
  if (!starfield) {
    return;
  }

  const fragment = document.createDocumentFragment();
  const count = 56;

  for (let index = 0; index < count; index += 1) {
    const star = document.createElement("span");
    const size = Math.random() * 1.9 + 0.8;

    star.className = "star";
    star.style.left = `${Math.random() * 100}%`;
    star.style.top = `${Math.random() * 100}%`;
    star.style.width = `${size}px`;
    star.style.height = `${size}px`;
    star.style.setProperty("--duration", `${2.6 + Math.random() * 3.8}s`);
    star.style.setProperty("--delay", `${Math.random() * 4.5}s`);

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
      threshold: 0.12,
      rootMargin: "0px 0px -8% 0px",
    },
  );

  nodes.forEach((node) => observer.observe(node));
}

function wireTopbar() {
  const update = () => {
    document.body.classList.toggle("is-scrolled", window.scrollY > 20);
  };

  update();
  window.addEventListener("scroll", update, { passive: true });
}

function stampYear() {
  document.querySelectorAll("[data-year]").forEach((node) => {
    node.textContent = String(new Date().getFullYear());
  });
}

buildStarfield();
revealSections();
wireTopbar();
stampYear();
