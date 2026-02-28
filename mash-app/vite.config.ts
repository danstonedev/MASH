import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Production optimizations
    chunkSizeWarningLimit: 600,
    sourcemap: false, // Disable sourcemaps in production for smaller bundles
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React - loaded immediately
          "react-vendor": ["react", "react-dom"],

          // Three.js ecosystem - lazy loaded with 3D view
          "three-vendor": ["three", "@react-three/fiber", "@react-three/drei"],

          // Charting - lazy loaded when viewing analytics
          "charts-vendor": ["recharts", "uplot"],

          // State management - loaded with app shell
          zustand: ["zustand"],

          // UI utilities
          "ui-vendor": [
            "framer-motion",
            "lucide-react",
            "clsx",
            "tailwind-merge",
          ],
        },
      },
    },
    // Minification
    minify: "esbuild",
    target: "es2020",
  },
  // Resolve aliases for cleaner imports
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
