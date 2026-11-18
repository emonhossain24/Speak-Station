import assert from 'node:assert/strict';
import {loadTs} from './ts-loader.mjs';
const {fetchWithProviderRetry}=loadTs('app/lib/provider-errors.ts');
const prior=globalThis.setTimeout;
globalThis.setTimeout=(fn)=>{fn();return 0};
try{
 let calls=0;
 const ok=await fetchWithProviderRetry(async()=>{calls++;return calls===1?new Response('busy',{status:503}):new Response('ok',{status:200})});
 assert.equal(ok.status,200);assert.equal(calls,2,'503 should retry once then succeed');
 calls=0;
 const limited=await fetchWithProviderRetry(async()=>{calls++;return new Response('quota',{status:429})});
 assert.equal(limited.status,429);assert.equal(calls,1,'429 quota errors must not be retried');
 calls=0;
 const unavailable=await fetchWithProviderRetry(async()=>{calls++;return new Response('busy',{status:503})});
 assert.equal(unavailable.status,503);assert.equal(calls,3,'retry budget is bounded to two retries');
 console.log('PASS: transient 503 retry, 429 no-retry, bounded retry exhaustion');
}finally{globalThis.setTimeout=prior}
