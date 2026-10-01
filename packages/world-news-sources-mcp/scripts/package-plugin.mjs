import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = path.join(root, 'plugin');
const files = ['plugin.json', 'mcp.json', 'assets/icon.svg',
  'skills/find-news-sources/SKILL.md', 'skills/find-news-sources/agents/openai.yaml'];
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function bounded(value, max, field) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && [...value].length <= max, `Invalid ${field} (1–${max} characters)`);
}
const ajv = new Ajv2020({ strict: true, allErrors: true });
const documents = {};
for (const name of ['plugin', 'mcp']) {
  const schema = JSON.parse(await fs.readFile(path.join(root, 'publication/schemas', `${name}.schema.json`), 'utf8'));
  const doc = JSON.parse(await fs.readFile(path.join(pluginRoot, `${name}.json`), 'utf8'));
  const validate = ajv.compile(schema);
  requireValue(validate(doc), `${name}.json: ${ajv.errorsText(validate.errors)}`);
  documents[name] = doc;
}
const manifest = documents.plugin;
requireValue(/^\d+\.\d+\.\d+$/.test(manifest.version), 'Use an explicit semantic release version');
bounded(manifest.description, 4000, 'description');
const openai = manifest.extensions['com.openai'];
const listing = openai.interface;
for (const [field, max] of Object.entries({displayName:30, shortDescription:30, longDescription:4000})) bounded(listing[field], max, field);
bounded(listing.category, 120, 'category');
requireValue(listing.defaultPrompt.length <= 3 && new Set(listing.defaultPrompt).size === listing.defaultPrompt.length, 'At most three unique default prompts');
for (const prompt of listing.defaultPrompt) { bounded(prompt, 128, 'defaultPrompt'); requireValue(!prompt.includes('@'), 'Default prompts must not contain mentions'); }
requireValue(listing.capabilities.length <= 20, 'At most 20 capabilities');
for (const capability of listing.capabilities) bounded(capability, 120, 'capability');
const missing = [];
if (!listing.developerName) missing.push('Public developerName consistent with verified identity');
else bounded(listing.developerName, 80, 'developerName');
for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
  if (!listing[field]) { missing.push(field); continue; }
  bounded(listing[field], 1024, field);
  const url = new URL(listing[field]);
  requireValue(url.protocol === 'https:' && !url.username && !url.password, `Invalid HTTPS ${field}`);
}
const review = openai.review;
requireValue(review.test_cases.positive.length === 8 && review.test_cases.negative.length === 3, 'Review needs exactly eight positive and three negative scenarios');
const toolNames = new Set(['search_sources', 'get_source', 'list_countries', 'get_endpoint_health','get_country_source_inventory','get_source_article_activity','get_country_article_activity']);
for (const scenario of review.test_cases.positive) {
  for (const field of ['description','prompt','tools_triggered','expected_behavior']) bounded(scenario[field], 4000, field);
  for (const tool of scenario.tools_triggered.split(',').map(s => s.trim())) requireValue(toolNames.has(tool), `Unknown review tool ${tool}`);
}
for (const scenario of review.test_cases.negative) for (const field of ['description','prompt']) bounded(scenario[field], 4000, field);
if (!review.demo_recording_url) missing.push('Reviewer-accessible demo_recording_url');
const servers = Object.entries(documents.mcp.mcpServers);
requireValue(servers.length === 1, 'This package requires exactly one MCP server');
const [serverName, server] = servers[0];
requireValue(serverName === manifest.name && server.type === 'streamable-http' && server.url === 'https://news.bymyleslee.com/mcp', 'Unexpected MCP configuration');
requireValue(!server.headers && !server.env, 'Public package must not bundle credentials');
const discovered = [];
async function walk(directory, prefix = '') {
  for (const entry of await fs.readdir(directory, {withFileTypes:true})) {
    requireValue(!entry.isSymbolicLink(), 'Plugin must not contain symlinks');
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + '/');
    else { requireValue(entry.isFile(), `Unexpected entry ${relative}`); discovered.push(relative); }
  }
}
await walk(pluginRoot);
requireValue(JSON.stringify(discovered.sort()) === JSON.stringify([...files].sort()), 'Unexpected or missing files in plugin package');
const hashes = {};
for (const file of files) {
  const body = await fs.readFile(path.join(pluginRoot, file));
  requireValue(body.length <= 5 * 1024 * 1024, `${file} exceeds package asset limit`);
  hashes[file] = crypto.createHash('sha256').update(body).digest('hex');
}
for (const field of ['logo','composerIcon']) requireValue(listing[field] === './assets/icon.svg', `Unexpected ${field} path`);
const icon = await fs.readFile(path.join(pluginRoot, 'assets/icon.svg'), 'utf8');
requireValue(/width="96"/.test(icon) && /height="96"/.test(icon) && /viewBox="0 0 96 96"/.test(icon), 'Icon must be square with explicit dimensions');
requireValue(!/<script|<foreignObject|(?:href|src)=/i.test(icon), 'Icon must have no executable or external content');
const skill = await fs.readFile(path.join(pluginRoot, files[3]), 'utf8');
requireValue(/^---\nname: find-news-sources\ndescription: [^\n]+\n---\n/.test(skill), 'Invalid focused skill frontmatter');
const dependency = await fs.readFile(path.join(pluginRoot, files[4]), 'utf8');
requireValue(dependency.includes('value: "world-news-sources"') && dependency.includes('transport: "streamable_http"') && dependency.includes(`url: "${server.url}"`), 'Skill dependency must match MCP manifest');

