import { getDomain } from 'tldts';

export type PublisherSource = {
  name: string;
  countryCode?: string;
  country?: string;
  enabled?: boolean;
  endpoints?: readonly { url?: string | null; type?: string }[];
};
export type PublisherInventory = {
  unique_publishers: number | null;
  publisher_count_state: 'estimated_from_registry_identity' | 'registry_identity_unavailable';
  publisher_count_semantics: string;
  publisher_identity_basis: {
    domain_groups: number;
    name_fallback_groups: number;
    unresolved_active_registrations: number;
  };
};

// These are distribution services, not the publisher of every feed they host.
const sharedDomains = new Set([
  'feedburner.com', 'google.com', 'googleusercontent.com', 'rsshub.app',
  'rsshub.net', 'rsshub.io', 'yahoo.com', 'yahoo.co.jp', 'medium.com',
  'wordpress.com', 'substack.com', 'ghost.io', 'beehiiv.com',
]);
const normalizedName = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
function fallbackName(name: string) {
  // Section suffixes are only a fallback for shared/missing endpoint identity.
  return normalizedName(name.replace(/\s+-\s+.*$/, '').replace(/\s*\([^)]*\)\s*$/, ''));
}
function endpointUrl(raw: string | null | undefined) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch { return null; }
}
function knownBrand(name: string, domain: string) {
  const label = normalizedName(name);
  // Aliases identify a newsroom/brand, never a corporate ownership group.
  if (['bbc.com', 'bbc.co.uk', 'bbci.co.uk'].includes(domain) && /^bbc(?:\s|$)/.test(label)) return 'bbc';
  if (domain === 'nhk.or.jp' && /^nhk(?:\s|$)/.test(label)) return 'nhk';
  if (domain === 'donga.com' && /^(?:donga ilbo|dong-a ilbo|동아일보)(?:\s|$)/.test(label)) return 'dong-a-ilbo';
  if (domain === 'nytimes.com' && /^(?:the new york times|new york times|nyt)(?:\s|$)/.test(label)) return 'new-york-times';
  return null;
}
function domainIdentity(url: URL, name: string, domain: string) {
  const label = normalizedName(name);
  if (domain === 'nytimes.com' && (/^the athletic(?:\s|$)/.test(label) || url.pathname.startsWith('/athletic/'))) return 'brand:the-athletic';
  if (domain === 'donga.com' && /^(?:channel a|채널a)(?:\s|$)/.test(label)) return 'brand:channel-a';
  const alias = knownBrand(name, domain);
  if (alias) return `brand:${alias}`;
  // A few editorial brands share their owner's feed/server domain. Preserve
  // these brands instead of treating the parent company as one newspaper.
  if (domain === 'dj.com') {
    if (/\b(?:barron'?s)\b/.test(label)) return 'brand:barrons';
    if (/\bmarketwatch\b/.test(label)) return 'brand:marketwatch';
    if (/^(?:wall street journal|the wall street journal|wsj)(?:\s|$)/.test(label)) return 'brand:wall-street-journal';
  }
  return `domain:${domain}`;
}
function hostedIdentity(url: URL, domain: string) {
  if (['wordpress.com', 'substack.com', 'ghost.io', 'beehiiv.com', 'medium.com'].includes(domain)
    && url.hostname !== domain && !['www', 'feeds', 'rss'].includes(url.hostname.slice(0, -(domain.length + 1)))) {
    return `hosted:${url.hostname.toLowerCase()}`;
  }
  // Yahoo's media ID is a publisher-specific namespace; its category feeds
  // belong to Yahoo itself, not to the newsrooms in /rss/media/.
  if (domain === 'yahoo.co.jp') {
    const media = url.pathname.match(/^\/rss\/media\/([^/]+)\//);
    if (media) return `hosted:${domain}:media:${media[1].toLowerCase()}`;
  }
  return null;
}

/** Estimate brands from a complete registry listing, without network/model calls.
 * Host/domain identity is an estimate: unrelated brands sharing an unlisted
 * service, and one brand spanning unlinked domains, require a reviewed ID map.
 */
export function estimatePublisherInventory(sources: readonly PublisherSource[] | null | undefined): PublisherInventory {
  const unavailable = (unresolved = 0): PublisherInventory => ({ unique_publishers: null,
    publisher_count_state: 'registry_identity_unavailable', publisher_count_semantics: '전체 등록 목록 또는 언론사 식별 근거가 없어 집계할 수 없음.',
    publisher_identity_basis: { domain_groups: 0, name_fallback_groups: 0, unresolved_active_registrations: unresolved } });
  if (!Array.isArray(sources)) return unavailable();
  const parent = new Map<string, string>(), domainEvidence = new Set<string>();
  let unresolved = 0;
  const root = (key: string): string => {
    const previous = parent.get(key);
    if (!previous) { parent.set(key, key); return key; }
    if (previous === key) return key;
    const result = root(previous); parent.set(key, result); return result;
  };
  const union = (keys: string[]) => {
    if (!keys.length) return;
    // Lexical representatives make the result independent of registration order.
    const representative = keys.map(root).sort()[0];
    for (const key of keys) parent.set(root(key), representative);
  };
  for (const source of sources) {
    if (source.enabled === false) continue;
    const country = (source.countryCode ?? source.country ?? '').trim().toUpperCase();
    const scoped = (identity: string) => `${country}:${identity}`;
    const name = typeof source.name === 'string' ? source.name : '';
    const identities: string[] = [], hosted: string[] = [];
    let shared = false;
    for (const endpoint of source.endpoints ?? []) {
      const url = endpointUrl(endpoint.url);
      if (!url) continue;
      const domain = getDomain(url.hostname, { allowPrivateDomains: true });
      if (!domain) continue;
      if (sharedDomains.has(domain)) {
        shared = true;
        const identity = hostedIdentity(url, domain);
        if (identity) hosted.push(scoped(identity));
      } else {
        const identity = scoped(domainIdentity(url, name, domain));
        identities.push(identity); domainEvidence.add(identity);
      }
    }
    identities.push(...hosted);
    // Do not unify direct sites merely because unrelated newsrooms use the
    // same short name. Name fallback is confined to hosted/missing identities.
    const fallback = fallbackName(name);
    if (shared && !hosted.length && fallback) identities.push(scoped(`name:${fallback}`));
    if (!identities.length && fallback) identities.push(scoped(`name:${fallback}`));
    if (!identities.length) { unresolved++; continue; }
    union(identities);
  }
  if (unresolved) return unavailable(unresolved);
  const groups = new Set([...parent.keys()].map(root));
  const domainGroups = new Set([...domainEvidence].map(root));
  const fallbackGroups = [...groups].filter(group => !domainGroups.has(group)).length;
  return { unique_publishers: groups.size, publisher_count_state: 'estimated_from_registry_identity',
    publisher_count_semantics: `활성 등록의 매체 브랜드 기준 추정. 등록된 사이트 도메인·별칭으로 중복을 제거함.${fallbackGroups ? ` ${fallbackGroups}개는 사이트 도메인 없이 등록명·공유 피드 경로로 추정.` : ''} 모회사별로 합치지 않으며, 공유 서버·연결되지 않은 다른 도메인에는 오차가 있을 수 있음.`,
    publisher_identity_basis: { domain_groups: domainGroups.size, name_fallback_groups: fallbackGroups, unresolved_active_registrations: 0 } };
}

/** Countries are independent scopes: a cross-country service can occur in each. */
export function estimatePublisherInventoryByCountry(sources: readonly PublisherSource[] | null | undefined): Record<string, PublisherInventory> | null {
  if (!Array.isArray(sources)) return null;
  const grouped = new Map<string, PublisherSource[]>();
  for (const source of sources) {
    const country = (source.countryCode ?? source.country ?? '').trim().toUpperCase();
    const values = grouped.get(country) ?? [];
    values.push(source); grouped.set(country, values);
  }
  return Object.fromEntries([...grouped].sort(([a], [b]) => a.localeCompare(b))
    .map(([country, values]) => [country, estimatePublisherInventory(values)]));
}

/** Global brand estimate: remove country namespaces before deduplicating. */
export function estimateGlobalPublisherInventory(sources: readonly PublisherSource[] | null | undefined): PublisherInventory {
  return estimatePublisherInventory(Array.isArray(sources) ? sources.map(source => ({ ...source, country: undefined, countryCode: undefined })) : sources);
}
