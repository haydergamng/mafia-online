'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {server}=require('../server');
const {rolesValid,totalRoles,assignRoles,mostVoted,winner}=require('../engine');

test('الحد الأعلى للأدوار يساوي عدد اللاعبين',()=>{
  assert.equal(rolesValid({mafia:3,doctor:2,detective:1,citizen:4},10),true);
  assert.equal(rolesValid({mafia:3,doctor:3,detective:1,citizen:4},10),false);
  assert.equal(totalRoles({mafia:3,doctor:2,detective:1,citizen:4}),10);
  assert.equal(rolesValid({mafia:100,doctor:0,detective:0,citizen:0},100),true);
});
test('توزيع الأدوار يشمل عدة أطباء ومحققين',()=>{
  const ids=Array.from({length:10},(_,i)=>`player${i}`);
  const assigned=[...assignRoles(ids,{mafia:3,doctor:2,detective:2,citizen:3}).values()];
  for(const [role,count] of Object.entries({mafia:3,doctor:2,detective:2,citizen:3})){
    assert.equal(assigned.filter(item=>item===role).length,count);
  }
});
test('التصويت والتعادل والفوز',()=>{
  assert.equal(mostVoted({a:'x',b:'y'},['x','y']),null);
  assert.equal(mostVoted({a:'x',b:'x',c:'y'},['x','y']),'x');
  assert.equal(winner([{role:'mafia',alive:false},{role:'citizen',alive:true}]),'citizens');
});
test('غرفة أونلاين: إنشاء وانضمام وأدوار وحدود وبداية الجولة',async t=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const host=`http://127.0.0.1:${server.address().port}`;
  async function post(route,body){
    const r=await fetch(host+'/api/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:r.status,data:await r.json()};
  }
  async function get(token){const r=await fetch(host+`/api/state?token=${token}`);return r.json();}
  const creator=await post('create',{name:'المدير'});
  assert.equal(creator.status,200);
  const {token,code}=creator.data;
  let r=await post('settings',{token,capacity:4,counts:{mafia:1,doctor:1,detective:1,citizen:1}});
  assert.equal(r.status,200);
  r=await post('settings',{token,counts:{mafia:2,doctor:1,detective:1,citizen:1}});
  assert.equal(r.status,400,'لازم يقفل الزيادة عندما يكتمل العدد');
  r=await post('settings',{token,counts:{mafia:1,doctor:2,detective:1,citizen:0}});
  assert.equal(r.status,200,'يقبل أكثر من طبيب');
  let tokens=[token];
  for(const name of ['بدر','سلمان','حسن']){
    const join=await post('join',{name,code});
    assert.equal(join.status,200);
    tokens.push(join.data.token);
  }
  r=await post('start',{token});assert.equal(r.status,200);
  const views=await Promise.all(tokens.map(get));
  assert.equal(views.filter(v=>v.me.role==='doctor').length,2);
  assert.equal(views.filter(v=>v.me.role==='mafia').length,1);
  assert.equal(views.filter(v=>v.me.role==='detective').length,1);
  for(const v of views){
    assert.equal(v.phase,'night');
    assert.equal(v.players.filter(p=>p.role!==null).length,0,'الأدوار لا تتسرب للأحياء');
    assert.equal(v.mafiaChat.length>0,v.me.role==='mafia','شات المافيا سري');
  }
  const target=views.find(v=>v.me.role==='detective').me.id;
  for(const v of views){
    if(v.me.role==='mafia')r=await post('action',{token:tokens[views.indexOf(v)],targetId:target});
    if(v.me.role==='doctor')r=await post('action',{token:tokens[views.indexOf(v)],targetId:target});
    if(v.me.role==='detective')r=await post('action',{token:tokens[views.indexOf(v)],targetId:views.find(vv=>vv.me.role==='mafia').me.id});
    assert.equal(r.status,200);
  }
  const day=await get(token);
  assert.equal(day.phase,'day','الطبيب أنقذ المستهدف');
  assert.equal(day.players.filter(p=>p.alive).length,4);
  r=await post('skip-day',{token});assert.equal(r.status,200);
  const mafia=views.find(v=>v.me.role==='mafia').me.id;
  for(let i=0;i<views.length;i++){
    r=await post('action',{token:tokens[i],targetId:views[i].me.id===mafia?'skip':mafia});
    assert.equal(r.status,200);
  }
  const ended=await get(token);
  assert.equal(ended.phase,'finished');
  assert.equal(ended.winner,'citizens');
});
