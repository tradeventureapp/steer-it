import { defineConfig } from 'vite';
import { resolve } from 'path';

// Rewrites `/play` → `/play.html` in dev so the QR-encoded URL works without
// a `.html` extension. For prod (Vercel), see `vercel.json`.
const playRouteRewrite = {
  name: 'play-route-rewrite',
  configureServer(server: any) {
    server.middlewares.use((req: any, _res: any, next: any) => {
      if (!req.url) return next();
      const path = req.url.split('?')[0];
      if (path === '/play') {
        const qIdx = req.url.indexOf('?');
        const qs = qIdx >= 0 ? req.url.slice(qIdx) : '';
        req.url = '/play.html' + qs;
      }
      next();
    });
  },
};

export default defineConfig({
  server: { host: true },
  plugins: [playRouteRewrite],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play.html'),
      },
    },
  },
});
