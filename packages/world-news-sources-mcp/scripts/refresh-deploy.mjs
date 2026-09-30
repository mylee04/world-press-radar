import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const packageDir=fileURLToPath(new URL('../',import.meta.url));
const runId=process.argv[2]??new Date().toISOString().slice(0,10);
if(!/^\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)?$/.test(runId))throw new Error('Expected YYYY-MM-DD[-suffix] audit ID');
function run(command,args,cwd=packageDir){const result=spawnSync(command,args,{cwd,stdio:'inherit'});if(result.error||result.status!==0)throw new Error(`${command} failed: ${result.status??result.error?.code}`);}
run('npm',['run','typecheck']);run('npm',['test']);run('npm',['run','audit','--',runId]);
const snapshot=JSON.parse(readFileSync(new URL('../audits/health-latest.json',import.meta.url),'utf8'));
if(snapshot.audit?.runId!==runId||!snapshot.audit.finishedAt)throw new Error('No completed audit for requested run; deployment stopped');
// Failures remain reported and are useful health metadata. They do not make endpoints healthy.
run('npm',['run','prepare:vercel']);
const deploymentDir=fileURLToPath(new URL('../.deploy-vercel/',import.meta.url));
const linked=JSON.parse(readFileSync(`${deploymentDir}/.vercel/project.json`,'utf8'));
if(linked.projectId!=='prj_BJ4NiHnL2RbmtjojGUogPS2faQJs'||linked.orgId!=='team_L8qng538xRzhNBoq38X6p8sN')throw new Error('Refusing deployment to a different project');
run('vercel',['deploy','--prod','--yes','--scope','mylee04s-projects'],deploymentDir);
run('npm',['run','smoke:http','--','https://news.bymyleslee.com/mcp']);
console.log(`Audit ${runId} deployed and HTTPS MCP verified. Review audit failures before describing data readiness.`);
