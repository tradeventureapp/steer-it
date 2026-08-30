import { defineConfig } from 'vite';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

// Rewrites clean routes → their `.html` files in dev so the extension-less URLs
// (the QR-encoded `/play`, and the footer legal links `/terms` `/privacy`
// `/refund`) work without `.html`. For prod (Vercel), see `vercel.json`.
const CLEAN_ROUTES: Record<string, string> = {
  '/play': '/play.html',
  '/terms': '/terms.html',
  '/privacy': '/privacy.html',
  '/refund': '/refund.html',
  '/airconsole-alternative': '/airconsole-alternative.html',
  '/party-games-phone-controller': '/party-games-phone-controller.html',
  '/party-games-at-work-and-school': '/party-games-at-work-and-school.html',
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

// AUTO-LASTMOD sitemap — regenerate dist/sitemap.xml at build with HONEST lastmod dates pulled from
// git (no hand-maintenance). The homepage uses the last commit date of the whole repo (HEAD = the last
// ship — the SPA renders the whole app, so any src change changes the page); each legal page uses the
// last commit date that touched its own .html. Falls back to the build date if git isn't available
// (e.g. a tarball build). Overwrites the static public/sitemap.xml copy, which stays as the dev fallback.
const SITEMAP_URLS = [
  { loc: 'https://steerit.app/',        file: null,           changefreq: 'weekly', priority: '1.0' },
  { loc: 'https://steerit.app/leaderboard', file: 'api/leaderboard.js', changefreq: 'daily', priority: '0.6' },
  { loc: 'https://steerit.app/airconsole-alternative',      file: 'airconsole-alternative.html',      changefreq: 'monthly', priority: '0.7' },
  { loc: 'https://steerit.app/party-games-phone-controller', file: 'party-games-phone-controller.html', changefreq: 'monthly', priority: '0.7' },
  { loc: 'https://steerit.app/party-games-at-work-and-school', file: 'party-games-at-work-and-school.html', changefreq: 'monthly', priority: '0.7' },
  { loc: 'https://steerit.app/terms',   file: 'terms.html',   changefreq: 'yearly', priority: '0.3' },
  { loc: 'https://steerit.app/privacy', file: 'privacy.html', changefreq: 'yearly', priority: '0.3' },
  { loc: 'https://steerit.app/refund',  file: 'refund.html',  changefreq: 'yearly', priority: '0.3' },
];
function gitLastmod(file: string | null): string {
  const today = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD fallback
  try {
    const cmd = file ? `git log -1 --format=%cs -- "${file}"` : 'git log -1 --format=%cs';
    const d = execSync(cmd, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today;
  } catch { return today; }
}
const sitemapLastmod = {
  name: 'sitemap-lastmod',
  apply: 'build' as const,
  closeBundle() {
    const urls = SITEMAP_URLS.map((u) =>
      `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${gitLastmod(u.file)}</lastmod>\n` +
      `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
    ).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
    writeFileSync(resolve(__dirname, 'dist/sitemap.xml'), xml);
    // eslint-disable-next-line no-console
    console.log('[sitemap] dist/sitemap.xml written with git-derived lastmod');
  },
};

export default defineConfig({
  server: { host: true, port: Number(process.env.PORT) || 5173 },
  plugins: [cleanRouteRewrite, sitemapLastmod],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play.html'),
        terms: resolve(__dirname, 'terms.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        refund: resolve(__dirname, 'refund.html'),
        airconsole: resolve(__dirname, 'airconsole-alternative.html'),
        partygames: resolve(__dirname, 'party-games-phone-controller.html'),
        worksschool: resolve(__dirname, 'party-games-at-work-and-school.html'),
      },
    },
  },
});
