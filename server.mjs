import http from 'node:http';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';
import {pipeline} from 'node:stream/promises';
const here=path.dirname(fileURLToPath(import.meta.url));
const prefixValue=process.env.PREVIEW_PREFIX;
if(!/^[a-f0-9]{32}$/.test(prefixValue||''))throw Error('PREVIEW_PREFIX must be 32 hex characters');
const config={prefix:'/p/'+prefixValue+'/',port:8080};
const key=Buffer.from(process.env.PREVIEW_BUNDLE_KEY||'','base64');
if(key.length!==32)throw Error('PREVIEW_BUNDLE_KEY must be 32 bytes base64');
const enc=path.join(here,'enc');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function decrypt(bytes) {
 const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
 decipher.setAuthTag(bytes.subarray(12,28));
 return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]);
}
const manifest=JSON.parse(decrypt(fs.readFileSync(path.join(enc,sha(Buffer.from('manifest'))+'.bin'))));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pv-bundle-'));fs.chmodSync(root,0o700);
const cleanup=()=>fs.rmSync(root,{recursive:true,force:true});
process.on('exit',cleanup);
try {
 for(const [name,item] of Object.entries(manifest)) {
  if(!name||name.startsWith('/')||name.includes('\\')||name.split('/').some(p=>!p||p==='..'||p.startsWith('.')))throw Error('Unsafe manifest path');
  const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  fs.writeFileSync(target,Buffer.alloc(0),{mode:0o600});
  for(const chunk of item.chunks) {
   if(!/^[a-f0-9]{64}\.bin$/.test(chunk.blob))throw Error('Unsafe blob path');
   const blob=path.join(enc,chunk.blob);const fd=fs.openSync(blob,'r');const header=Buffer.alloc(28);
   try {if(fs.readSync(fd,header,0,28,0)!==28)throw Error('Truncated encrypted blob');}finally{fs.closeSync(fd);}
   const decipher=crypto.createDecipheriv('aes-256-gcm',key,header.subarray(0,12));decipher.setAuthTag(header.subarray(12));
   await pipeline(fs.createReadStream(blob,{start:28}),decipher,fs.createWriteStream(target,{flags:'a',mode:0o600}));
  }
  if(fs.statSync(target).size!==item.size)throw Error('Decrypted size mismatch');
  const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(target))hash.update(chunk);
  if(hash.digest('hex')!==item.sha256)throw Error('Decrypted hash mismatch');
 }
} catch(error) {cleanup();throw error;}
// Generate plaintext HTML only in the ephemeral decrypted runtime, never in Git.
const sandbox={Intl};sandbox.window=sandbox;sandbox.globalThis=sandbox;vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'vendor/twitter-text.js'),'utf8'),sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'render.js'),'utf8'),sandbox);
const view=sandbox.Preview;
const data=JSON.parse(fs.readFileSync(path.join(root,'data/threads.json'),'utf8'));
const template=fs.readFileSync(path.join(root,'index.html'),'utf8');
for(const id of [...data.variants.filter(v=>v.id!=='V').map(v=>v.id),'plan']) {
 if(!/^[A-Za-z0-9_-]+$/.test(id)||data.variants.filter(v=>v.id===id).length>1)throw Error('Unsafe or duplicate variant id');
 const variant=data.variants.find(v=>v.id===id);const body=variant?view.variantHTML(data,variant):view.planHTML(data.first_hour)+view.methodHTML(data);
 let html=template.replace(/<script[^>]*src="app.js"[^>]*><\/script>/g,'').replace('<head>',`<head><base href="${config.prefix}">`)
 .replace('<nav id="tabs" aria-label="Thread variants"></nav>',`<nav id="tabs" aria-label="Thread variants">${view.tabHTML(data,id,true)}</nav>`)
 .replace('<div id="summary"></div>',`<div id="summary"><b>${view.esc(variant?.title||data.first_hour?.title||'First-hour plan')}</b>${view.textHTML(variant?.summary||'Private launch preparation')}</div>`)
 .replace('Loading private preview…',body.replaceAll('href="#method"',`href="${config.prefix}${id}/#method"`)).replace(/<noscript>.*?<\/noscript>/s,'')
 .replace('<nav class="rail" aria-label="Inert X navigation"></nav>',`<nav class="rail" aria-label="Preview navigation"><a class="rail-item" href="${config.prefix}">${view.icon('x')}</a></nav>`);
 const dir=path.join(root,id);fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(path.join(dir,'index.html'),html,{mode:0o600});
}
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.mp4':'video/mp4','.jpg':'image/jpeg','.png':'image/png','.woff2':'font/woff2','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.mov':'video/quicktime','.webm':'video/webm'};
const headers={'X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"};
// Append-only planner storage. Credentials and documents are never logged.
const databaseURL=process.env.PLANNER_DATABASE_URL;
const gallery=fs.existsSync(path.join(root,'data/media.json'))?JSON.parse(fs.readFileSync(path.join(root,'data/media.json'),'utf8')):{items:[]};
const galleryIds=new Set(gallery.items.map(i=>i.id));
const limits=new Map();
const jsonError=(status,message)=>Object.assign(new Error(message),{status});
async function sql(query,params=[]) {
 if(!databaseURL)throw jsonError(503,'Storage offline');
 let response;
 try {response=await fetch('https://'+new URL(databaseURL).hostname+'/sql',{method:'POST',headers:{'Neon-Connection-String':databaseURL,'Content-Type':'application/json'},body:JSON.stringify({query,params}),signal:AbortSignal.timeout(15000)});}catch{throw jsonError(503,'Storage unavailable — retry');}
 if(!response.ok)throw jsonError(503,'Storage unavailable — retry');
 const result=await response.json();if(!Array.isArray(result.rows))throw jsonError(503,'Storage unavailable — retry');return result.rows;
}
function validateDoc(input,title) {
 if(!input||typeof input!=='object'||Array.isArray(input))throw jsonError(400,'Invalid document');
 const doc={title:title??input.title,posts:input.posts};
 if(input.account!==undefined&&input.account!==null){if(!['decisionmodels'].includes(input.account))throw jsonError(400,'Invalid account');doc.account=input.account;}
 if(typeof doc.title!=='string'||doc.title.length>200||!doc.title.trim())throw jsonError(400,'Title must be 1–200 characters');
 if(!Array.isArray(doc.posts)||doc.posts.length<1||doc.posts.length>40)throw jsonError(400,'Use 1–40 posts');
 doc.posts=doc.posts.map(p=>{
  if(!p||typeof p.text!=='string'||p.text.length>25000)throw jsonError(400,'Post text must be at most 25,000 characters');
  if(!Array.isArray(p.media)||p.media.length>4||p.media.some(m=>typeof m!=='string'||!(galleryIds.has(m)||(/^media\/[a-zA-Z0-9_.\/-]+$/.test(m)&&!m.split('/').some(s=>s==='..'||s.startsWith('.'))&&fs.existsSync(path.join(root,m))))))throw jsonError(400,'Invalid media (maximum four local gallery or media items)');
  if(p.quote!==null&&p.quote!==undefined&&(!['decisionmodels_','reaxlabs'].includes(p.quote.account)||typeof p.quote.text!=='string'||p.quote.text.length>1000))throw jsonError(400,'Invalid quote');
  if(p.note!==undefined&&(typeof p.note!=='string'||p.note.length>2000))throw jsonError(400,'Private note must be at most 2,000 characters');
  return {text:p.text,media:p.media,quote:p.quote||null,note:p.note||''};
 });return doc;
}
async function readJSON(req) {
 if(Number(req.headers['content-length'])>256*1024){req.resume();throw jsonError(413,'Body exceeds 256 KB');}
 return new Promise((resolve,reject)=>{
  let size=0,overflow=false;const chunks=[];
  req.on('data',chunk=>{size+=chunk.length;if(size>256*1024){overflow=true;chunks.length=0;}else if(!overflow)chunks.push(chunk);});
  req.on('end',()=>{if(overflow)return reject(jsonError(413,'Body exceeds 256 KB'));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(jsonError(400,'Invalid JSON'));}});
  req.on('error',()=>reject(jsonError(400,'Request interrupted')));
 });
}
async function plannerAPI(req,res,route) {
 const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(req.method==='HEAD'?'':JSON.stringify(value));};
 try {
  if(!['GET','HEAD','POST','PUT','DELETE'].includes(req.method))throw jsonError(405,'Method not allowed');
  const write=!['GET','HEAD'].includes(req.method);
  if(write){
   let sameOrigin=false;try{sameOrigin=!!req.headers.origin&&new URL(req.headers.origin).host===req.headers.host;}catch{}
   if(!sameOrigin&&req.headers['sec-fetch-site']!=='same-origin')throw jsonError(403,'Same-origin writes required');
   const ip=req.socket.remoteAddress||'unknown',now=Date.now();
   for(const [key,value] of limits)if(now-value.start>=60000)limits.delete(key);
   const bucket=limits.get(ip)||{start:now,count:0};if(++bucket.count>120)throw jsonError(429,'Too many writes — retry in one minute');limits.set(ip,bucket);
  }
  if(/^(seen|saved|shares|uploads)(\/|$)/.test(route))return await extraAPI(req,res,route,send,new URL(req.url,'http://local').searchParams);
  const match=/^threads(?:\/(th_[a-f0-9]{12})(?:\/rev\/(\d+))?)?$/.exec(route);if(!match)throw jsonError(404,'Not found');
  const [,tid,rid]=match;
  if(!write){
   if(!tid){const rows=await sql("SELECT thread_id, id, title, created_at AS updated, jsonb_array_length(doc->'posts') AS post_count FROM (SELECT DISTINCT ON (thread_id) * FROM planner_revisions ORDER BY thread_id,id DESC) latest WHERE NOT deleted ORDER BY id DESC");return send(200,{threads:rows});}
   const rows=await sql('SELECT id, thread_id, title, doc, created_at, deleted FROM planner_revisions WHERE thread_id=$1'+(rid?' AND id=$2':'')+' ORDER BY id DESC LIMIT 1',rid?[tid,rid]:[tid]);
   if(!rows.length||(!rid&&rows[0].deleted))throw jsonError(404,'Thread not found');
   const history=await sql("SELECT id, created_at, deleted, jsonb_array_length(doc->'posts') AS post_count FROM planner_revisions WHERE thread_id=$1 ORDER BY id DESC",[tid]);return send(200,{...rows[0],revisions:history});
  }
  if(rid||(!tid&&req.method!=='POST')||(tid&&req.method==='POST'))throw jsonError(405,'Method not allowed');
  let previous=null;if(tid){const rows=await sql('SELECT * FROM planner_revisions WHERE thread_id=$1 ORDER BY id DESC LIMIT 1',[tid]);previous=rows[0];if(!previous||previous.deleted)throw jsonError(404,'Thread not found');}
  const body=req.method==='DELETE'?{}:await readJSON(req);
  const doc=req.method==='DELETE'?previous.doc:validateDoc(body.doc,body.title);
  if(body.base_rev!==undefined&&!/^\d+$/.test(String(body.base_rev)))throw jsonError(400,'Invalid base revision');
  const id=tid||'th_'+crypto.randomBytes(6).toString('hex');
  const rows=await sql('INSERT INTO planner_revisions(thread_id,title,doc,author,deleted) VALUES($1,$2,$3::jsonb,$4,$5) RETURNING id,thread_id,title,doc,created_at,deleted',[id,doc.title,JSON.stringify(doc),'browser',req.method==='DELETE']);
  if(req.method==='DELETE'){const revoked=await sql('UPDATE planner_shares SET revoked_at=now() WHERE thread_id=$1 AND revoked_at IS NULL RETURNING token',[id]);revoked.forEach(r=>dropShare(r.token));}
  return send(tid?200:201,{...rows[0],changed_elsewhere:!!(previous&&body.base_rev!==undefined&&String(body.base_rev)!==String(previous.id))});
 }catch(error){if(!error.status)console.error('api error',error?.message);send(error.status||500,{error:error.status?error.message:'Planner request failed'});}
}

