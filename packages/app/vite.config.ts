import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Inject the app version at build time from package.json. Read here
// (not via `import`) so JSON-import assertions aren't required and the
// version stays in sync with whatever `pnpm version` bumps the field to.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // Audit I-34. Aligned with the `browserslist` field in package.json
    // and the boot-time feature-detect in index.html. esbuild takes a
    // flat list of `browser-name + minimum-version` strings. The four
    // entries here track the same browsers and minimums advertised to
    // users. Bumping a browser's version here without also bumping
    // browserslist / index.html / README would produce silent drift.
    target: ['chrome100', 'firefox100', 'safari15.4', 'edge100'],
    // Audit N-10 — production debugging is currently blind. `sourcemap`
    // emits separate `.map` files alongside each chunk so DevTools maps
    // minified code back to the TS source. Browsers only download the
    // maps when DevTools is open, so end-user payload is unaffected.
    // Source is MIT-licensed and public, so there's no leak concern.
    sourcemap: true,
    // The `importers` chunk lands at ~512 KB because of the vendored
    // xlsx fork (~480 KB minified). xlsx is intrinsic to .xlsx import
    // support and isn't reducible without dynamic-import (a separate
    // slice). 600 gives a little headroom over the current size while
    // still flagging any chunk that grows beyond what's intentional.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Audit N-10 — split the bundle into cache-friendly vendor
        // chunks. Pre-this-config Vite emitted a single ~1.5 MB JS
        // chunk; every code change invalidated the whole download.
        // Grouping by lifecycle:
        //   - react-vendor   — almost never changes
        //   - flow-vendor    — bumps with @xyflow/react or @dagrejs/dagre
        //   - importers      — xlsx (~600 KB vendored) + JSZip + fast-xml-parser
        //   - engines        — workspace engine packages (file-format/
        //                      calendar/scheduler/simulation/engine-worker)
        //   - default chunk  — app UI + remaining small deps
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('/react/') || id.includes('/react-dom/')) {
              return 'react-vendor';
            }
            if (id.includes('/@xyflow/') || id.includes('/@dagrejs/')) {
              return 'flow-vendor';
            }
            // xlsx vendor + JSZip + fast-xml-parser are imported only
            // through @procsim/importers. Pull them into the importers
            // chunk so they cache together and don't bloat engines.
            if (
              id.includes('/xlsx@') ||
              id.includes('/jszip/') ||
              id.includes('/fast-xml-parser/')
            ) {
              return 'importers';
            }
            // Other node_modules deps (zustand, zundo, idb-keyval,
            // html-to-image, etc.) stay in the default chunk — too
            // small individually to warrant their own.
            return undefined;
          }
          // Importers — heavy because of the vendored xlsx fork.
          if (id.includes('/packages/importers/')) return 'importers';
          // Other workspace engine packages — pure, framework-free,
          // change less often than the UI.
          if (id.includes('/packages/file-format/')) return 'engines';
          if (id.includes('/packages/calendar/')) return 'engines';
          if (id.includes('/packages/scheduler/')) return 'engines';
          if (id.includes('/packages/simulation/')) return 'engines';
          if (id.includes('/packages/engine-worker/')) return 'engines';
          return undefined;
        },
      },
    },
  },
});
