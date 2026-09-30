import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadData, readJson } from './config.js';
import { snapshotSchema } from './health.js';
import { checkEndpoint } from './validate.js';

// Explicit operator action, intentionally separate from the read-only MCP tools.
try {
  const ids = [...new Set(process.argv.slice(2))];
  if (!ids.length || ids.length > 5 || ids.some(id => !/^ep_[a-f0-9]{24}$/.test(id))) {
    throw new Error('Pass 1–5 explicit endpoint IDs; no bulk crawl mode exists');
  }
  const { catalog } = loadData();
  const snapshotPath = process.env.WNS_HEALTH_PATH ?? fileURLToPath(new URL('../health-snapshot.local.json', import.meta.url));
  if (ids.some(id => !catalog.endpoints.has(id))) throw new Error('Unknown endpoint ID');
  const fullPath = fileURLToPath(new URL('../audits/health-latest.json', import.meta.url));
  const prior = existsSync(snapshotPath) ? snapshotSchema.parse(readJson(snapshotPath)) :
    existsSync(fullPath) ? snapshotSchema.parse(readJson(fullPath)) : { version: 1 as const, observations: [] };
  const previous = prior.observations;
  const observations = new Map(previous.map(o => [o.endpointId, o]));
  for (const id of ids) {
    const observation = await checkEndpoint(catalog.endpoints.get(id)!);
    observations.set(id, observation);
    console.log(JSON.stringify(observation));
  }
  const temporary = `${snapshotPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...prior, observations: [...observations.values()] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, snapshotPath);
  console.error(`Saved ${ids.length} checks; restart the MCP server to reload the snapshot.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Health check failed');
  process.exitCode = 1;
}
