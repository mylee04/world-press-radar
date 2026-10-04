import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deploymentPlan,createBody} from '../scripts/deploy-project-api.mjs';
test('large preserved health and activity use exact SHA references below API body limit',()=>{
  const files=[['metadata/health.json',4827526],['metadata/activity.json',2338385],['metadata/registry.json',508921],['api/health.mjs',100]].map(([file,n])=>({file,data:Buffer.alloc(n,97).toString('base64'),encoding:'base64'}));
  const p=deploymentPlan(files),body=JSON.parse(p.body);
  assert.ok(Buffer.byteLength(p.body)<256*1024);
  assert.equal(p.uploads.length,3);
  for(const upload of p.uploads){const ref=body.files.find(f=>f.file===upload.file);assert.equal(ref.sha,createHash('sha1').update(upload.bytes).digest('hex'));assert.equal(ref.size,upload.bytes.length);assert.equal(ref.data,undefined);}
  assert.equal(body.files.find(f=>f.file==='api/health.mjs').encoding,'base64');
});
test('oversized inline request is rejected before network mutation',()=>{
  assert.throws(()=>createBody([{file:'large',data:'a'.repeat(10*1024*1024),encoding:'base64'}]),/safety limit/);
});
