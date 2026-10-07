import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import sodium from 'libsodium-wrappers';
import {seal,recipients} from './seal.mjs';

test('only fixed recipient keys recover the fixture, with no names for opaque recipients',async()=>{
 await sodium.ready;
 const policy=JSON.parse(readFileSync(new URL('./recipients.json',import.meta.url)));
 const keys=recipients.map(()=>sodium.crypto_box_keypair());
 const registry=policy.map((r,i)=>({...r,key_id:String(i+1),key:sodium.to_base64(keys[i].publicKey,sodium.base64_variants.ORIGINAL)}));
 const secret='synthetic-noncredential-fixture';const result=await seal(registry,secret);
 assert.equal(JSON.stringify(result).includes(secret),false);
 for(let i=0;i<result.length;i++){
  const bytes=sodium.from_base64(result[i].encrypted_value,sodium.base64_variants.ORIGINAL);
  assert.equal(sodium.to_string(sodium.crypto_box_seal_open(bytes,keys[i].publicKey,keys[i].privateKey)),secret);
  assert.throws(()=>sodium.crypto_box_seal_open(bytes,keys[(i+1)%recipients.length].publicKey,keys[(i+1)%recipients.length].privateKey));
  if(policy[i].recipient_id){
   assert.deepEqual(Object.keys(result[i]).sort(),['encrypted_value','key_id','recipient_id']);
   assert.match(result[i].recipient_id,/^r-[0-9a-f]{32}$/);
  }
 }
 assert.equal(recipients.length,59);
 assert.equal(policy.filter(r=>r.repository).length,8);
 assert.ok(recipients.includes('dinkuskit/ship'));
 await assert.rejects(seal(registry.slice(0,-1),secret));
 await assert.rejects(seal(registry.map((r,i)=>i===1?registry[0]:r),secret));
 await assert.rejects(seal(registry,''));
 await assert.rejects(seal([...registry,registry[0]],secret));
 await assert.rejects(seal(registry.map((r,i)=>i===0?{...r,repository:'foreign/repo'}:r),secret));
 await assert.rejects(seal(registry.map((r,i)=>i===0?{...r,key:'wrong'}:r),secret));
 const opaque=registry.findIndex(r=>r.recipient_id);
 await assert.rejects(seal(registry.map((r,i)=>i===opaque?{...r,recipient_id:'r-'+'0'.repeat(32)}:r),secret));
 await assert.rejects(seal(registry.map((r,i)=>i===opaque?{...r,repository:'private/name'}:r),secret));
 await assert.rejects(seal(registry.map((r,i)=>i===opaque?{...r,repository_id:123}:r),secret));
});
