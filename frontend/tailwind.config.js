/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Inter first, then the platform's own UI face if the bundled file
        // ever fails to load — never a serif fallback on a console screen.
        sans: [
          "Inter Variable", "Inter",
          "Segoe UI", "system-ui", "-apple-system", "Roboto",
          "Helvetica Neue", "Arial", "sans-serif",
          "Apple Color Emoji", "Segoe UI Emoji",
        ],
      },
      colors: {
        navy: {
          950: "#0b1626",
          900: "#0f1f38",
          800: "#16314f",
          700: "#1d4368",
        },
        toyotared: "#eb0a1e",
        // Page background. Slightly cooler and flatter than slate-50 so white
        // cards read as raised surfaces rather than blending into the page —
        // the separation enterprise consoles rely on instead of borders.
        canvas: "#f5f7fa",
      },
      boxShadow: {
        // Low-spread, low-opacity shadows: at a glance they look like depth,
        // not like a drop shadow. Anything heavier starts to look consumer.
        card: "0 1px 2px rgba(15, 31, 56, 0.04), 0 2px 8px rgba(15, 31, 56, 0.05)",
        cardHover: "0 2px 4px rgba(15, 31, 56, 0.06), 0 8px 24px rgba(15, 31, 56, 0.10)",
      },
      transitionTimingFunction: {
        // Settles rather than bounces — the difference between a control room
        // and a marketing page.
        enterprise: "cubic-bezier(0.22, 0.61, 0.36, 1)",
      },
      borderRadius: {
        xl2: "1.1rem",
      },
    },
  },
  plugins: [],
};
