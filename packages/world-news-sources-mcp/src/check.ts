import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { loadData, readJson } from './config.js';
import { snapshotSchema } from './health.js';
import { checkEndpoint } from './validate.js';

// Explicit operator action, intentionally separate from the read-only MCP tools.
try {
  const ids = [...new Set(process.argv.slice(2))];
  if (!ids.length || ids.length > 5 || ids.some(id => !/^ep_[a-f0-9]{24}$/.test(id))) {
    throw new Error('Pass 1–5 explicit endpoint IDs; no bulk crawl mode exists');
  }
  const { catalog, snapshotPath } = loadData();
  if (ids.some(id => !catalog.endpoints.has(id))) throw new Error('Unknown endpoint ID');
  const previous = existsSync(snapshotPath) ? snapshotSchema.parse(readJson(snapshotPath)).observations : [];
  const observations = new Map(previous.map(o => [o.endpointId, o]));
  for (const id of ids) {
    const observation = await checkEndpoint(catalog.endpoints.get(id)!);
    observations.set(id, observation);
    console.log(JSON.stringify(observation));
  }
  const temporary = `${snapshotPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, observations: [...observations.values()] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, snapshotPath);
  console.error(`Saved ${ids.length} checks; restart the MCP server to reload the snapshot.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Health check failed');
  process.exitCode = 1;
}
