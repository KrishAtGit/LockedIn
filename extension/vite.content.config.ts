import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const target = process.env.TARGET ?? 'chrome'

// Content scripts can't use ES module imports, so the on-page timer is bundled into one
// self-contained file in a separate build, next to the main build's output.
export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, 'dist', target),
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/timer.ts'),
      formats: ['iife'],
      name: 'LockedInTimer',
      fileName: () => 'content/timer.js',
    },
  },
})
