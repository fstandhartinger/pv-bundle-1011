import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const config=path.join(os.homedir(),'.config/launch-thread-preview');
fs.mkdirSync(config,{recursive:true,mode:0o700});
for(const [name,value] of [['bundle.key',crypto.randomBytes(32).toString('base64')],['prefix.txt',crypto.randomBytes(16).toString('hex')]]) {
 try {fs.writeFileSync(path.join(config,name),value+'\n',{flag:'wx',mode:0o600});} catch(e) {if(e.code!=='EEXIST')throw e;}
 fs.chmodSync(path.join(config,name),0o600);
}
const key=Buffer.from((process.env.PREVIEW_BUNDLE_KEY||fs.readFileSync(path.join(config,'bundle.key'),'utf8')).trim(),'base64');
if(key.length!==32)throw Error('Bundle key must be 32 bytes base64');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const enc=path.join(here,'enc');fs.mkdirSync(enc,{recursive:true});
const cachePath=path.join(here,'.pack-manifest.json');
const prior=fs.existsSync(cachePath)?JSON.parse(fs.readFileSync(cachePath)):{};
const fingerprint=sha(key);const old=prior.key===fingerprint?prior.files||{}:{};
const manifest={};const local={};const keep=new Set();let changed=0,reused=0;
const maxChunk=32*1024*1024;
function writeEncrypted(name,bytes) {
 const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
 const blob=Buffer.concat([iv,cipher.getAuthTag(),ciphertext]);
 fs.writeFileSync(path.join(enc,name+'.tmp'),blob);fs.renameSync(path.join(enc,name+'.tmp'),path.join(enc,name));
 return sha(blob);
}
function walk(dir,relative='') {
 for(const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
  const name=relative+item.name;const source=path.join(dir,item.name);
  if(item.isSymbolicLink())throw Error('Symlinks are not allowed in public/');
  if(item.isDirectory()) {walk(source,name+'/');continue;}
  if(!item.isFile()||name.split('/').some(p=>p.startsWith('.'))||name.includes('\\'))throw Error('Unsafe asset');
  const bytes=fs.readFileSync(source);const hash=sha(bytes);const previous=old[name];
  if(previous?.sha256===hash && previous.chunks.every(c=>fs.existsSync(path.join(enc,c.blob))&&sha(fs.readFileSync(path.join(enc,c.blob)))===c.encryptedHash)) {
   local[name]=previous;reused++;
  } else {
   const chunks=[];
   for(let offset=0;offset<bytes.length || offset===0;offset+=maxChunk) {
    const part=bytes.subarray(offset,offset+maxChunk);
    const blob=sha(Buffer.from(name+'\0'+hash+'\0'+offset))+'.bin';
    const encryptedHash=writeEncrypted(blob,part);chunks.push({blob,size:part.length,encryptedHash});
    if(!bytes.length)break;
   }
   local[name]={sha256:hash,size:bytes.length,chunks};changed++;
  }
  manifest[name]={size:local[name].size,sha256:hash,chunks:local[name].chunks.map(({blob,size})=>({blob,size}))};
  for(const c of local[name].chunks)keep.add(c.blob);
 }
}
walk(path.join(here,'public'));
const manifestName=sha(Buffer.from('manifest'))+'.bin';keep.add(manifestName);
const manifestBytes=Buffer.from(JSON.stringify(manifest));const manifestHash=sha(manifestBytes);
if(prior.key!==fingerprint || prior.manifestHash!==manifestHash || !fs.existsSync(path.join(enc,manifestName)) || sha(fs.readFileSync(path.join(enc,manifestName)))!==prior.encryptedManifestHash)writeEncrypted(manifestName,manifestBytes);
for(const name of fs.readdirSync(enc))if(!keep.has(name))fs.unlinkSync(path.join(enc,name));
fs.writeFileSync(cachePath,JSON.stringify({key:fingerprint,files:local,manifestHash,encryptedManifestHash:sha(fs.readFileSync(path.join(enc,manifestName)))})+'\n',{mode:0o600});
console.log(`Packed ${changed} changed files; reused ${reused} files; ${keep.size} encrypted blobs.`);
