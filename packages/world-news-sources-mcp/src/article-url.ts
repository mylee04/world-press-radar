import { canonicalUrl } from './catalog.js';

export const NORMALIZATION_VERSION = 'article-url-v1';
// Remove only documented tracking keys. Keep path case, slashes and identity queries.
const tracking = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid']);
export function normalizeArticleUrl(value: string) {
  const url = new URL(canonicalUrl(value));
  const parts = url.search.slice(1).split('&').filter(part => {
    if (!part) return false;
    let key: string; try { key = decodeURIComponent(part.split('=')[0].replace(/\+/g, ' ')); } catch { return true; }
    return !/^utm_/i.test(key) && !tracking.has(key.toLowerCase());
  });
  url.search = parts.length ? `?${parts.join('&')}` : '';
  const path = url.pathname.replace(/\/+$/, '');
  const uncertain = path === '' || /^\/(?:news|world|politics|business|sport|sports)$/i.test(path)
    || /^\/(?:category|section|tag|tags|forum|forums)(?:\/|$)/i.test(path)
    || /^\/news\/(?:world|politics|business|sport|sports)$/i.test(path);
  return { url: url.href, kind: uncertain ? 'uncertain' as const : 'candidate' as const, normalization_version: NORMALIZATION_VERSION };
}