// r6: per-viewer "seen" state, named saved versions and read-only share links.
// The private prefix is the only credential; share pages live under /s/<token>/ and never reveal it.
const viewer=sha(Buffer.from('viewer:'+prefixValue)).slice(0,16);
const galleryById=new Map(gallery.items.map(i=>[i.id,i]));
const galleryMids=new Set(gallery.items.map(i=>i.mid).filter(Boolean));
const threadRE=/^th_[a-f0-9]{12}$/,tokenRE=/^[A-Za-z0-9_-]{32}$/;
const shareCache=new Map(),shareLoads=new Map(),shareGen=new Map();
const dropShare=token=>{shareCache.delete(token);shareLoads.delete(token);shareGen.set(token,(shareGen.get(token)||0)+1);};
async function liveThread(tid){if(typeof tid!=='string'||!threadRE.test(tid))throw jsonError(400,'Invalid thread');const rows=await sql('SELECT deleted FROM planner_revisions WHERE thread_id=$1 ORDER BY id DESC LIMIT 1',[tid]);if(!rows.length||rows[0].deleted)throw jsonError(404,'Thread not found');}
async function extraAPI(req,res,route,send,query) {
 const read=['GET','HEAD'].includes(req.method);
 if(route==='seen'){
  if(read){const rows=await sql('SELECT mid FROM media_seen WHERE viewer=$1',[viewer]);return send(200,{seen:rows.map(r=>r.mid)});}
  if(req.method!=='POST')throw jsonError(405,'Method not allowed');
  const body=await readJSON(req);
  if(!Array.isArray(body.mids)||!body.mids.length||body.mids.length>5000||body.mids.some(m=>typeof m!=='string'||!(galleryMids.has(m)||/^M\d{3,6}$/.test(m)))||typeof body.seen!=='boolean')throw jsonError(400,'Invalid seen update');
  const mids=JSON.stringify([...new Set(body.mids)]);
  if(body.seen)await sql('INSERT INTO media_seen(viewer,mid) SELECT $1, jsonb_array_elements_text($2::jsonb) ON CONFLICT DO NOTHING',[viewer,mids]);
  else await sql('DELETE FROM media_seen WHERE viewer=$1 AND mid IN (SELECT jsonb_array_elements_text($2::jsonb))',[viewer,mids]);
  return send(200,{ok:true});
 }
 if(route==='saved'){
  if(read){const tid=query.get('thread');if(!threadRE.test(tid||''))throw jsonError(400,'Invalid thread');return send(200,{saved:await sql("SELECT id, name, created_at, jsonb_array_length(doc->'posts') AS post_count FROM planner_saved WHERE thread_id=$1 ORDER BY id DESC LIMIT 200",[tid])});}
  if(req.method!=='POST')throw jsonError(405,'Method not allowed');
  const body=await readJSON(req);await liveThread(body.thread_id);
  if(typeof body.name!=='string'||!body.name.trim()||body.name.length>120)throw jsonError(400,'Version name must be 1–120 characters');
  const doc=validateDoc(body.doc,body.doc?.title);
  const rows=await sql("SELECT 1 FROM planner_saved WHERE thread_id=$1 GROUP BY thread_id HAVING count(*)>=500",[body.thread_id]);if(rows.length)throw jsonError(400,'Too many saved versions for this thread');
  const out=await sql("INSERT INTO planner_saved(thread_id,name,doc) VALUES($1,$2,$3::jsonb) RETURNING id, name, created_at, jsonb_array_length(doc->'posts') AS post_count",[body.thread_id,body.name.trim(),JSON.stringify(doc)]);
  return send(201,out[0]);
 }
 const sm=/^saved\/(\d{1,15})$/.exec(route);
 if(sm){if(!read)throw jsonError(405,'Method not allowed');const rows=await sql('SELECT id, thread_id, name, doc, created_at FROM planner_saved WHERE id=$1',[sm[1]]);if(!rows.length)throw jsonError(404,'Version not found');return send(200,rows[0]);}
 if(route==='shares'){
  if(read){const tid=query.get('thread');if(!threadRE.test(tid||''))throw jsonError(400,'Invalid thread');return send(200,{shares:await sql('SELECT s.token, s.saved_id, s.created_at, s.updated_at, s.revoked_at, p.name, p.created_at AS saved_at FROM planner_shares s JOIN planner_saved p ON p.id=s.saved_id WHERE s.thread_id=$1 ORDER BY s.created_at DESC LIMIT 200',[tid])});}
  if(req.method!=='POST')throw jsonError(405,'Method not allowed');
  const body=await readJSON(req);if(!/^\d{1,15}$/.test(String(body.saved_id)))throw jsonError(400,'Invalid version');
  const saved=await sql('SELECT thread_id FROM planner_saved WHERE id=$1',[String(body.saved_id)]);if(!saved.length)throw jsonError(404,'Version not found');
  const token=crypto.randomBytes(24).toString('base64url');
  const out=await sql('INSERT INTO planner_shares(token,saved_id,thread_id) VALUES($1,$2,$3) RETURNING token, saved_id, created_at, updated_at, revoked_at',[token,String(body.saved_id),saved[0].thread_id]);
  return send(201,out[0]);
 }
 const tm=/^shares\/([A-Za-z0-9_-]{32})$/.exec(route);
 if(tm&&!read){
  const token=tm[1];const rows=await sql('SELECT thread_id, revoked_at FROM planner_shares WHERE token=$1',[token]);if(!rows.length)throw jsonError(404,'Link not found');
  dropShare(token);
  if(req.method==='DELETE'){await sql('UPDATE planner_shares SET revoked_at=coalesce(revoked_at,now()) WHERE token=$1',[token]);dropShare(token);return send(200,{token,revoked:true});}
  if(req.method!=='PUT')throw jsonError(405,'Method not allowed');
  if(rows[0].revoked_at)throw jsonError(400,'Link was revoked; create a new one');
  const body=await readJSON(req);if(!/^\d{1,15}$/.test(String(body.saved_id)))throw jsonError(400,'Invalid version');
  const saved=await sql('SELECT thread_id FROM planner_saved WHERE id=$1',[String(body.saved_id)]);if(!saved.length||saved[0].thread_id!==rows[0].thread_id)throw jsonError(400,'Version belongs to another thread');
  const out=await sql('UPDATE planner_shares SET saved_id=$2, updated_at=now() WHERE token=$1 AND revoked_at IS NULL RETURNING token, saved_id, created_at, updated_at, revoked_at',[token,String(body.saved_id)]);dropShare(token);
  if(!out.length)throw jsonError(400,'Link was revoked; create a new one');return send(200,out[0]);
 }
 if(route==='uploads'||route.startsWith('uploads/'))return uploadsAPI(req,res,route,send);
 throw jsonError(404,'Not found');
}
// Browser uploads (private page only). Files live in the container until tools/pull_uploads.py on Sandy copies them
// into assets/uploads/ and the next bundle bakes them into the gallery under the same id and M-ID.
fs.mkdirSync(path.join(os.tmpdir(),'pv-uploads'),{recursive:true,mode:0o700});const uploadDir=fs.realpathSync(path.join(os.tmpdir(),'pv-uploads'));
const uploadTypes={png:'image',jpg:'image',jpeg:'image',webp:'image',gif:'image',mp4:'video',mov:'video',webm:'video'};
const maxUpload=500*1024*1024,maxChunk=16*1024*1024,maxStored=6*1024*1024*1024,activeUploads=new Map();
const storedBytes=()=>fs.readdirSync(uploadDir).reduce((n,f)=>{try{return n+fs.statSync(path.join(uploadDir,f)).size}catch{return n}},0)+[...activeUploads.values()].reduce((n,u)=>n+u.size,0);
const uploadFile=(id,ext)=>path.join(uploadDir,id+'.'+ext);
function magicOK(file,ext){const fd=fs.openSync(file,'r'),h=Buffer.alloc(16);try{fs.readSync(fd,h,0,16,0);}finally{fs.closeSync(fd);}const a=h.toString('latin1');
 return ext==='png'?h.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])):['jpg','jpeg'].includes(ext)?h[0]===0xff&&h[1]===0xd8&&h[2]===0xff:ext==='gif'?/^GIF8[79]a/.test(a):ext==='webp'?a.startsWith('RIFF')&&a.slice(8,12)==='WEBP':ext==='webm'?h.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])):['ftyp','moov','wide','mdat','free','skip'].includes(a.slice(4,8));}
