import sodium from 'libsodium-wrappers';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export const recipients=['commerce','template-store','inventory','payments','dinkuskit'].map(name=>'dinkuskit/'+name);
export async function seal(registry,secret){
 await sodium.ready;
 if(typeof secret!=='string'||secret.length<20)throw Error('dispatch capability is absent');
 if(!Array.isArray(registry)||registry.length!==recipients.length||new Set(registry.map(r=>r.repository)).size!==recipients.length)throw Error('recipient registry mismatch');
 return registry.map(r=>{
  if(!recipients.includes(r.repository)||!/^\d+$/.test(r.key_id))throw Error('recipient registry mismatch');
  const key=sodium.from_base64(r.key,sodium.base64_variants.ORIGINAL);
  if(key.length!==sodium.crypto_box_PUBLICKEYBYTES)throw Error('recipient public key invalid');
  const encrypted_value=sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(secret),key),sodium.base64_variants.ORIGINAL);
  return {repository:r.repository,key_id:r.key_id,encrypted_value};
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const registry=JSON.parse(readFileSync(new URL('./recipients.json',import.meta.url)));
  const payload=await seal(registry,process.env.CLAWSWEEPER_DISPATCH_TOKEN);
  writeFileSync(process.argv[2],JSON.stringify({capability:'clawsweeper.dispatch.priority-five',secret_name:'CLAWSWEEPER_DISPATCH_TOKEN',recipients:payload})+'\n',{mode:0o600,flag:'wx'});
  console.log('Encrypted dispatch capability for five fixed GitHub recipient keys.');
 }catch{console.error('Dispatch capability sealing failed. No secret output.');process.exitCode=1;}
}
