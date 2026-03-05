/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Agent colors
        george: "#60A5FA", // blue
        cathy: "#FBBF24", // amber
        grace: "#34D399", // emerald
        douglas: "#F87171", // red
        kate: "#2DD4BF", // teal
        quinn: "#22D3EE", // cyan
        mary: "#F472B6", // rose
        // UI colors
        primary: "#14B8A6", // emerald
        secondary: "#F59E0B", // gold
      },
    },
  },
  plugins: [],
};