function receiveChunk(req,file,max){return new Promise((resolve,reject)=>{let n=0,done=false;const out=fs.createWriteStream(file,{flags:'a'});
 const stop=error=>{if(done)return;done=true;req.unpipe(out);out.once('close',()=>reject(error));out.destroy();req.destroy();};
 req.setTimeout(240000,()=>stop(jsonError(408,'Upload stalled')));req.on('close',()=>{if(!req.complete)stop(jsonError(400,'Upload interrupted'));});
 req.on('data',c=>{n+=c.length;if(n>max)stop(jsonError(413,'Chunk too large'));});req.on('error',()=>stop(jsonError(400,'Upload interrupted')));req.on('aborted',()=>stop(jsonError(400,'Upload interrupted')));
 out.on('error',()=>stop(jsonError(500,'Could not store upload')));out.on('finish',()=>{if(!done){done=true;resolve(n);}});req.pipe(out);});}
async function uploadsAPI(req,res,route,send) {
 const read=['GET','HEAD'].includes(req.method);
 if(route==='uploads'){
  if(read){const rows=await sql("SELECT id, mid, name, ext, kind, title, notes, size, created_at FROM media_uploads WHERE status='ready' ORDER BY created_at DESC LIMIT 500");return send(200,{uploads:rows.map(r=>({...r,available:fs.existsSync(uploadFile(r.id,r.ext))}))});}
  if(req.method!=='POST')throw jsonError(405,'Method not allowed');
  const body=await readJSON(req);const name=String(body.name||''),ext=(/\.([A-Za-z0-9]{2,5})$/.exec(name)?.[1]||'').toLowerCase(),size=Number(body.size);
  if(!Object.hasOwn(uploadTypes,ext))throw jsonError(400,'Allowed: png, jpg, webp, gif, mp4, mov, webm');
  if(!Number.isSafeInteger(size)||size<1||size>maxUpload)throw jsonError(400,'Files must be at most 500 MB');
  if(name.length>200||(body.title!==undefined&&(typeof body.title!=='string'||body.title.length>200))||(body.notes!==undefined&&(typeof body.notes!=='string'||body.notes.length>2000)))throw jsonError(400,'Title max 200, notes max 2,000 characters');
  if(activeUploads.size>=20)throw jsonError(429,'Too many uploads in progress');
  if(storedBytes()+size>maxStored)throw jsonError(507,'Upload storage is full until the next sync — retry in about 20 minutes');
  const id='up_'+crypto.randomBytes(6).toString('hex');activeUploads.set(id,{ext,size,busy:false,started:Date.now()});let mid;try{
  const [{n}]=await sql("INSERT INTO media_mid(key,n) VALUES($1,nextval('media_mid_seq')) RETURNING n",['upload:'+id]);mid='M'+String(n).padStart(3,'0');
  const title=(body.title||'').trim()||name.replace(/\.[^.]+$/,'').replace(/[_-]+/g,' ').slice(0,200);
  await sql('INSERT INTO media_uploads(id,mid,name,ext,kind,title,notes,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,mid,name,ext,uploadTypes[ext],title,(body.notes||'').trim(),size]);
  fs.writeFileSync(uploadFile(id,ext),'',{mode:0o600});
  }catch(error){activeUploads.delete(id);throw error;}
  return send(201,{id,mid,chunk:maxChunk});
 }
 const m=/^uploads\/(up_[a-f0-9]{12})(?:\/(file|complete))?$/.exec(route);if(!m)throw jsonError(404,'Not found');
 const [,id,action]=m;
 if(action==='file'){
  if(!read)throw jsonError(405,'Method not allowed');const rows=await sql("SELECT ext FROM media_uploads WHERE id=$1 AND status='ready'",[id]);if(!rows.length||!Object.hasOwn(uploadTypes,rows[0].ext))throw jsonError(404,'Upload not found');
  res.setHeader('Content-Security-Policy',"default-src 'none'; img-src 'self'; media-src 'self'; sandbox");res.setHeader('Content-Disposition','inline');
  return serveFile(req,res,id+'.'+rows[0].ext,(code,msg)=>send(code,{error:msg}),uploadDir);
 }
 const up=activeUploads.get(id);if(!up)throw jsonError(404,'Upload session not found — start again');
 const file=uploadFile(id,up.ext);
 if(!action&&req.method==='PUT'){
  if(up.busy)throw jsonError(409,'Chunk already in progress');const offset=Number(new URL(req.url,'http://local').searchParams.get('offset'));const have=fs.statSync(file).size;
  if(offset!==have){req.resume();return send(409,{error:'Offset mismatch',received:have});}
  up.busy=true;try{await receiveChunk(req,file,Math.min(maxChunk,up.size-have));}catch(error){fs.truncateSync(file,have);throw error;}finally{up.busy=false;}
  return send(200,{received:fs.statSync(file).size});
 }
 if(action==='complete'&&req.method==='POST'){
  if(up.busy)throw jsonError(409,'Chunk in progress');const have=fs.statSync(file).size;
  if(have!==up.size)throw jsonError(400,'Upload incomplete');
  if(!magicOK(file,up.ext)){activeUploads.delete(id);fs.rmSync(file,{force:true});await sql("UPDATE media_uploads SET status='rejected' WHERE id=$1",[id]);throw jsonError(400,'File content does not match its type');}
  activeUploads.delete(id);const rows=await sql("UPDATE media_uploads SET status='ready', ready_at=now() WHERE id=$1 RETURNING id, mid, name, ext, kind, title, notes, size, created_at",[id]);
  await sql('INSERT INTO media_seen(viewer,mid) VALUES($1,$2) ON CONFLICT DO NOTHING',[viewer,rows[0].mid]);
  return send(200,{...rows[0],available:true});
 }
 throw jsonError(405,'Method not allowed');
}
// Reap abandoned sessions (6 h) and ready files older than 3 days (Sandy pulls them within minutes).
setInterval(()=>{for(const [id,u] of activeUploads)if(Date.now()-u.started>6*3600e3&&!u.busy){activeUploads.delete(id);fs.rmSync(uploadFile(id,u.ext),{force:true});}
 for(const f of fs.readdirSync(uploadDir)){const id=f.split('.')[0];try{if(!activeUploads.has(id)&&Date.now()-fs.statSync(path.join(uploadDir,f)).mtimeMs>3*86400e3)fs.rmSync(path.join(uploadDir,f),{force:true});}catch{}}},600e3).unref();
const shareAssets=['style.css','render.js','interactions.js','media/av_a.jpg','media/av_d.png','media/av_r.jpg'];
function shareMedia(id){
 const g=galleryById.get(id);if(g)return {src:g.src,type:g.kind,poster:g.kind==='video'?g.poster:undefined,og:g.kind==='video'?g.poster:g.src,alt:g.kind==='video'?'Video':'Image'};
 if(typeof id!=='string'||!/^media\/[a-zA-Z0-9_.\/-]+\.(jpe?g|png|mp4)$/i.test(id)||id.split('/').some(s=>s==='..'||s.startsWith('.'))||!fs.existsSync(path.join(root,id)))return null;
 const video=/\.mp4$/i.test(id),poster=id.replace(/\.mp4$/i,'.jpg');const hasPoster=video&&fs.existsSync(path.join(root,poster));
 return {src:id,type:video?'video':'image',poster:hasPoster?poster:undefined,og:video?(hasPoster?poster:null):id,alt:video?'Video':'Image'};
}
function buildShare(row,token) {
 const allowed=new Set(shareAssets);let og=null;
 const posts=row.doc.posts.map((p,i)=>{
  const media=(p.media||[]).map(shareMedia).filter(Boolean);
  for(const m of media){allowed.add(m.src);if(m.poster)allowed.add(m.poster);if(!og&&m.og)og=m.og;}
  const q=p.quote?{handle:p.quote.account,name:p.quote.account==='reaxlabs'?'REAX Labs':'Decision Models',avatar:p.quote.account==='reaxlabs'?'media/av_r.jpg':'media/av_d.png',text:p.quote.text,media:[]}:null;
  const clean=t=>String(t??'').replace(/⟨pending:[^⟩]*⟩/g,'⟨pending:⟩');if(q)q.text=clean(q.text);
  return view.postHTML({n:i+1,account:row.doc.account,text:clean(p.text),notes:'',media:media.map(({src,type,poster,alt})=>({src,type,poster,alt})),quote:q},i,row.doc.posts.length);
 });
 const first=String(row.doc.posts[0]?.text||'').replace(/⟨pending:[^⟩]*⟩/g,'…').split('\n').map(s=>s.trim()).find(Boolean)||row.doc.title;
 const title=first.length>90?first.slice(0,88).trimEnd()+'…':first;
 const who=view.author(row.doc.account);
 return {allowed,who,og:og||who.avatar,title,count:row.doc.posts.length,body:posts.join('')};
}
async function loadShare(token){
 const hit=shareCache.get(token);if(hit&&Date.now()-hit.at<(hit.value?15000:60000))return hit.value;
 if(shareLoads.has(token))return shareLoads.get(token);
 const gen=shareGen.get(token)||0;
 const load=(async()=>{
  const rows=await sql('SELECT s.revoked_at, p.doc FROM planner_shares s JOIN planner_saved p ON p.id=s.saved_id WHERE s.token=$1',[token]);
  const value=rows.length&&!rows[0].revoked_at?buildShare(rows[0],token):null;
  if((shareGen.get(token)||0)===gen){shareCache.delete(token);shareCache.set(token,{at:Date.now(),value});while(shareCache.size>500)shareCache.delete(shareCache.keys().next().value);}
  return value;
 })().finally(()=>{if(shareLoads.get(token)===load)shareLoads.delete(token);});
 shareLoads.set(token,load);return load;
}
function shareHTML(share,token,origin) {
 const e=view.esc,base='/s/'+token+'/',abs=origin+base;
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="dark"><meta name="referrer" content="no-referrer"><base href="${base}"><title>${e(share.title)} · draft preview</title>`+
 `<meta property="og:type" content="article"><meta property="og:site_name" content="Draft preview"><meta property="og:title" content="${e(share.title)}"><meta property="og:description" content="Draft thread by ${e(share.who.name)} (@${e(share.who.handle)}) · ${share.count} post${share.count===1?'':'s'} · not posted yet"><meta property="og:url" content="${e(abs)}"><meta property="og:image" content="${e(abs+share.og)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${e(share.title)}"><meta name="twitter:image" content="${e(abs+share.og)}">`+
 `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath stroke='white' d='m4 4 16 16M20 4 4 20'/%3E%3C/svg%3E"><link rel="stylesheet" href="style.css"><script defer src="render.js"></script><script defer src="interactions.js"></script></head>`+
 `<body class="share post-page notes-off"><div class="mobile-header"><img src="${e(share.who.avatar)}" alt="${e(share.who.name)}"><span class="mobile-x" aria-label="X">𝕏</span><span class="draft-label">Draft preview</span></div><div class="layout"><nav class="rail" aria-label="Inert X navigation"></nav><main><header><div class="heading"><span class="back" aria-hidden="true">←</span><div><h1>Post</h1></div><span class="draft-label">Draft preview</span></div></header><div id="thread">${share.body}</div></main></div><nav class="mobile-tabs" aria-label="Inert X navigation"></nav></body></html>`;
}

async function serveFile(req,res,relative,fail,base=root) {
 const filename=path.resolve(base,relative);if(!filename.startsWith(base+path.sep))return fail(404,'Not found');let stat;try{const real=await fs.promises.realpath(filename);if(!real.startsWith(base+path.sep))return fail(404,'Not found');stat=await fs.promises.stat(filename);if(!stat.isFile())return fail(404,'Not found')}catch{return fail(404,'Not found')}
 res.setHeader('Content-Type',types[path.extname(filename)]||'application/octet-stream');res.setHeader('Accept-Ranges','bytes');let start=0,end=stat.size-1,status=200;const range=req.headers.range;if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2])){res.setHeader('Content-Range',`bytes */${stat.size}`);return fail(416,'Invalid range')}if(!match[1]){const suffix=Number(match[2]);start=Math.max(0,stat.size-suffix)}else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]))}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=stat.size){res.setHeader('Content-Range',`bytes */${stat.size}`);return fail(416,'Unsatisfiable range')}status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${stat.size}`)}res.setHeader('Content-Length',end-start+1);res.writeHead(status);if(req.method==='HEAD')return res.end();const stream=fs.createReadStream(filename,{start,end});req.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res)
}
async function shareRoute(req,res,pathname,fail) {
 const m=/^\/s\/([^/]*)(\/.*)?$/.exec(pathname);if(!m||!tokenRE.test(m[1]))return fail(404,'Not found');
 const token=m[1];if(m[2]===undefined){res.writeHead(301,{Location:'/s/'+token+'/'});return res.end();}
 let share;try{share=await loadShare(token);}catch{return fail(503,'Temporarily unavailable — retry')}
 if(!share)return fail(404,'This draft link is not available.');
 const relative=m[2].slice(1);
 if(!relative){const host=/^[A-Za-z0-9.-]+(:\d+)?$/.test(req.headers.host||'')?req.headers.host:'localhost';const proto=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='http'?'http':'https';const html=shareHTML(share,token,proto+'://'+host);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':Buffer.byteLength(html)});return res.end(req.method==='HEAD'?'':html);}
 if(!share.allowed.has(relative))return fail(404,'Not found');
 return serveFile(req,res,relative,fail);
}
const server=http.createServer(async(req,res)=>{Object.entries(headers).forEach(([k,v])=>res.setHeader(k,v));const fail=(code,msg)=>{if(res.headersSent)return res.destroy();res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8'});res.end(msg)};let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://local').pathname)}catch{return fail(400,'Bad request')}if(pathname.startsWith(config.prefix+'api/'))return plannerAPI(req,res,pathname.slice((config.prefix+'api/').length));if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');return fail(405,'Method not allowed')}if(pathname==='/healthz'){res.writeHead(200,{'Content-Type':'text/plain'});return res.end(req.method==='HEAD'?'':'ok\n')}if(pathname.startsWith('/s/'))return shareRoute(req,res,pathname,fail);if(!pathname.startsWith(config.prefix))return fail(404,'Not found');let relative=pathname.slice(config.prefix.length)||'index.html';if(relative.endsWith('/'))relative+='index.html';if(relative.split('/').some(p=>p==='..'||p.startsWith('.')))return fail(404,'Not found');return serveFile(req,res,relative,fail)});
server.listen(Number(process.env.PORT||config.port),process.env.HOST||'0.0.0.0',()=>console.log(`Private preview listening; port ${process.env.PORT||config.port}`));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
