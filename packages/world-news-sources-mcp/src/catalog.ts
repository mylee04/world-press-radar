import { createHash } from 'node:crypto';
import { z } from 'zod';
import { statusFields, statusMetadata, unknownStatus, type StatusMetadata } from './status.js';

export const endpointType = z.enum(['rss', 'sitemap']);
export type EndpointType = z.infer<typeof endpointType>;
const text = z.string().trim().min(1).max(512);
const url = z.string().trim().max(2048).nullable().optional();
const registrySchema = z.object({
  countries: z.array(z.object({
    code: z.string().trim().min(2).max(8), name: text,
    feeds: z.array(z.object({
      name: text, url, sitemapUrl: url, row: z.number().int().optional(),
      enabled: z.boolean().optional(), category: z.string().max(256).optional(),
      language: z.string().max(128).optional(), tier: z.union([z.string(), z.number()]).optional(),
      ...statusFields,
    })),
  })),
});

export function stableId(prefix: string, parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)}`;
}
export function canonicalUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    // Reject credentials, arbitrary protocols, fragments and oversized URLs at the boundary.
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    parsed.hash = '';
    if (parsed.href.length > 2048) throw new Error();
    return parsed.href;
  } catch { throw new Error('Registry endpoint must be an HTTP(S) URL without credentials'); }
}
export type Endpoint = { id: string; type: EndpointType; url: string };
export type Source = StatusMetadata & {
  id: string; name: string; countryCode: string; countryName: string; enabled: boolean;
  category: string | null; language: string | null; tier: string | null;
  registrationCount: number; rows: number[]; endpoints: Endpoint[];
};
export type Catalog = {
  sources: Source[]; endpoints: Map<string, Endpoint>;
  countries: { code: string; name: string; configuredRows: number; sources: number }[];
  configuredRows: number;
};

export function normalizeRegistry(input: unknown): Catalog {
  const registry = registrySchema.parse(input);
  const sources = new Map<string, Source>();
  const endpoints = new Map<string, Endpoint>();
  const countries = new Map<string, Catalog['countries'][number]>();
  let configuredRows = 0;
  for (const country of registry.countries) {
    const code = country.code.toUpperCase();
    const info = countries.get(code) ?? { code, name: country.name, configuredRows: 0, sources: 0 };
    countries.set(code, info);
    for (const feed of country.feeds) {
      configuredRows++; info.configuredRows++;
      const list: Endpoint[] = [];
      for (const [type, raw] of [['rss', feed.url], ['sitemap', feed.sitemapUrl]] as const) {
        if (!raw) continue;
        const normalizedUrl = canonicalUrl(raw);
        const endpoint = { id: stableId('ep', [type, normalizedUrl]), type, url: normalizedUrl };
        endpoints.set(endpoint.id, endpoint);
        list.push(endpoint);
      }
      const id = stableId('src', [code, feed.name.normalize('NFKC').toLowerCase(), ...list.map(e => e.id).sort()]);
      const previous = sources.get(id);
      const status = statusMetadata(feed);
      if (previous) {
        const previousStatus = Object.fromEntries(Object.keys(status).map(key => [key, previous[key as keyof Source]]));
        if (previous.enabled !== (feed.enabled !== false) || JSON.stringify(previousStatus) !== JSON.stringify(status)) Object.assign(previous, unknownStatus());
        previous.registrationCount++;
        previous.enabled ||= feed.enabled !== false;
        if (feed.row !== undefined && previous.rows.length < 50 && !previous.rows.includes(feed.row)) previous.rows.push(feed.row);
      } else {
        info.sources++;
        sources.set(id, {
          id, name: feed.name, countryCode: code, countryName: country.name, enabled: feed.enabled !== false,
          category: feed.category ?? null, language: feed.language ?? null, tier: feed.tier == null ? null : String(feed.tier).slice(0, 128),
          registrationCount: 1, rows: feed.row === undefined ? [] : [feed.row], endpoints: list,
          ...status,
        });
      }
    }
  }
  return {
    configuredRows, sources: [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)), endpoints,
    countries: [...countries.values()].sort((a, b) => a.code.localeCompare(b.code)),
  };
}

export const pagination = { offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(50).default(20) };
export const searchSchema = z.object({
  query: z.string().trim().max(200).optional(), country: z.string().trim().min(2).max(8).optional(),
  endpoint_type: endpointType.optional(), enabled: z.boolean().optional(),
  category: z.string().trim().max(256).optional(), language: z.string().trim().max(128).optional(), ...pagination,
}).strict();
export const countrySchema = z.object(pagination).strict();
export const detailsSchema = z.object({ source_id: z.string().regex(/^src_[a-f0-9]{24}$/) }).strict();
export const healthSchema = z.object({ endpoint_ids: z.array(z.string().regex(/^ep_[a-f0-9]{24}$/)).min(1).max(20) }).strict();

// JSON content is duplicated as text + structuredContent by MCP. Keep each below 60 KB.
export function page<T>(items: T[], offset: number, limit: number) {
  const result: T[] = [];
  let bytes = 0;
  for (const item of items.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > 60000) break;
    result.push(item); bytes += size;
  }
  const next = offset + result.length;
  return { items: result, total: items.length, offset, next_offset: next < items.length ? next : null };
}
export function search(catalog: Catalog, raw: unknown) {
  const input = searchSchema.parse(raw);
  const q = input.query?.toLocaleLowerCase();
  const matching = catalog.sources.filter(s =>
    (!input.country || s.countryCode === input.country.toUpperCase()) &&
    (input.enabled === undefined || s.enabled === input.enabled) &&
    (!input.endpoint_type || s.endpoints.some(e => e.type === input.endpoint_type)) &&
    (!input.category || s.category?.toLowerCase() === input.category.toLowerCase()) &&
    (!input.language || s.language?.toLowerCase() === input.language.toLowerCase()) &&
    (!q || `${s.name} ${s.countryName} ${s.endpoints.map(e => e.url).join(' ')}`.toLocaleLowerCase().includes(q)),
  );
  return page(matching, input.offset, input.limit);
}
