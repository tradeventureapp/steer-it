import { defineConfig } from 'vite';
import { resolve } from 'path';

// Rewrites clean routes → their `.html` files in dev so the extension-less URLs
// (the QR-encoded `/play`, and the footer legal links `/terms` `/privacy`
// `/refund`) work without `.html`. For prod (Vercel), see `vercel.json`.
const CLEAN_ROUTES: Record<string, string> = {
  '/play': '/play.html',
  '/terms': '/terms.html',
  '/privacy': '/privacy.html',
  '/refund': '/refund.html',
};
const cleanRouteRewrite = {
  name: 'clean-route-rewrite',
  configureServer(server: any) {
    server.middlewares.use((req: any, _res: any, next: any) => {
      if (!req.url) return next();
      const path = req.url.split('?')[0];
      const target = CLEAN_ROUTES[path];
      if (target) {
        const qIdx = req.url.indexOf('?');
        const qs = qIdx >= 0 ? req.url.slice(qIdx) : '';
        req.url = target + qs;
      }
      next();
    });
  },
};

export default defineConfig({
  server: { host: true, port: Number(process.env.PORT) || 5173 },
  plugins: [cleanRouteRewrite],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play.html'),
        terms: resolve(__dirname, 'terms.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        refund: resolve(__dirname, 'refund.html'),
      },
    },
  },
});
