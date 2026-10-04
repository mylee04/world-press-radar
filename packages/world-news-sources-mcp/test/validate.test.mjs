import test from 'node:test';
import assert from 'node:assert/strict';
import { validateXml, safeUrl, isPublicIp, checkEndpoint } from '../dist/validate.js';
import { stableId } from '../dist/catalog.js';
import { rss, atom, sitemap, sitemapIndex } from './fixtures.mjs';

test('parse well-formed RSS, Atom, RDF, sitemap and sitemap index',()=>{
  for(const [body,type,format] of [[rss,'rss','rss'],[atom,'rss','atom'],[sitemap,'sitemap','urlset'],[sitemapIndex,'sitemap','sitemapindex'],['<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>News</title><link>https://example.com</link><description>News</description></channel></rdf:RDF>','rss','rdf']]) assert.equal(validateXml(Buffer.from(body),type),format);
});
test('XML markers and HTTP-like content cannot establish endpoint validity',()=>{
  for(const body of ['<?xml version="1.0"?><html>login</html>','<rss><channel></rss>','<rss/>','<!DOCTYPE rss [<!ENTITY x "evil">]><rss>&x;</rss>']) assert.throws(()=>validateXml(Buffer.from(body),'rss'));
  assert.throws(()=>validateXml(Buffer.from(sitemap),'rss'));
  assert.throws(()=>validateXml(Buffer.from(rss),'sitemap'));
  assert.throws(()=>validateXml(Buffer.from(sitemap.replace('https://example.com/news','file:///tmp/a')),'sitemap'));
  assert.throws(()=>validateXml(Buffer.from(sitemap.replace('http://www.sitemaps.org/schemas/sitemap/0.9','urn:wrong')),'sitemap'));
  assert.throws(()=>validateXml(Buffer.alloc(2*1024*1024+1),'rss'));
  assert.throws(()=>validateXml(Buffer.from(atom.replace('<title>News</title>','<title xmlns="urn:wrong">News</title>')),'rss'));
  assert.throws(()=>validateXml(Buffer.from(rss.replace('<title>News</title>','<title/>')),'rss'));
});
test('safe fetch boundary rejects local, reserved, credential and port targets',()=>{
  for(const url of ['http://127.0.0.1/a','http://localhost/a','http://192.168.1.1/a','http://[::1]/a','https://example.com:8443/a','http://user:secret@example.com/a']) assert.throws(()=>safeUrl(url));
  for(const ip of ['0.0.0.0','10.0.0.1','172.16.0.1','100.64.1.1','169.254.169.254','192.0.0.1','192.0.2.1','198.18.0.1','203.0.113.1','::ffff:127.0.0.1','2001:db8::1','2001:2::1','2001::1','fc00::1']) assert.equal(isPublicIp(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','192.0.66.184','192.0.78.254','2001:4860:4860::8888','2001:500:2f::f','2606:4700:4700::1111']) assert.equal(isPublicIp(ip),true,ip);
});
test('actual per-endpoint completion timestamp and finite failure status',async()=>{
  const url='http://127.0.0.1/feed';const start=Date.now();
  const result=await checkEndpoint({id:stableId('ep',['rss',url]),type:'rss',url});
  assert.ok(Date.parse(result.checkedAt)>=start && Date.parse(result.checkedAt)<=Date.now());
  assert.equal(result.outcome,'unhealthy');assert.equal(result.reason,'PRIVATE_ADDRESS');assert.equal(result.httpStatus,null);
});
