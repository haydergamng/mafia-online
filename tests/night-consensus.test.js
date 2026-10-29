'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {server} = require('../server');

test('المافيا تختار هدفًا مشتركًا، والمحقق والطبيب والمافيا يُنهون الليل فورًا دون انتظار القناص', async t => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function post(route, body) {
    const res=await fetch(`${base}/api/${route}`, {method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:res.status, data:await res.json()};
  }
  async function get(token) {
    return (await fetch(`${base}/api/state?token=${token}`)).json();
  }
  const created=await post('create',{name:'المنشئ'});
  const tokens=[created.data.token];
  const counts={mafia:2,doctor:1,detective:1,sniper:1,citizen:2};
  assert.equal((await post('settings',{token:tokens[0],counts,capacity:7})).status,200);
  for(const name of ['لاعب١','لاعب٢','لاعب٣','لاعب٤','لاعب٥','لاعب٦']) {
    const r=await post('join',{name,code:created.data.code});
    assert.equal(r.status,200); tokens.push(r.data.token);
  }
  assert.equal((await post('start',{token:tokens[0]})).status,200);
  const views=await Promise.all(tokens.map(get));
  const actors=views.map((v,i)=>({token:tokens[i],id:v.me.id,role:v.me.role}));
  const mafia=actors.filter(a=>a.role==='mafia');
  const citizens=actors.filter(a=>a.role==='citizen');
  const doctor=actors.find(a=>a.role==='doctor');
  const detective=actors.find(a=>a.role==='detective');
  const sniper=actors.find(a=>a.role==='sniper');
  assert.equal(mafia.length,2);
  // First member locks the team's only target.
  assert.equal((await post('action',{token:mafia[0].token,targetId:citizens[0].id})).status,200);
  assert.equal((await get(mafia[1].token)).mafiaTarget,citizens[0].id);
  assert.equal((await get(doctor.token)).mafiaTarget,null,'do not expose mafia choice to other roles');
  assert.equal((await post('action',{token:mafia[1].token,targetId:citizens[1].id})).status,409,'reject split targets');
  assert.equal((await post('action',{token:mafia[0].token,targetId:citizens[1].id})).status,409,'reject changing a locked vote');
  assert.equal((await get(mafia[1].token)).me.nightTarget,null,'failed vote was not committed');
  assert.equal((await post('action',{token:mafia[1].token,targetId:citizens[0].id})).status,200);
  assert.equal((await get(mafia[1].token)).phase,'night','still wait for the doctor and detective');
  assert.equal((await post('action',{token:doctor.token,targetId:citizens[0].id})).status,200);
  assert.equal((await post('action',{token:detective.token,targetId:mafia[0].id})).status,200);
  assert.equal((await get(mafia[0].token)).phase,'day','day begins without waiting for sniper');
  assert.equal((await get(sniper.token)).me.sniperUsed,false,'sniper still has unused shot');
  assert.equal((await get(citizens[0].token)).me.alive,true,'doctor saved the target');
});

test('صفحة اللعبة تعرض اسم المنشئ والمساعد',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  for(const content of [html,app]) {
    assert.match(content,/حيدر المرهون/);
    assert.match(content,/عبدالله احجيرات/);
  }
});