const evidence = JSON.parse(await fs.readFile(path.join(root, 'publication/PLATFORM-EVIDENCE.json'), 'utf8'));
const identityVerified = evidence.identity_verification?.status === 'verified' && evidence.identity_verification?.individual_status === 'approved';
const gates = [
  [identityVerified, 'Individual identity verification'],
  [evidence.plugin_upload?.status === 'draft_uploaded', 'Organization submission permission and ZIP upload'],
  [evidence.approved_actions?.website_pages_publication && evidence.website_publication?.verified_https, 'Approved live public site/policy pages'],
  [evidence.plugin_upload?.domain_verified && evidence.plugin_upload?.mcp_configured, 'Domain ownership and configured MCP'],
  [false, 'Updated seven-tool ChatGPT review tests'],
  [!!review.demo_recording_url && evidence.demo?.publication_approved === true, 'Reviewed accessible demo video'],
  [evidence.approved_actions?.final_submit === true, 'Explicit final submission approval'],
];
const report = { local_structure:'passed', portable_schemas:'Agent Plugins 1.0.0', files, sha256:hashes,
  review_scenarios:{positive:8,negative:3,natural_language_executed_in_chatgpt:false},
  submission_ready:false, missing_package_fields:missing,
  confirmed_external_gates:gates.filter(([confirmed])=>confirmed).map(([,label])=>label),
  external_gates:gates.filter(([confirmed])=>!confirmed).map(([,label])=>label),
  platform_findings: evidence.plugin_upload?.metadata_warning ? [evidence.plugin_upload.metadata_warning] : [] };
report.submission_ready = missing.length === 0 && report.external_gates.length === 0;
if (process.argv.includes('--package')) {
  const output = path.join(root, 'publication/dist', `${manifest.name}-${manifest.version}-draft.zip`);
  await fs.mkdir(path.dirname(output), {recursive:true});
  const python = `import json,sys,zipfile,pathlib\nroot=pathlib.Path(sys.argv[1])\nout=pathlib.Path(sys.argv[2])\nfiles=json.loads(sys.argv[3])\nwith zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as archive:\n for name in sorted(files):\n  entry=zipfile.ZipInfo(name,(2026,1,1,0,0,0))\n  entry.compress_type=zipfile.ZIP_DEFLATED\n  entry.external_attr=0o100644<<16\n  archive.writestr(entry,(root/name).read_bytes())\nwith zipfile.ZipFile(out) as archive:\n assert archive.testzip() is None\n assert sorted(archive.namelist())==sorted(files)\n for name in files: assert archive.read(name)==(root/name).read_bytes()\n`;
  const zip = spawnSync('python3', ['-c', python, pluginRoot, output, JSON.stringify(files)], {encoding:'utf8'});
  requireValue(zip.status === 0, `ZIP creation/integrity check failed: ${zip.stderr}`);
  report.archive = {path:path.relative(root,output), sha256:crypto.createHash('sha256').update(await fs.readFile(output)).digest('hex'),integrity:'passed'};
  await fs.writeFile(path.join(root, 'publication/VALIDATION.json'), JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report,null,2));
if (process.argv.includes('--submission-ready') && (missing.length || report.external_gates.length)) process.exitCode = 2;
