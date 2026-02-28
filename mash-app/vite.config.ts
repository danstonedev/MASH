import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Production optimizations
    chunkSizeWarningLimit: 600,
    sourcemap: false, // Disable sourcemaps in production for smaller bundles
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
