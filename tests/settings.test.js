'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {server}=require('../server');

test('إعدادات المضيف: كشف دور المستبعد، كتم الشات، الصوت حسب المراحل والاستماع للمستبعد', async t=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const host=`http://127.0.0.1:${server.address().port}`;
  async function post(route,body){
    const r=await fetch(`${host}/api/${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:r.status,data:await r.json()};
  }
  const get=async token=>(await fetch(`${host}/api/state?token=${token}`)).json();
  const create=await post('create',{name:'المضيف',visibility:'public'});
  assert.equal(create.status,200);
  const tokens=[create.data.token];
  const code=create.data.code;
  assert.deepEqual((await get(tokens[0])).rules,{textChat:true,voiceChat:false,revealRoles:true});
  assert.equal((await post('settings',{token:tokens[0],voiceChat:true,textChat:false,revealRoles:false,
    capacity:4,counts:{mafia:1,doctor:1,detective:1,sniper:0,citizen:1}})).status,200);
  for(const name of ['لاعب٢','لاعب٣','لاعب٤']){
    const joined=await post('join',{name,code});assert.equal(joined.status,200);tokens.push(joined.data.token);
  }
  assert.equal((await post('settings',{token:tokens[1],textChat:true})).status,403,'الضيف لا يغير الإعدادات');
  assert.equal((await post('start',{token:tokens[0]})).status,200);
  let views=await Promise.all(tokens.map(get));
  assert.equal(views[0].rules.textChat,false);
  assert.equal((await post('chat',{token:tokens[0],channel:'mafia',text:'مرحبا'})).status,403,'الشات الكتابي مقفّل من الخادم');
  assert.equal((await post('settings',{token:tokens[0],revealRoles:true})).status,409,'منع تغيير كشف الأدوار أثناء الجولة');
  assert.equal((await post('settings',{token:tokens[0],visibility:'private'})).status,409,'منع تغيير الخصوصية أثناء الجولة');
  assert.equal((await post('settings',{token:tokens[0],voiceChat:false})).status,200,'يمكن إيقاف الصوت أثناء الجولة');
  assert.equal((await post('voice-presence',{token:tokens[0],joined:true})).status,403,'لا ينضم لصوت مغلق');
  assert.equal((await post('settings',{token:tokens[0],voiceChat:true})).status,200);
  views=await Promise.all(tokens.map(get));
  const roles=Object.fromEntries(views.map((v,i)=>[v.me.role,{token:tokens[i],id:v.me.id}]));
  const doomed=roles.citizen.id;
  assert.equal((await post('action',{token:roles.mafia.token,targetId:doomed})).status,200);
  assert.equal((await post('action',{token:roles.doctor.token,targetId:roles.doctor.id})).status,200);
  assert.equal((await post('action',{token:roles.detective.token,targetId:roles.mafia.id})).status,200);
  const dead=await get(roles.citizen.token);
  assert.equal(dead.phase,'day');
  assert.equal(dead.me.alive,false);
  assert.equal(dead.voice.channel,'day','المستبعد يسمع النهار');
  assert.equal(dead.voice.canSpeak,false,'المستبعد لا يقدر يتكلم');
  assert.equal(dead.players.find(p=>p.id===roles.mafia.id).role,null,'المافيا لا ينكشف بالنهار للمستبعد');
  assert.equal(dead.players.find(p=>p.id===roles.citizen.id).role,null,'دور المستبعد مخفي عند تعطيل كشف الأدوار');
  assert.ok(!dead.announcement.includes('مواطن'),'الإعلان لا يكشف الدور');
  assert.equal((await post('voice-presence',{token:roles.citizen.token,joined:true})).status,200,'المستبعد يقدر يستمع');
  assert.equal((await post('voice-presence',{token:roles.mafia.token,joined:true})).status,200);
  assert.equal((await get(roles.citizen.token)).voice.peers.some(p=>p.id===roles.mafia.id),true);
  assert.equal((await post('settings',{token:tokens[0],textChat:true})).status,200,'المضيف يعيد فتح الشات');
  assert.equal((await post('chat',{token:roles.mafia.token,channel:'public',text:'مرحبا'})).status,200);
  assert.equal((await post('skip-day',{token:tokens[0]})).status,200);
  for(const tk of tokens){
    const v=await get(tk);if(v.me.alive)assert.equal((await post('action',{token:tk,targetId:'skip'})).status,200);
  }
  const after=await get(roles.citizen.token);
  assert.equal(after.phase,'night');
  assert.equal(after.voice.channel,'mafia-night','المستبعد يسمع المافيا ليلًا');
  assert.equal(after.voice.canSpeak,false);
  assert.equal(after.players.find(p=>p.id===roles.mafia.id).role,'mafia','المستبعد يعرف من المافيا في الليل');
  assert.equal((await get(roles.doctor.token)).voice.channel,null,'غير المافيا الأحياء لا يسمعون في الليل');
  assert.equal((await post('voice-presence',{token:roles.doctor.token,joined:true})).status,200);
  const illegal=await post('voice-signal',{token:roles.doctor.token,targetId:roles.mafia.id,signal:{type:'candidate',candidate:{candidate:'x'}}});
  assert.equal(illegal.status,403,'لا يمكن الاتصال مع قناة المافيا من لاعب حي بريء');
  assert.equal((await get(roles.mafia.token)).voice.peers.some(p=>p.id===roles.citizen.id),true,'المافيا يرى المستبعد ضمن المستمعين');
  assert.equal((await post('voice-signal',{token:roles.citizen.token,targetId:roles.mafia.id,signal:{type:'candidate',candidate:{candidate:'x'}}})).status,200,'المستبعد يستطيع استقبال إشارة الصوت');
  assert.equal((await post('settings',{token:tokens[0],voiceChat:false})).status,200);
  assert.equal((await get(roles.mafia.token)).voice.channel,null);
  assert.equal((await post('voice-signal',{token:roles.citizen.token,targetId:roles.mafia.id,signal:{type:'candidate',candidate:{candidate:'x'}}})).status,403);
});
