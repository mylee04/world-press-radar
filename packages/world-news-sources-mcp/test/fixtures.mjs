export const registry = {
  countries: [
    { code: 'US', name: 'United States', feeds: [
      { name: 'Example News', row: 1, url: 'https://example.com/feed', sitemapUrl: 'https://example.com/sitemap.xml' },
      { name: 'Example News', row: 2, url: 'https://example.com/feed', sitemapUrl: 'https://example.com/sitemap.xml' },
      { name: 'RSS Only', row: 3, url: 'https://example.com/other', enabled: false },
      { name: 'No Endpoint', row: 4, url: null },
    ] },
    { code: 'GB', name: 'United Kingdom', feeds: [{ name: 'Sitemap Only', url: null, sitemapUrl: 'https://example.org/sitemap.xml' }] },
  ],
};
export const rss = '<rss version="2.0"><channel><title>News</title><link>https://example.com</link><description>News feed</description><item><title>One</title></item></channel></rss>';
export const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><title>News</title><id>urn:news</id><updated>2026-09-30T00:00:00Z</updated></feed>';
export const sitemap = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/news</loc></url></urlset>';
export const sitemapIndex = '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/sitemap.xml</loc></sitemap></sitemapindex>';
