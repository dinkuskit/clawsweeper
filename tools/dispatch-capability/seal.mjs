import sodium from 'libsodium-wrappers';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// This reviewed, fixed file is the policy. No workflow input can add a key.
const fixedRegistry=JSON.parse(readFileSync(new URL('./recipients.json',import.meta.url)));
const identity=r=>r.repository??r.recipient_id;
export const recipients=Object.freeze(fixedRegistry.map(identity));
export async function seal(registry,secret){
 await sodium.ready;
 if(typeof secret!=='string'||secret.length<20)throw Error('dispatch capability is absent');
 if(!Array.isArray(registry)||registry.length!==recipients.length||new Set(registry.map(identity)).size!==recipients.length)throw Error('recipient registry mismatch');
 return registry.map(r=>{
  const named=Object.hasOwn(r,'repository');
  const field=named?'repository':'recipient_id';
  if(Object.keys(r).sort().join(',')!==[field,'key','key_id'].sort().join(',')||!recipients.includes(identity(r))||!/^\d+$/.test(r.key_id))throw Error('recipient registry mismatch');
  if(!named&&!/^r-[0-9a-f]{32}$/.test(r.recipient_id))throw Error('recipient registry mismatch');
  const key=sodium.from_base64(r.key,sodium.base64_variants.ORIGINAL);
  if(key.length!==sodium.crypto_box_PUBLICKEYBYTES)throw Error('recipient public key invalid');
  const encrypted_value=sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(secret),key),sodium.base64_variants.ORIGINAL);
  return {[field]:r[field],key_id:r.key_id,encrypted_value};
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const payload=await seal(fixedRegistry,process.env.CLAWSWEEPER_DISPATCH_TOKEN);
  writeFileSync(process.argv[2],JSON.stringify({capability:'clawsweeper.dispatch.fixed-recipients.v2',secret_name:'CLAWSWEEPER_DISPATCH_TOKEN',recipients:payload})+'\n',{mode:0o600,flag:'wx'});
  console.log('Encrypted dispatch capability for fixed GitHub recipient keys.');
 }catch{console.error('Dispatch capability sealing failed. No secret output.');process.exitCode=1;}
}
