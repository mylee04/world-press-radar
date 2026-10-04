// Network fixtures: no DNS resolution or external HTTP requests occur in these tests.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { rss } from './fixtures.mjs';
let answers; let responses; let requests; let pinned; let lookups;
mock.module('node:dns/promises',{namedExports:{lookup:async()=>{lookups++;return answers;}}});
function fakeRequest(url,options,callback){
  requests.push(url.href);
  options.lookup(url.hostname,{all:false},(_error,ip)=>{pinned=ip;});
  const req=new EventEmitter();
  req.destroy=error=>{if(error)req.emit('error',error);req.emit('close');};
  req.end=()=>queueMicrotask(()=>{
    const fixture=responses.shift();
    if(fixture?.hang)return;
    const response=new PassThrough();
    response.statusCode=fixture.status;response.headers=fixture.headers??{};
    response.on('close',()=>req.emit('close'));
    callback(response);
    if(!response.destroyed)response.end(fixture.body??Buffer.alloc(0));
  });
  return req;
}
mock.module('node:http',{namedExports:{request:fakeRequest}});
mock.module('node:https',{namedExports:{request:fakeRequest}});
const {fetchXml,validateXml}=await import('../dist/validate.js');
const {auditEndpoint,isTransient}=await import('../dist/audit-check.js');
function reset(){answers=[{address:'8.8.8.8',family:4}];responses=[];requests=[];pinned=null;lookups=0;}
test('fetch pins approved DNS to socket and decodes bounded gzip XML',async()=>{
  reset();responses.push({status:200,headers:{'content-encoding':'gzip'},body:gzipSync(Buffer.from(rss))});
  const result=await fetchXml('https://example.com/feed');
  assert.equal(result.status,200);assert.equal(validateXml(result.body,'rss'),'rss');
  assert.equal(pinned,'8.8.8.8');assert.equal(lookups,1);
});
test('private DNS answer and redirected private target never receive a request',async()=>{
  reset();answers.push({address:'127.0.0.1',family:4});
  await assert.rejects(fetchXml('https://example.com/feed'),/PRIVATE_ADDRESS/);assert.equal(requests.length,0);
  reset();responses.push({status:302,headers:{location:'http://169.254.169.254/latest/meta-data'}});
  await assert.rejects(fetchXml('https://example.com/feed'),/PRIVATE_ADDRESS/);assert.equal(requests.length,1);
});
test('redirect cap, 403 without retries and total request timeout',async()=>{
  reset();responses=Array(4).fill({status:302,headers:{location:'/next'}});
  await assert.rejects(fetchXml('https://example.com/feed'),/TOO_MANY_REDIRECTS/);assert.equal(requests.length,4);
  reset();responses.push({status:403});assert.equal((await fetchXml('https://example.com/feed')).status,403);assert.equal(requests.length,1);
  reset();responses.push({hang:true});await assert.rejects(fetchXml('https://example.com/feed',10),/TIMEOUT/);
});
test('both wire and gzip output sizes are bounded',async()=>{
  reset();responses.push({status:200,body:Buffer.alloc(2*1024*1024+1)});
  await assert.rejects(fetchXml('https://example.com/feed'),/BODY_TOO_LARGE/);
  reset();responses.push({status:200,body:gzipSync(Buffer.alloc(2*1024*1024+1))});
  await assert.rejects(fetchXml('https://example.com/feed'));
});
test('live audit separates parsed outputs, empty documents, block and transient failure',async()=>{
  const endpoint={id:'ep_'+'a'.repeat(24),type:'rss',url:'https://example.com/feed'};
  reset();responses.push({status:200,body:Buffer.from(rss)});
  let result=await auditEndpoint(endpoint);assert.equal(result.auditStatus,'working_nonempty');assert.equal(result.entryCount,1);assert.equal(result.contentFreshness,'missing');
  reset();responses.push({status:200,body:Buffer.from(rss.replace('<item><title>One</title></item>',''))});
  assert.equal((await auditEndpoint(endpoint)).auditStatus,'valid_empty');
  reset();responses.push({status:403});result=await auditEndpoint(endpoint);assert.equal(result.auditStatus,'blocked');assert.equal(isTransient(result),false);
  reset();responses.push({status:503});result=await auditEndpoint(endpoint);assert.equal(result.auditStatus,'http_error');assert.equal(isTransient(result),true);
  reset();responses.push({status:200,body:Buffer.from('<html>challenge</html>')});assert.equal((await auditEndpoint(endpoint)).auditStatus,'malformed');
});
test('request governor also covers actual redirect hosts',async()=>{
  reset();responses.push({status:302,headers:{location:'https://other.example/feed'}},{status:200,body:Buffer.from(rss)});
  const hosts=[];let releases=0;
  await fetchXml('https://example.com/feed',8000,2097152,async host=>{hosts.push(host);return()=>{releases++;};});
  assert.deepEqual(hosts,['example.com','other.example']);assert.equal(releases,2);
});
test('safe header evidence and actual HTML body are distinguished from wrong-format XML and invalid UTF-8',async()=>{
 const endpoint={id:'ep_'+'a'.repeat(24),type:'rss',url:'https://example.com/feed'};
 reset();responses.push({status:429,headers:{'retry-after':'120','content-type':'text/html; token=never-store'}});let o=await auditEndpoint(endpoint);assert.equal(o.httpStatus,429);assert.equal(o.diagnostics.contentType,'text/html');assert.ok(o.diagnostics.retryAfterAt);assert.ok(!JSON.stringify(o).includes('never-store'));
 reset();responses.push({status:200,headers:{'content-type':'text/html'},body:Buffer.from('<html><body>not a feed</body></html>')});o=await auditEndpoint(endpoint);assert.equal(o.reason,'WRONG_ENDPOINT_FORMAT');assert.equal(o.diagnostics.bodyKind,'html');
 reset();responses.push({status:200,body:Buffer.from('<not-a-feed/>')});o=await auditEndpoint(endpoint);assert.equal(o.reason,'WRONG_ENDPOINT_FORMAT');assert.equal(o.diagnostics.bodyKind,'other_or_unknown');
 reset();responses.push({status:200,body:Buffer.from([255])});o=await auditEndpoint(endpoint);assert.equal(o.reason,'INVALID_UTF8');assert.equal(o.auditStatus,'malformed');
});
test('bounded response failures retain known HTTP/header evidence without storing bodies',async()=>{
 const endpoint={id:'ep_'+'a'.repeat(24),type:'rss',url:'https://example.com/feed'};
 reset();responses.push({status:200,headers:{'content-type':'application/rss+xml'},body:Buffer.alloc(4*1024*1024+1)});let o=await auditEndpoint(endpoint);assert.equal(o.reason,'BODY_TOO_LARGE');assert.equal(o.httpStatus,200);assert.equal(o.diagnostics.contentType,'application/rss+xml');
 reset();responses.push({status:200,headers:{'content-encoding':'gzip'},body:Buffer.from('not gzip')});o=await auditEndpoint(endpoint);assert.equal(o.reason,'INVALID_COMPRESSION');assert.equal(o.auditStatus,'incomplete');assert.equal(o.httpStatus,200);
});
