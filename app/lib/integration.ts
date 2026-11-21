import {providerFailure} from './provider-errors';
function toArrayBuffer(bytes:Uint8Array):ArrayBuffer{const copy=new Uint8Array(bytes.byteLength);copy.set(bytes);return copy.buffer;}
function credentialKeyBytes(key:string){
 let bytes:Uint8Array;
 try{bytes=Uint8Array.from(atob(key.trim()),c=>c.charCodeAt(0));}catch{throw new Error('CREDENTIAL_ENCRYPTION_KEY must be Base64-encoded 32 random bytes.');}
 if(bytes.length!==32)throw new Error('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes. Check the Cloudflare Worker Secret value; do not use the Gemini API key here.');
 return bytes;
}
export function validateCredentialEncryptionKey(key:string){credentialKeyBytes(key);}
export async function encryptCredential(value:string,key:string){const bytes=credentialKeyBytes(key);const aes=await crypto.subtle.importKey('raw',toArrayBuffer(bytes),'AES-GCM',false,['encrypt']);const iv=crypto.getRandomValues(new Uint8Array(12));const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv:toArrayBuffer(iv)},aes,new TextEncoder().encode(value));return JSON.stringify({iv:Array.from(iv),cipher:Array.from(new Uint8Array(cipher))});}
export async function decryptCredential(value:string,key:string){const item=JSON.parse(value);if(!Array.isArray(item.iv)||item.iv.length!==12||!Array.isArray(item.cipher)||!item.cipher.length)throw new Error('Saved Gemini credential has an invalid encrypted format.');const aes=await crypto.subtle.importKey('raw',toArrayBuffer(credentialKeyBytes(key)),'AES-GCM',false,['decrypt']);const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:toArrayBuffer(new Uint8Array(item.iv))},aes,toArrayBuffer(new Uint8Array(item.cipher)));return new TextDecoder().decode(plain);}

type ConnectionInfo={encrypted?:string;model?:string;models?:string[];fallbackModels?:string[];checkedAt?:string};
async function savedConnection(env:any,db:D1Database):Promise<{key?:string;model?:string;models?:string[];fallbackModels?:string[];checkedAt?:string;unavailable?:string}|null>{
 const result=await db.prepare("SELECT value FROM settings WHERE key='gemini_connection'").bind().all();
 const row:any=result.results?.[0];
 if(!row)return null;
 if(!env.CREDENTIAL_ENCRYPTION_KEY)return {unavailable:'Saved Gemini connection needs the original credential-encryption secret.'};
 try{
  const record:ConnectionInfo=JSON.parse(row.value);
  if(!record.encrypted)throw Error('Missing encrypted value');
  const key=await decryptCredential(record.encrypted,env.CREDENTIAL_ENCRYPTION_KEY);
  if(!key)return {unavailable:'Saved Gemini connection is empty.'};
  return {key,model:record.model,models:Array.isArray(record.models)?record.models:[],fallbackModels:Array.isArray(record.fallbackModels)?record.fallbackModels:[],checkedAt:record.checkedAt};
 }catch{
  return {unavailable:'A saved Gemini connection exists, but cannot be decrypted. Restore the original CREDENTIAL_ENCRYPTION_KEY or use a securely stored Cloudflare GEMINI_API_KEY secret.'};
 }
}
export async function aiConfiguration(env:any,db:D1Database){
 const saved=await savedConnection(env,db);
 if(saved?.key)return {...env,AI_PROVIDER:'gemini',GEMINI_API_KEY:saved.key,AI_MODEL:saved.model||env.AI_MODEL,AI_FALLBACK_MODELS:(saved.fallbackModels||[]).filter(model=>model!==saved.model)};
 if(env.GEMINI_API_KEY)return {...env,AI_PROVIDER:'gemini'};
 return env;
}
export async function connectionStatus(env:any,db:D1Database){
 const saved=await savedConnection(env,db);
 if(saved?.key)return {configured:true,provider:'gemini',model:saved.model||env.AI_MODEL||null,models:saved.models?.length?saved.models:(saved.model?[saved.model]:[]),fallbackModels:saved.fallbackModels||[],checkedAt:saved.checkedAt||null,source:'secure_connection'};
 if(env.GEMINI_API_KEY)return {configured:true,provider:'gemini',model:env.AI_MODEL||null,checkedAt:null,source:'cloudflare_secret'};
 if(env.OPENAI_API_KEY)return {configured:true,provider:'openai',model:env.AI_MODEL||null,checkedAt:null,source:'cloudflare_secret'};
 return {configured:false,provider:null,model:null,checkedAt:null,source:'missing',reason:saved?.unavailable||'This Cloudflare environment has no saved Gemini connection or GEMINI_API_KEY Secret. A prior separate deployment does not automatically transfer its encrypted key.'};
}
export async function listGeminiModels(key:string){
 const res=await fetch('https://generativelanguage.googleapis.com/v1beta/models',{redirect:'manual',headers:{'x-goog-api-key':key},signal:AbortSignal.timeout(20000)});
 if(!res.ok)throw await providerFailure(res,'Gemini');
 const value:any=await res.json();
 const candidates=(value.models||[]).filter((model:any)=>(model.supportedGenerationMethods||[]).includes('generateContent')&&/flash/.test(model.name)&&!/(image|tts|live|embed|thinking|cyber|robot|computer|agent)/.test(model.name));
 const version=(name:string)=>Number(name.match(/gemini-(\\d+(?:\\.\\d+)?)/)?.[1]||0);
 const rank=(name:string)=>(!/(preview|experimental)/.test(name)?10000:0)+(/flash-lite/.test(name)?1000:0)+version(name)*10;
 candidates.sort((a:any,b:any)=>rank(b.name)-rank(a.name));
 const models=[...new Set(candidates.map((model:any)=>String(model.name).replace(/^models\\//,'')))];
 if(!models.length)throw new Error('Google accepted the API key, but this project has no available Gemini Flash model with generateContent support. Check Google AI Studio model access and API enablement.');
 return models;
}
export async function verifyGemini(key:string,excludeModels:string[]=[]){
 const models=await listGeminiModels(key);
 const preferred=models.find(model=>!excludeModels.includes(model));
 if(!preferred)throw new Error('No unused Gemini Flash model is available for fallback.');
 return preferred;
}
