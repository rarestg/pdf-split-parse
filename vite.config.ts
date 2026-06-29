import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the built static site works whether it is served from a
// domain root (e.g. *.pages.dev / a custom domain) or from a subpath.
export default defineConfig({
  base: './',
  plugins: [react()],
});
