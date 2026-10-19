import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { buildManifest, type Target } from './src/manifest.ts'

const target = (process.env.TARGET ?? 'chrome') as Target

// Writes manifest.json for the chosen browser into the build output.
function manifest(): Plugin {
  return {
    name: 'lockedin-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(buildManifest(target), null, 2),
      })
    },
  }
}

export default defineConfig({
  root: 'src',
  plugins: [manifest()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist', target),
    // The content-script build writes into the same folder, so don't wipe it (npm run build cleans dist first).
    emptyOutDir: false,
    // Extension pages run in modern browsers, so the modulepreload polyfill is dead weight.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, 'src/background.ts'),
        popup: resolve(import.meta.dirname, 'src/pages/popup.html'),
        options: resolve(import.meta.dirname, 'src/pages/options.html'),
        blocked: resolve(import.meta.dirname, 'src/pages/blocked.html'),
      },
      output: {
        entryFileNames: '[name].js',
        // Chrome rejects files whose names start with "_", so keep chunk names explicit.
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
