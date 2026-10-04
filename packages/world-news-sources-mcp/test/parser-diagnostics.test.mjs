import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
mock.module('../dist/validate.js',{namedExports:{fetchXml:async()=>({status:200,body:Buffer.from('<rss/>'),finalUrl:'https://example.com/feed',contentType:'application/rss+xml',retryAfterAt:null})}});
mock.module('../dist/inspect.js',{namedExports:{inspectXml:()=>{throw new TypeError('unexpected parser error: NEVER_EXPOSE_THIS');}}});
const {auditEndpoint}=await import('../dist/audit-check.js');
test('unexpected parser-stage exceptions remain an investigation, with no raw error/body leakage',async()=>{const o=await auditEndpoint({id:'ep_'+'a'.repeat(24),type:'rss',url:'https://example.com/feed'});assert.equal(o.reason,'PARSER_STAGE_ERROR');assert.equal(o.diagnostics.phase,'inspect');assert.ok(!JSON.stringify(o).includes('NEVER_EXPOSE_THIS'));});
