import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Production optimizations
    chunkSizeWarningLimit: 600,
    sourcemap: false,
    minify: "esbuild",
    target: "es2020",
    rollupOptions: {
      output: {
        manualChunks: {
          // Split heavy vendor libraries into separate cacheable chunks
          "vendor-three": ["three", "@react-three/fiber", "@react-three/drei"],
          "vendor-charts": ["recharts"],
        },
      },
    },
  },
  esbuild: {
    // Strip console.log/debug/info in production builds (keep warn/error)
    drop: process.env.NODE_ENV === "production" ? ["debugger"] : [],
    pure:
      process.env.NODE_ENV === "production"
        ? ["console.log", "console.debug", "console.info"]
        : [],
  },
  // Resolve aliases for cleaner imports
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
