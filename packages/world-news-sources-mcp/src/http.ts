import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server';
import type { Catalog } from './catalog.js';
import type { HealthStore } from './health.js';
import { createServer } from './server.js';
import { callMetadata, callOutcome, readRpcResponse, type AggregateSink } from './metrics.js';

export function createHttpHandler(catalog: Catalog, health: HealthStore, allowedHosts: string[], metrics?: AggregateSink) {
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
        usage_statistics: { configured: !!metrics, counts: 'identifiable tools/call attempts', unique_users_measured: false,
          note: 'Aggregate collection may have outage gaps; inspection hints are client supplied.' },
      });
      if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
      // This service has no server-initiated streams or sessions.
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
      const started = performance.now();
      let metadata: ReturnType<typeof callMetadata> = null;
      if (metrics) {
        const reader=guardedRequest.clone().body?.getReader();
        if(reader){const parts:Uint8Array[]=[];let size=0;
          try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>64*1024)break;parts.push(chunk.value);}
            if(size<=64*1024){const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
              metadata=callMetadata(JSON.parse(new TextDecoder().decode(bytes)),request.headers.get('x-world-news-traffic'));}}
          catch{/* Malformed protocol bodies are not identifiable tool calls. */}
          finally{void reader.cancel();}
        }
      }
      let response: Response;
      try {response = await mcp.fetch(guardedRequest);}
      catch(error){if(metrics&&metadata){try{await metrics({...metadata,outcome:'error',duration_ms:Math.min(120000,Math.round(performance.now()-started))});}catch{/* Preserve the MCP error. */}}throw error;}
      const duration_ms=Math.min(120000,Math.round(performance.now()-started));
      if(metrics&&metadata){
        let payload:unknown;try{payload=await readRpcResponse(response);}catch{/* HTTP/protocol error. */}
        try{await metrics({...metadata,outcome:callOutcome(response.status,payload),duration_ms});response.headers.set('x-world-news-metrics','recorded');}
        catch{response.headers.set('x-world-news-metrics','unavailable');console.warn('World News Sources aggregate collector unavailable; usage totals may have gaps.');}
      }
      response.headers.set('cache-control', 'no-store');
      response.headers.set('x-content-type-options', 'nosniff');
      return response;
    },
  };
}
