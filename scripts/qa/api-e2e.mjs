import WebSocket from 'ws';
const BASE=process.env.CF_API_BASE ?? 'http://127.0.0.1:5000';
let cookies={}, csrf='';
const jar=()=>Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ');
async function req(method,path,body,headers={}){
  const res=await fetch(BASE+path,{method,headers:{cookie:jar(),...(body?{'content-type':'application/json'}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...headers},body:body?JSON.stringify(body):undefined});
  for(const c of res.headers.getSetCookie?.()??[]){const [kv]=c.split(';');const i=kv.indexOf('=');const k=kv.slice(0,i),v=kv.slice(i+1);if(!v) delete cookies[k]; else cookies[k]=v;}
  if(res.headers.get('x-csrf-token')) csrf=res.headers.get('x-csrf-token');
  const text=await res.text(); let json;try{json=JSON.parse(text)}catch{}
  return {status:res.status,json,text};
}
let pass=0,fail=0;
const out=(name,ok,detail='')=>{ok?pass++:fail++;console.log(`${ok?'PASS':'FAIL'} ${name}${detail?' :: '+detail:''}`)};
const health=await req('GET','/api/health'); out('health',health.json?.ok===true, JSON.stringify(health.json?.runner));
const login=await req('POST','/api/auth/login',{email:'learner@cipherforge.dev',password:'CipherForge!2024'});
out('login',login.status===200 && !!cookies.cf_session, `status=${login.status} user=${login.json?.user?.username}`);
const me=await req('GET','/api/auth/me'); out('me',me.json?.user?.email==='learner@cipherforge.dev');
const labs=await req('GET','/api/labs'); out('labs list',labs.status===200 && labs.json.labs.length>=1, `n=${labs.json?.labs?.length}`);
const detail=await req('GET','/api/labs/http-header-hunt'); out('lab detail', Array.isArray(detail.json?.lab?.objectives) && detail.json.lab.objectives.length===3, detail.json?.lab?.objectives?.map(o=>o.id).join(','));
const badStart=await req('POST','/api/labs/http-header-hunt/sessions',{},{'x-csrf-token':''});
out('CSRF missing rejected',badStart.status===403,`status=${badStart.status}`);
const start=await req('POST','/api/labs/http-header-hunt/sessions',{});
const sid=start.json?.session?.id; let sess=start.json?.session;
out('start lab',(start.status===201||start.status===200) && !!sid,`status=${start.status} state=${sess?.state}`);
const seen=[]; 
for(let i=0;i<100 && sess && !['ready','failed','expired','stopped'].includes(sess.state);i++){await new Promise(r=>setTimeout(r,250)); const r=await req('GET',`/api/sessions/${sid}`); sess=r.json?.session; if(sess?.state && seen.at(-1)!==sess.state) seen.push(sess.state);}
out('lab reaches ready',sess?.state==='ready',`states=${seen.join('>')} failure=${JSON.stringify(sess?.failure)}`);
out('session exposes terminal+target',Boolean(sess?.terminalPath) && (sess?.targets?.length>0), JSON.stringify({terminal:sess?.terminalPath,targets:sess?.targets?.map(t=>t.name)}));
const target=await req('GET',`/api/sessions/${sid}/target/web/`);
out('gateway serves lab target',target.status===200 && target.text.includes('Nimbus Freight'),`status=${target.status} bytes=${target.text.length}`);
const wrongTarget=await req('GET',`/api/sessions/${sid}/target/evil/`); out('unknown target name blocked',wrongTarget.status===404,`status=${wrongTarget.status}`);
const hint2=await req('POST',`/api/labs/http-header-hunt/objectives/evidence-report/hints/h2`,{sessionId:sid});
out('hint order enforced',hint2.status===409 || hint2.status===404,`status=${hint2.status}`);
const hint1=await req('POST',`/api/labs/http-header-hunt/objectives/evidence-report/hints/h1`,{sessionId:sid});
out('progressive hint reveal',hint1.status===200 && hint1.json.hint?.length>10, hint1.json?.hint?.slice(0,50));
const flagFail=await req('POST',`/api/sessions/${sid}/objectives/build-token/submit`,{flag:'CF{deadbeefdeadbeefdeadbeefdeadbeef}'});
out('wrong flag rejected',flagFail.status===422 && flagFail.json.passed===false,`status=${flagFail.status}`);
const checkFail=await req('POST',`/api/sessions/${sid}/objectives/harden-headers/check`,{});
out('unhardened header check fails',checkFail.status===422,`status=${checkFail.status} ${checkFail.json?.message?.slice(0,70)}`);
// websocket terminal
await new Promise((resolve)=>{
  const ws=new WebSocket(`ws://127.0.0.1:5000/ws/terminal/${sid}`,{headers:{cookie:jar(),origin:BASE}});
  let buf='', opened=false, settled=false;
  const done=(ok,msg)=>{if(settled)return;settled=true;out('terminal websocket',ok,msg);try{ws.close()}catch{};resolve()};
  ws.on('open',()=>{opened=true; setTimeout(()=>ws.send(JSON.stringify({type:'input',data:Buffer.from('echo HELLO_TERM\r').toString('base64')})),700)});
  ws.on('message',(m)=>{try{const j=JSON.parse(m.toString()); if(j.type==='output') buf+=Buffer.from(j.data,'base64').toString();}catch{} if(buf.includes('HELLO_TERM')) done(true,'real pty echoed input');});
  ws.on('error',(e)=>done(false,e.message));
  setTimeout(()=>done(false,`timeout opened=${opened} bytes=${buf.length}`),9000);
});
const stream=await fetch(BASE+`/api/sessions/${sid}/stream`,{headers:{cookie:jar()}});
const reader=stream.body.getReader(); const {value}=await reader.read(); const txt=new TextDecoder().decode(value);
out('SSE live status',stream.status===200 && txt.includes('event: open') && txt.includes(sid),txt.slice(0,30).replace(/\n/g,'|')); reader.cancel();
// Follow the learner path through the authenticated gateway to capture the real flag.
const labLogin=await fetch(`${BASE}/api/sessions/${sid}/target/web/login`,{method:'POST',redirect:'manual',headers:{cookie:jar(),'content-type':'application/x-www-form-urlencoded','x-csrf-token':csrf},body:'email=ops%40nimbusfreight.example&password=freight2024'});
const labCookie=(labLogin.headers.getSetCookie?.()??[]).map((c)=>c.split(';')[0]).join('; ');
out('gateway forwards form POST',labLogin.status===302 && labCookie.includes('nf_session'),`status=${labLogin.status} location=${labLogin.headers.get('location')}`);
const dash=await fetch(`${BASE}/api/sessions/${sid}/target/web/dashboard`,{headers:{cookie:`${jar()}; ${labCookie}`}});
const realFlag=dash.headers.get('x-build-token');
out('authenticated target leaks build token',dash.status===200 && /^CF\{/.test(realFlag??''),`flagShape=${realFlag?.slice(0,4)}...`);
const wl=await req('POST','/api/labs/http-header-hunt/walkthrough/0',{sessionId:sid});
out('walkthrough step 0',wl.status===200 && wl.json.step?.title?.length>0, wl.json?.step?.title);
const wlSkip=await req('POST','/api/labs/http-header-hunt/walkthrough/2',{sessionId:sid});
out('walkthrough order enforced',wlSkip.status===409,`status=${wlSkip.status}`);
const flag=await req('POST',`/api/sessions/${sid}/objectives/build-token/submit`,{flag:realFlag});
out('valid flag accepted',flag.status===200 && flag.json.passed===true,`xp=${flag.json?.totalXp} awarded=${flag.json?.xpAwarded}`);
const flagAgain=await req('POST',`/api/sessions/${sid}/objectives/build-token/submit`,{flag:realFlag});
out('repeat flag not double-awarded',flagAgain.status===200 && flagAgain.json.xpAwarded===0 && flagAgain.json.alreadyCompleted===true,`awarded=${flagAgain.json?.xpAwarded}`);
const chk=await req('POST',`/api/sessions/${sid}/objectives/harden-headers/check`,{});
out('live validator re-checks target',[200,422].includes(chk.status),`status=${chk.status} passed=${chk.json?.passed} ${chk.json?.message?.slice(0,90)}`);
const second=await fetch(BASE+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:`iso${Date.now()}@example.test`,username:`iso${Date.now()%100000}`,password:'Isolation!2024'})});
const sc=second.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
const snoop=await fetch(BASE+`/api/sessions/${sid}`,{headers:{cookie:sc}});
out('cross-user session blocked',snoop.status===403,`status=${snoop.status}`);
const snoopTerm=await new Promise((resolve)=>{const ws=new WebSocket(`ws://127.0.0.1:5000/ws/terminal/${sid}`,{headers:{cookie:sc,origin:BASE}});ws.on('open',()=>{resolve('opened');ws.close()});ws.on('unexpected-response',(_r,res)=>resolve(`http ${res.statusCode}`));ws.on('error',(e)=>resolve('error '+e.message));setTimeout(()=>resolve('timeout'),4000);});
out('cross-user terminal blocked',String(snoopTerm).includes('403')||String(snoopTerm).includes('401'),String(snoopTerm));
const ext=await req('POST',`/api/sessions/${sid}/extend`,{minutes:10}); out('session extend',ext.status===200,ext.json?.session?.expiresAt ?? JSON.stringify(ext.json));
const stop=await req('POST',`/api/sessions/${sid}/stop`,{}); out('stop session',stop.json?.session?.state==='stopped',stop.json?.session?.state);
const summary=await req('GET','/api/me/summary');
out('progress summary',summary.status===200 && !!summary.json.rank?.name, `xp=${summary.json?.xp} rank=${summary.json?.rank?.name} hints=${summary.json?.stats?.hintsUsed}`);
const paths=await req('GET','/api/paths'); out('learning paths',paths.json.paths?.length>=5,`n=${paths.json?.paths?.length}`);
const ach=await req('GET','/api/achievements'); out('achievements catalog',ach.json.achievements?.length>=10,`n=${ach.json?.achievements?.length}`);
const lb=await req('GET','/api/leaderboard'); out('leaderboard',lb.status===200 && Array.isArray(lb.json.leaderboard),`n=${lb.json?.leaderboard?.length}`);
const qa=await req('GET','/api/qa'); out('qa endpoint',qa.status===200 && 'latest' in qa.json, JSON.stringify(qa.json?.latest?.status??'none'));
console.log(`SUMMARY pass=${pass} fail=${fail}`);
