import { loadData } from '../dist/config.js';
import { getCountryQualityOverview } from '../dist/quality.js';
import { RemoteQualityStore, readRemoteNewsTool } from '../dist/quality-remote.js';
import { InvestigationStore } from '../dist/investigation.js';

const args = process.argv.slice(2);
const option = name => args.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
if (args.some(arg => !['--local', '--investigate'].includes(arg) && !arg.startsWith('--date=') && !arg.startsWith('--country='))) {
  throw new Error('Usage: node scripts/quality-report.mjs [--local] [--date=YYYY-MM-DD] [--country=US] [--investigate]');
}
const remote = !args.includes('--local'), data = loadData(), date = option('--date'), country = option('--country');
let overview;
if (remote) overview = await new RemoteQualityStore().overview(date, country);
else {
  const first = getCountryQualityOverview(data.catalog, data.activity, data.health, { date, country, limit: 50 });
  const items = [...first.items]; let offset = first.next_offset;
  while (offset !== null) {
    const next = getCountryQualityOverview(data.catalog, data.activity, data.health, { date, country, offset, limit: 50 });
    items.push(...next.items); offset = next.next_offset;
  }
  overview = { ...first, items, next_offset: null };
}
const runs = [];
if (args.includes('--investigate')) {
  const store = new InvestigationStore(data.catalog, data.health, data.activity, remote);
  for (const row of overview.items.filter(row => row.anomaly.state === 'review_needed').slice(0, 5)) {
    const run = store.start({ country: row.country, date: overview.date });
    while (run.status === 'running') await new Promise(resolve => setTimeout(resolve, 50));
    runs.push(run);
  }
}
console.log(JSON.stringify({ ...overview, investigations: runs, automation_installed: false,
  execution: 'One explicitly invoked read-only report. Only supported own-country anomaly signals trigger bounded investigations.',
  cost: { model_calls: 0, model_cost_usd: 0, server_cost_usd: null } }, null, 2));
await readRemoteNewsTool.close();
