import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
const client=new Client({name:'local-smoke',version:'0.1.0'});
try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/stdio.js',import.meta.url))],env:{}}));
  const {tools}=await client.listTools();assert.equal(tools.length,4);
  const result=await client.callTool({name:'search_sources',arguments:{country:'US',endpoint_type:'sitemap',limit:2}});
  assert.equal(result.structuredContent.items.length,2);
  console.log(JSON.stringify({transport:'stdio',tools:tools.map(t=>t.name),sample:result.structuredContent},null,2));
} finally {await client.close();}
