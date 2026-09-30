import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadData } from './config.js';
import { createServer } from './server.js';

try {
  const { catalog, health } = loadData();
  await createServer(catalog, health).connect(new StdioServerTransport());
} catch {
  console.error('World News Sources could not start. Check registry/health paths and metadata format.');
  process.exitCode = 1;
}
