import test from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import {seal,recipients} from './seal.mjs';
test('only the five recipient private keys can recover the fixture; no plaintext output',async()=>{
 await sodium.ready;
 const keys=recipients.map(()=>sodium.crypto_box_keypair());
 const registry=recipients.map((repository,i)=>({repository,key_id:String(i+1),key:sodium.to_base64(keys[i].publicKey,sodium.base64_variants.ORIGINAL)}));
 const secret='synthetic-noncredential-fixture';const result=await seal(registry,secret);
 assert.equal(JSON.stringify(result).includes(secret),false);
 for(let i=0;i<result.length;i++){
  const bytes=sodium.from_base64(result[i].encrypted_value,sodium.base64_variants.ORIGINAL);
  assert.equal(sodium.to_string(sodium.crypto_box_seal_open(bytes,keys[i].publicKey,keys[i].privateKey)),secret);
  assert.throws(()=>sodium.crypto_box_seal_open(bytes,keys[(i+1)%5].publicKey,keys[(i+1)%5].privateKey));
 }
 await assert.rejects(seal(registry,''));
 await assert.rejects(seal([...registry,registry[0]],secret));
 await assert.rejects(seal(registry.map((r,i)=>i===0?{...r,repository:'foreign/repo'}:r),secret));
 await assert.rejects(seal(registry.map((r,i)=>i===0?{...r,key:'wrong'}:r),secret));
});
