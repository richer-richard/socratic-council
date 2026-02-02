/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Agent colors
        george: "#3B82F6", // blue
        cathy: "#A855F7", // purple
        grace: "#22C55E", // green
        douglas: "#F59E0B", // amber
        kate: "#06B6D4", // cyan
        // UI colors
        primary: "#6366F1", // indigo
        secondary: "#8B5CF6", // violet
      },
    },
  },
  plugins: [],
};
