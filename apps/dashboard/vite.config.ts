import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    minify: "oxc",
    // Source maps are never published: nginx serves /assets only and the maps
    // would expose source. Upload them to the error tracker in CI instead.
    sourcemap: false,
    cssCodeSplit: true,
    chunkSizeWarningLimit: 500,
    reportCompressedSize: true,
    rolldownOptions: {
      output: {
        // Stable vendor chunks: they change far less often than app code, so
        // browsers keep them cached across releases (hashed, immutable).
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: "vendor-ui",
              test: /node_modules[\\/](@chakra-ui|@emotion|@ark-ui|@zag-js|@floating-ui)[\\/]/,
              priority: 20,
            },
            {
              name: "vendor-data",
              test: /node_modules[\\/](@tanstack|@reduxjs|react-redux|redux|immer|reselect|zod|react-hook-form|@hookform|oidc-client-ts)[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/devices": {
        target: "http://127.0.0.1:3001",
        rewrite: (path) => path.replace(/^\/api\/devices/, ""),
      },
      "/api/telemetry": {
        target: "http://127.0.0.1:8080",
        rewrite: (path) => path.replace(/^\/api\/telemetry/, ""),
      },
      "/graphql": { target: "http://127.0.0.1:4002", ws: true },
      "/api/v1/subscription-ticket": { target: "http://127.0.0.1:4002" },
    },
  },
});
