import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Los archivos de test comparten la misma DB: deben correr secuencialmente
    // para que los cleanups no borren datos de otro archivo en paralelo.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
