import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", "[data-theme='dark']"],
  theme: {
    extend: {
      colors: {
        background: "var(--ct-color-background)",
        foreground: "var(--ct-color-foreground)",
        surface: "var(--ct-color-surface)",
        "surface-raised": "var(--ct-color-surface-raised)",
        border: "var(--ct-color-border)",
        muted: "var(--ct-color-muted)",
        primary: "var(--ct-color-primary)",
        "primary-foreground": "var(--ct-color-primary-foreground)",
        danger: "var(--ct-color-danger)",
        warning: "var(--ct-color-warning)",
        success: "var(--ct-color-success)",
        focus: "var(--ct-color-focus)",
        tooltip: "var(--ct-color-tooltip)",
        "tooltip-foreground": "var(--ct-color-tooltip-foreground)",
        popover: "var(--ct-color-popover)",
        "popover-foreground": "var(--ct-color-popover-foreground)",
        record: "var(--ct-color-record)",
        pause: "var(--ct-color-pause)",
      },
      fontFamily: {
        sans: ["Geist", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Geist", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        sm: "0.25rem",
        DEFAULT: "0.375rem",
        md: "0.5rem",
        lg: "0.75rem",
        xl: "1rem",
      },
      boxShadow: {
        "elevation-1": "0 1px 2px 0 oklch(0 0 0 / 0.18)",
        "elevation-2": "0 4px 12px -2px oklch(0 0 0 / 0.22)",
        "elevation-3": "0 12px 28px -8px oklch(0 0 0 / 0.28)",
      },
      ringColor: {
        focus: "var(--ct-color-focus)",
      },
      transitionTimingFunction: {
        "out-soft": "cubic-bezier(0.22, 1, 0.36, 1)",
      },
      keyframes: {
        "record-pulse": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.6", transform: "scale(0.92)" },
        },
        "fade-out": {
          from: { opacity: "1" },
          to: { opacity: "0" },
        },
      },
      animation: {
        "record-pulse": "record-pulse 1.6s ease-in-out infinite",
        "fade-out": "fade-out 0.8s ease-out forwards",
      },
    },
  },
  plugins: [],
};

export default config;
