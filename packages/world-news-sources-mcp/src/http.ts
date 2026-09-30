import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server';
import type { Catalog } from './catalog.js';
import type { HealthStore } from './health.js';
import { createServer } from './server.js';

export function createHttpHandler(catalog: Catalog, health: HealthStore, allowedHosts: string[]) {
  const mcp = createMcpHandler(() => createServer(catalog, health), {
    legacy: 'stateless', responseMode: 'json', maxRequestBodySize: 64 * 1024,
    maxSubscriptions: 0, keepAliveMs: 0,
  });
  return {
    close: mcp.close,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const host = request.headers.get('host') ?? url.host;
      // Web-handler runtimes can omit Host. Always validate the canonical URL too,
      // and never trust x-forwarded-host supplied by a client.
      if (!allowedHosts.includes(url.hostname.toLowerCase())) return new Response('Invalid host', { status: 403 });
      const guardedRequest = new Request(request, { headers: new Headers(request.headers) });
      guardedRequest.headers.set('host', host);
      const rejected = hostHeaderValidationResponse(guardedRequest, allowedHosts)
        ?? originValidationResponse(guardedRequest, [...allowedHosts, 'chatgpt.com']);
      if (rejected) return rejected;
      if (url.pathname === '/health' && request.method === 'GET') return Response.json({
        name: 'world-news-sources-mcp', status: 'ok', configured_rows: catalog.configuredRows,
        countries: catalog.countries.length, ...health.summary(),
      });
      if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
      // This service has no server-initiated streams or sessions.
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
      const response = await mcp.fetch(guardedRequest);
      response.headers.set('cache-control', 'no-store');
      response.headers.set('x-content-type-options', 'nosniff');
      return response;
    },
  };
}
