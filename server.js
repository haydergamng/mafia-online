'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TYPES, roleLabels, totalRoles, rolesValid, assignRoles, mostVoted, winner } = require('./engine');

const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map();
const sessions = new Map();
const maxBodyBytes = 8192;
const seconds = { night: 75, day: 120, voting: 70 };
const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const defaultRules = Object.freeze({textChat:true, voiceChat:false, revealRoles:true});
// Optional TURN relay. Without it the app still tries direct connections via free STUN.
// Configure TURN_URLS, TURN_USERNAME and TURN_CREDENTIAL together in Render if needed.
function voiceIceConfig() {
  const iceServers=[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}];
  const urls=(process.env.TURN_URLS||'').split(',').map(x=>x.trim()).filter(x=>/^turns?:/i.test(x));
  const username=process.env.TURN_USERNAME||'';
  const credential=process.env.TURN_CREDENTIAL||'';
  if(urls.length&&username&&credential)iceServers.push({urls,username,credential});
  return {iceServers,hasTurn:iceServers.length>1};
}

function randCode() {
  let code;
  do { code = Array.from({length:6},()=>charset[crypto.randomInt(charset.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function randomToken() { return crypto.randomBytes(24).toString('hex'); }
function randomId() { return crypto.randomUUID(); }
function safeName(s) {
  if (typeof s !== 'string') return null;
  const clean = s.replace(/[\u0000-\u001f\u007f<>]/g,'').trim().slice(0,20);
  return clean.length >= 2 ? clean : null;
}
function safeRoomName(value, fallback) {
  if(value === undefined || value === null || value === '') return fallback;
  if(typeof value !== 'string') fail(400,'اسم الغرفة غير صالح.');
  const clean=value.replace(/[\u0000-\u001f\u007f<>]/g,'').trim().slice(0,32);
  if(clean.length<2)fail(400,'اسم الغرفة يجب أن يكون حرفين على الأقل.');
  return clean;
}
function publicRooms() {
  return [...rooms.values()]
    .filter(room=>room.visibility==='public'&&room.phase==='lobby')
    .sort((a,b)=>b.createdAt-a.createdAt)
    .slice(0,80)
    .map(room=>({code:room.code,name:room.name,host:room.players.find(p=>p.id===room.hostId)?.name||'المضيف',
      players:room.players.length,capacity:room.capacity,full:room.players.length>=room.capacity}));
}
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body), 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
  res.end(body);
}
function fail(status, message) {const error = new Error(message); error.status = status; throw error;}
function roomFor(token) {
  const session = sessions.get(token);
  const room = session && rooms.get(session.code);
  const player = room?.players.find(p=>p.id===session?.id);
  if (!room || !player) fail(401,'انتهت جلستك. ادخل الغرفة مرة ثانية.');
  return {room,player};
}
function makePlayer(name) {
  return { id:randomId(), name, role:null, alive:true, investigate:null, sniperUsed:false, voiceJoined:false, blocked:[], joinedAt:Date.now() };
}
function chat(room, channel, sender, text) {
  const messages = channel === 'mafia' ? room.mafiaChat : room.publicChat;
  messages.push({id:randomId(), senderId:sender?.id??null, sender:sender?.name??'النظام', text, system:!sender, at:Date.now()});
  if (messages.length>150) messages.splice(0,messages.length-150);
}
function announce(room, text) {room.announcement=text;chat(room,'public',null,text);}
function eliminationText(room, p) {
  return `${p.name}${room.rules.revealRoles ? ` (${roleLabels[p.role]})` : ''}`;
}
function voiceChannel(room, player) {
  if (!room.rules.voiceChat) return null;
  if (room.phase==='day'||room.phase==='voting') return 'day';
  if (room.phase==='night'&&(!player.alive||player.role==='mafia')) return 'mafia-night';
  return null;
}
function voiceCanSpeak(room, player) {
  return player.alive && (room.phase==='day'||room.phase==='voting'||(room.phase==='night'&&player.role==='mafia'));
}
function voicePeers(room, player) {
  const mode=voiceChannel(room,player);
  if(!mode)return [];
  return room.players.filter(p=>p.id!==player.id&&p.voiceJoined&&voiceChannel(room,p)===mode)
    .map(p=>({id:p.id,name:p.name,speaker:voiceCanSpeak(room,p)}));
}
function emitSignal(room, recipient, sender, signal) {
  const data={from:sender.id,signal};
  for(const res of room.listeners.get(recipient.id)||[]) {
    if(!res.writableEnded&&!res.destroyed)res.write(`event: signal\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
function clearClock(room) {if(room.clock) clearTimeout(room.clock); room.clock=null;}
function setClock(room,phase,callback) {
  clearClock(room);
  room.phase=phase;
  room.until=Date.now()+seconds[phase]*1000;
  room.clock=setTimeout(callback,seconds[phase]*1000);
  room.clock.unref?.();
  broadcast(room);
}
function finish(room, side) {
  clearClock(room);
  room.phase='finished';room.until=null;room.winner=side;
  announce(room,side==='mafia'?'🏴 انتهت الجولة! المافيا فازت.':'🏆 انتهت الجولة! فاز المواطنون.');
  broadcast(room);
}
function checkWinner(room) {
  const side=winner(room.players);
  if(side){finish(room,side);return true;}
  return false;
}
function beginNight(room) {
  room.round++;
  room.nightActions={};
  for(const player of room.players) player.investigate=null;
  chat(room,'mafia',null,`🌙 الليلة ${room.round}: اختاروا هدفكم بسرية.`);
  announce(room,`🌙 بدأت الليلة ${room.round}. ينتظر الجميع حتى الصباح.`);
  setClock(room,'night',()=>resolveNight(room));
}
function resolveNight(room) {
  if(room.phase!=='night')return;
  clearClock(room);
  const mafiaVotes={};
  for(const p of room.players.filter(p=>p.alive&&p.role==='mafia')) {
    if(room.nightActions[p.id]) mafiaVotes[p.id]=room.nightActions[p.id];
  }
  const eligible=room.players.filter(p=>p.alive&&p.role!=='mafia').map(p=>p.id);
  const mafiaTargetId=mostVoted(mafiaVotes,eligible,'random');
  const saved=new Set(room.players.filter(p=>p.alive&&p.role==='doctor').map(p=>room.nightActions[p.id]).filter(Boolean));
  // جميع قرارات الليل تحدث معًا: حماية الطبيب تمنع استبعاد المافيا والقنّاص.
  // الرصاصة تُستهلك عند اختيار هدفها، حتى لو كانت هناك حماية.
  const hitIds=new Set();
  if(mafiaTargetId)hitIds.add(mafiaTargetId);
  for(const shooter of room.players.filter(p=>p.alive&&p.role==='sniper')){
    const shot=room.nightActions[shooter.id];
    if(shooter.sniperUsed && shot && shot!=='skip')hitIds.add(shot);
  }
  const removed=[];
  for(const id of hitIds){
    const p=room.players.find(p=>p.id===id&&p.alive);
    if(p&&!saved.has(id)){p.alive=false;removed.push(p);}
  }
  if(removed.length){
    announce(room,`☀️ حل الصباح، خرج من الجولة: ${removed.map(p=>eliminationText(room,p)).join('، ')}.`);
  } else announce(room,'☀️ حل الصباح، ولم يخرج أحد هذه الليلة.');
  if(checkWinner(room))return;
  setClock(room,'day',()=>beginVoting(room));
}
function beginVoting(room) {
  if(room.phase!=='day')return;
  room.dayVotes={};
  announce(room,'🗳️ انتهى النقاش، بدأ التصويت. اختر مشتبهًا به أو تخطَّ.');
  setClock(room,'voting',()=>resolveVoting(room));
}
function resolveVoting(room) {
  if(room.phase!=='voting')return;
  clearClock(room);
  const alive=room.players.filter(p=>p.alive).map(p=>p.id);
  const voted=mostVoted(room.dayVotes,alive);
  const removed=room.players.find(p=>p.id===voted);
  if(removed){removed.alive=false;announce(room,`📣 نتيجة التصويت: خرج ${eliminationText(room,removed)}.`);}
  else announce(room,'📣 انتهى التصويت بتعادل أو بدون أصوات كافية؛ لم يخرج أحد.');
  if(checkWinner(room))return;
  beginNight(room);
}
function view(room, player) {
  const good = player.role === 'mafia';
  return {
    code:room.code,roomName:room.name,visibility:room.visibility,hostId:room.hostId,phase:room.phase,round:room.round,
    until:room.until, now:Date.now(), winner:room.winner,announcement:room.announcement,
    capacity:room.capacity,counts:{...room.counts},countTotal:totalRoles(room.counts),rules:{...room.rules},
    voice:{channel:voiceChannel(room,player),canSpeak:voiceCanSpeak(room,player),joined:!!player.voiceJoined,peers:voicePeers(room,player)},
    me:{id:player.id, name:player.name,role:player.role,alive:player.alive,
      investigation:player.investigate, sniperUsed:player.role==='sniper'?player.sniperUsed:null,
      nightTarget:room.nightActions[player.id]||null, vote:room.dayVotes[player.id]||null},
    players:room.players.map(p=>({id:p.id,name:p.name,alive:p.alive,
      role:room.phase==='finished'||
        (room.rules.revealRoles&&!p.alive&&room.phase!=='lobby')||
        (!player.alive&&room.phase==='night'&&p.role==='mafia')?p.role:null,
      teammate:good && p.role==='mafia',host:p.id===room.hostId})),
    publicChat:room.publicChat.filter(msg=>!player.blocked.includes(msg.senderId)),
    mafiaChat:good?room.mafiaChat.filter(msg=>!player.blocked.includes(msg.senderId)):[]
  };
}
function emit(res, data) {
  if(res.writableEnded||res.destroyed)return;
  res.write(`event: state\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(room) {
  room.lastActivity=Date.now();
  for(const [id, recipients] of room.listeners) {
    const player=room.players.find(p=>p.id===id);
    if(!player)continue;
    for(const response of recipients) emit(response,view(room,player));
  }
}
function dropPlayer(room,p) {
  const i=room.players.findIndex(x=>x.id===p.id);
  if(i===-1)return;
  if(room.phase==='lobby'||room.phase==='finished'){
    room.players.splice(i,1);
    for(const [token,s] of sessions)if(s.code===room.code&&s.id===p.id)sessions.delete(token);
    const stream=room.listeners.get(p.id);
    if(stream)for(const res of stream){res.end();}
    room.listeners.delete(p.id);
  } else {
    p.alive=false;
    p.voiceJoined=false;
    announce(room,`غادر ${p.name} الغرفة.`);
  }
  if(room.hostId===p.id)room.hostId=room.players.find(x=>x.id!==p.id&&x.alive)?.id||room.players.find(x=>x.id!==p.id)?.id||null;
  if(room.players.length===0){clearClock(room);rooms.delete(room.code);return;}
  if(['night','day','voting'].includes(room.phase)&&checkWinner(room))return;
  broadcast(room);
}
async function readBody(req) {
  let length=0, chunks=[];
  for await(const chunk of req){length+=chunk.length;if(length>maxBodyBytes)fail(413,'حجم الطلب كبير جدًا.');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
  catch{fail(400,'بيانات الطلب غير صالحة.');}
}
function tokenFrom(req, body, url) {
  return (typeof body?.token==='string'?body.token:url.searchParams.get('token'))||'';
}
function requireHost(room,p) {if(room.hostId!==p.id)fail(403,'هذا الإعداد لصاحب الغرفة فقط.');}
function action(pathname,body) {
  if(pathname==='/api/create'){
    const name=safeName(body.name);if(!name)fail(400,'اكتب اسمًا من حرفين إلى 20 حرفًا.');
    const visibility=body.visibility==='public'?'public':'private';
    if(body.visibility!==undefined&&!['public','private'].includes(body.visibility))fail(400,'نوع الغرفة غير صالح.');
    const player=makePlayer(name),code=randCode(),token=randomToken();
    const room={code,name:safeRoomName(body.roomName,`غرفة ${name}`),visibility,createdAt:Date.now(),hostId:player.id,phase:'lobby',round:0,capacity:6,
      counts:{mafia:1,doctor:1,detective:1,sniper:0,citizen:0},rules:{...defaultRules},players:[player],
      nightActions:{},dayVotes:{},publicChat:[],mafiaChat:[],
      listeners:new Map(),announcement:'الغرفة جاهزة لاستقبال اللاعبين.',
      winner:null,until:null,clock:null,lastActivity:Date.now()};
    rooms.set(code,room);sessions.set(token,{code,id:player.id});
    return {token,code};
  }
  if(pathname==='/api/join'){
    const name=safeName(body.name),code=String(body.code||'').toUpperCase().trim();
    if(!name)fail(400,'اكتب اسمًا من حرفين إلى 20 حرفًا.');
    const room=rooms.get(code);if(!room)fail(404,'رمز الغرفة غير موجود.');
    if(room.phase!=='lobby')fail(409,'اللعبة بدأت، انتظر الجولة القادمة.');
    if(room.players.length>=room.capacity)fail(409,'الغرفة ممتلئة.');
    if(room.players.some(p=>p.name.toLowerCase()===name.toLowerCase()))fail(409,'الاسم مستخدم في هذه الغرفة.');
    const player=makePlayer(name),token=randomToken();
    room.players.push(player);sessions.set(token,{code,id:player.id});broadcast(room);
    return {token,code};
  }
  const {room,player}=roomFor(body.token);
  if(pathname==='/api/settings'){
    requireHost(room,player);
    const isLobby=room.phase==='lobby';
    if(!isLobby && ['capacity','counts','visibility','roomName','revealRoles'].some(k=>body[k]!==undefined))
      fail(409,'تعديل نوع الغرفة والأدوار وكشف الأدوار متاح قبل بدء الجولة فقط.');
    const rules={...room.rules};
    for(const name of Object.keys(defaultRules)) {
      if(body[name]!==undefined) {
        if(typeof body[name]!=='boolean')fail(400,'قيمة الإعداد يجب أن تكون تشغيلًا أو إيقافًا.');
        rules[name]=body[name];
      }
    }
    if(isLobby){
      const capacity=body.capacity===undefined?room.capacity:Number(body.capacity);
      const counts=body.counts===undefined?room.counts:body.counts;
      if(!rolesValid(counts,capacity))fail(400,'مجموع الأدوار لا يمكن أن يتجاوز عدد اللاعبين المحدد.');
      if(capacity<room.players.length)fail(400,'عدد المقاعد لا يمكن أن يقل عن الموجودين في الغرفة.');
      if(body.visibility!==undefined&&!['public','private'].includes(body.visibility))fail(400,'نوع الغرفة غير صالح.');
      room.capacity=capacity;room.counts={...counts};room.visibility=body.visibility??room.visibility;
      room.name=safeRoomName(body.roomName,room.name);
    }
    room.rules=rules;
    if(!rules.voiceChat)room.players.forEach(p=>{p.voiceJoined=false;});
    broadcast(room);return {rules:{...rules},capacity:room.capacity,counts:room.counts,visibility:room.visibility,roomName:room.name};
  }
  if(pathname==='/api/start'){
    requireHost(room,player);
    if(room.phase!=='lobby')fail(409,'الجولة بدأت بالفعل.');
    if(room.players.length!==room.capacity)fail(400,'انتظر حتى يكتمل عدد اللاعبين المحدد.');
    const assigned=assignRoles(room.players.map(p=>p.id),room.counts);
    for(const p of room.players){p.role=assigned.get(p.id);p.alive=true;p.investigate=null;p.sniperUsed=false;}
    room.round=0;room.publicChat=[];room.mafiaChat=[];room.winner=null;
    beginNight(room);return {started:true};
  }
  if(pathname==='/api/action'){
    if(!player.alive)fail(403,'اللاعب المستبعد لا يمكنه اختيار هدف.');
    const target=room.players.find(p=>p.id===body.targetId&&p.alive);
    if(room.phase==='night'){
      if(!['mafia','doctor','detective','sniper'].includes(player.role))fail(403,'ليس لديك قرار ليلي.');
      if(player.role==='sniper'){
        if(player.sniperUsed)fail(409,'استخدمت طلقتك الوحيدة بالفعل؛ لا ترجع هذه الجولة.');
        // يتاح تخطي هذه الليلة دون خسارة الرصاصة.
        if(body.targetId==='skip')room.nightActions[player.id]='skip';
        else {
          if(!target||target.id===player.id)fail(400,'القنّاص يختار لاعبًا غير نفسه.');
          room.nightActions[player.id]=target.id;
          player.sniperUsed=true; // البطاقة تنتهي بمجرد إطلاقها ولا يمكن إلغاء الاختيار
        }
      } else {
        if(!target)fail(400,'اختر لاعبًا موجودًا.');
        if(player.role==='mafia'&&target.role==='mafia')fail(400,'المافيا تختار شخصًا من خارج فريقها.');
        if(player.role==='detective'&&target.id===player.id)fail(400,'لا يمكن للمحقق التحقيق في نفسه.');
        room.nightActions[player.id]=target.id;
        if(player.role==='detective')player.investigate={name:target.name,isMafia:target.role==='mafia',round:room.round};
      }
      broadcast(room);
      // القنّاص الذي لا يزال يحتفظ بالرصاصة يمكنه إطلاقها أو تخطي الليلة؛
      // بعد إطلاقها لا ننتظر منه اختيارًا في الليالي التالية.
      const specials=room.players.filter(p=>p.alive&&(
        ['mafia','doctor','detective'].includes(p.role) ||
        (p.role==='sniper' && !p.sniperUsed)
      ));
      if(specials.every(p=>room.nightActions[p.id]))resolveNight(room);
      return {submitted:true};
    }
    if(room.phase==='voting'){
      if(body.targetId!=='skip'&&(!target||target.id===player.id))fail(400,'اختر لاعبًا غير نفسك أو تخطَّ.');
      room.dayVotes[player.id]=body.targetId;
      broadcast(room);
      if(room.players.filter(p=>p.alive).every(p=>room.dayVotes[p.id]))resolveVoting(room);
      return {submitted:true};
    }
    fail(400,'هذا القرار غير متاح في المرحلة الحالية.');
  }
  if(pathname==='/api/chat'){
    if(!room.rules.textChat)fail(403,'الشات الكتابي مقفّل من إعدادات الغرفة.');
    if(!player.alive)fail(403,'يمكن للمستبعد متابعة اللعبة لكن ليس الكتابة.');
    const channel=body.channel==='mafia'?'mafia':'public';
    if(channel==='public'&&!['day','voting'].includes(room.phase))fail(403,'الشات العام يفتح في النهار والتصويت.');
    if(channel==='mafia'&&!(room.phase==='night'&&player.role==='mafia'))fail(403,'شات المافيا خاص بالمافيا ليلًا.');
    const msg=typeof body.text==='string'?body.text.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,280):'';
    if(!msg)fail(400,'اكتب رسالة أولاً.');
    if(Date.now()-(player.lastChatAt||0)<850)fail(429,'انتظر لحظة قبل إرسال رسالة ثانية.');
    player.lastChatAt=Date.now();chat(room,channel,player,msg);broadcast(room);return {sent:true};
  }
  if(pathname==='/api/voice-presence'){
    if(typeof body.joined!=='boolean')fail(400,'حدد تشغيل أو إيقاف الاستماع الصوتي.');
    if(body.joined && !room.rules.voiceChat)fail(403,'الشات الصوتي مقفّل من إعدادات الغرفة.');
    if(body.joined && room.phase==='lobby')fail(409,'الصوت يبدأ بعد انطلاق الجولة.');
    player.voiceJoined=body.joined;
    broadcast(room);return {joined:player.voiceJoined};
  }
  if(pathname==='/api/voice-signal'){
    if(!room.rules.voiceChat||!player.voiceJoined||!voiceChannel(room,player))fail(403,'الاتصال الصوتي غير مسموح حاليًا.');
    const target=room.players.find(p=>p.id===body.targetId);
    if(!target||target.id===player.id||!target.voiceJoined||voiceChannel(room,target)!==voiceChannel(room,player))
      fail(403,'هذا اللاعب ليس في القناة الصوتية نفسها.');
    const signal=body.signal;
    if(!signal||typeof signal!=='object'||!['offer','answer','candidate'].includes(signal.type))fail(400,'رسالة صوتية غير صالحة.');
    if(signal.type==='candidate'){
      if(!signal.candidate||typeof signal.candidate.candidate!=='string'||signal.candidate.candidate.length>3000)fail(400,'بيانات الاتصال غير صالحة.');
    }else if(typeof signal.sdp!=='string'||signal.sdp.length>6500)fail(400,'بيانات الصوت غير صالحة.');
    emitSignal(room,target,player,signal);
    return {sent:true};
  }
  if(pathname==='/api/skip-day'){
    requireHost(room,player);if(room.phase!=='day')fail(409,'نقاش النهار غير نشط.');
    beginVoting(room);return {ok:true};
  }
  if(pathname==='/api/restart'){
    requireHost(room,player);if(room.phase!=='finished')fail(409,'لا يمكن إعادة اللعب قبل نهاية الجولة.');
    room.players.forEach(p=>{p.voiceJoined=false;});
    room.phase='lobby';room.round=0;room.until=null;room.winner=null;room.dayVotes={};room.nightActions={};room.publicChat=[];room.mafiaChat=[];
    room.players.forEach(p=>{p.role=null;p.alive=true;p.investigate=null;p.sniperUsed=false;});
    announce(room,'🎲 الغرفة جاهزة لجولة جديدة.');broadcast(room);return {restarted:true};
  }
  if(pathname==='/api/kick'){
    requireHost(room,player);const target=room.players.find(p=>p.id===body.playerId);
    if(!target||target.id===player.id)fail(400,'تعذر إخراج اللاعب.');
    dropPlayer(room,target);return {removed:true};
  }
  if(pathname==='/api/leave'){
    dropPlayer(room,player);return {left:true};
  }
  if(pathname==='/api/report'){
    const item=[...room.publicChat,...room.mafiaChat].find(m=>m.id===body.messageId);
    if(!item||item.system||item.senderId===player.id)fail(400,'لا يمكن الإبلاغ عن هذه الرسالة.');
    // البلاغات محلية ومؤقتة؛ يلزم نظام إشراف ومراجعة حقيقي قبل الإطلاق العام.
    if(!room.reports)room.reports=[];
    if(!room.reports.some(r=>r.messageId===item.id&&r.reporterId===player.id))room.reports.push({messageId:item.id,reporterId:player.id,at:Date.now()});
    return {reported:true};
  }
  if(pathname==='/api/block'){
    const target=room.players.find(p=>p.id===body.playerId);
    if(!target||target.id===player.id)fail(400,'لا يمكن حظر هذا اللاعب.');
    if(!player.blocked.includes(target.id))player.blocked.push(target.id);
    broadcast(room);return {blocked:true};
  }
  fail(404,'العنوان غير موجود.');
}
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/health')return sendJson(res,200,{ok:true});
    if(req.method==='GET'&&url.pathname==='/api/rooms')return sendJson(res,200,{rooms:publicRooms()});
    if(req.method==='GET'&&url.pathname==='/api/voice-config') {
      // Only an authenticated room participant receives temporary voice configuration.
      const {room}=roomFor(url.searchParams.get('token'));
      if(!room.rules.voiceChat)fail(403,'الشات الصوتي مقفّل.');
      return sendJson(res,200,{ok:true,...voiceIceConfig()});
    }
    if(req.method==='GET'&&url.pathname==='/api/state'){
      const {room,player}=roomFor(url.searchParams.get('token'));
      return sendJson(res,200,view(room,player));
    }
    if(req.method==='GET'&&url.pathname==='/api/events'){
      const {room,player}=roomFor(url.searchParams.get('token'));
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
      res.write(': connected\n\n');
      if(!room.listeners.has(player.id))room.listeners.set(player.id,new Set());
      room.listeners.get(player.id).add(res);
      emit(res,view(room,player));
      const pulse=setInterval(()=>{if(!res.writableEnded)res.write(': pulse\n\n');},25_000);
      req.on('close',()=>{clearInterval(pulse);room.listeners.get(player.id)?.delete(res);});
      return;
    }
    if(req.method==='POST'&&url.pathname.startsWith('/api/')){
      // Same-origin guard for browser-based clients.
      const origin=req.headers.origin;
      if(origin&&new URL(origin).host!==req.headers.host)fail(403,'الطلب من مصدر غير مسموح.');
      const body=await readBody(req);
      const data=action(url.pathname,body);
      return sendJson(res,200,{ok:true,...data});
    }
    if(req.method!=='GET')fail(405,'الطريقة غير مدعومة.');
    const filename=url.pathname==='/'?'index.html':url.pathname.slice(1);
    const full=path.resolve(PUBLIC,filename);
    if(!full.startsWith(PUBLIC+path.sep)&&full!==path.join(PUBLIC,'index.html'))fail(404,'الملف غير موجود.');
    const ext=path.extname(full);
    if(!mime[ext])fail(404,'الملف غير موجود.');
    const stream=fs.createReadStream(full);
    stream.on('error',()=>{if(!res.headersSent)sendJson(res,404,{error:'الملف غير موجود.'});else res.end();});
    res.setHeader('Content-Type',mime[ext]);res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    stream.pipe(res);
  } catch(err) {
    if(!res.headersSent)sendJson(res,err.status||500,{ok:false,error:err.status?err.message:'حدث خطأ بالخادم.'});
    else res.end();
    if(!err.status)console.error(err);
  }
});
const garbage=setInterval(()=>{
  const expired=Date.now()-2*60*60*1000;
  for(const [code,room] of rooms){
    if(room.lastActivity<expired&&![...room.listeners.values()].some(s=>s.size)){
      clearClock(room);rooms.delete(code);
      for(const [token,s] of sessions)if(s.code===code)sessions.delete(token);
    }
  }
},5*60_000);
garbage.unref();
if(require.main===module) {
  const port=Number(process.env.PORT)||3000;
  server.listen(port,'0.0.0.0',()=>console.log(`MAFIA Online: http://localhost:${server.address().port}`));
}
module.exports={server,rooms,sessions};
