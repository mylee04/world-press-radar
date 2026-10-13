import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createHttpHandler } from './http.js';
import { loadData } from './config.js';
import { createLocalQualityRuntime } from './quality-local-runtime.js';

const { catalog, health, activity, rawRegistry } = loadData();
const qualityRuntime = createLocalQualityRuntime();
const handler = createHttpHandler(catalog, health, ['127.0.0.1', 'localhost', '[::1]'], undefined, activity, rawRegistry, true, process.env.WNS_QUALITY_REMOTE === '1', qualityRuntime.options);
const server = createServer(toNodeHandler(handler));
server.requestTimeout = 10000;
server.headersTimeout = 10000;
const port = Number(process.env.WNS_PORT ?? '3000');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid WNS_PORT');
server.listen(port, '127.0.0.1', () => console.error(`World News Sources MCP: http://127.0.0.1:${(server.address() as { port: number }).port}/mcp\nQuality dashboard: http://127.0.0.1:${(server.address() as { port: number }).port}/quality`));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return; closing = true;
  server.close(); await qualityRuntime.close(); await handler.close();
});
