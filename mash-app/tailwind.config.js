/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // UND-Inspired Palette (Black, Gray, Green)
        "bg-primary": "#000000",
        "bg-surface": "#111111",
        "bg-elevated": "#1F1F1F",
        accent: "#009A44", // UND Green
        success: "#009A44", // Match accent
        warning: "#F59E0B",
        danger: "#EF4444",
        "text-primary": "#FFFFFF",
        "text-secondary": "#A3A3A3",
        border: "#333333",
        "und-gray": "#A7A9AC",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
  safelist: [
    "bg-accent",
    "bg-warning",
    "bg-danger",
    "bg-accent/60",
    "bg-accent/80",
    "text-accent",
    "text-accent/80",
    "text-warning",
    "text-danger",
  ],
};
