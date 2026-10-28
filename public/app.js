'use strict';
const roles = {
  mafia:{label:'مافيا',emoji:'🕶️',description:'اختر أنت وفريق المافيا شخصًا في الليل. تحدثوا في الشات السري.'},
  doctor:{label:'طبيب',emoji:'🩺',description:'احمِ لاعبًا كل ليلة. إذا استهدفته المافيا فلن يخرج.'},
  detective:{label:'محقق',emoji:'🔎',description:'افحص لاعبًا كل ليلة لتعرف سرًا إذا كان من المافيا.'},
  sniper:{label:'القنّاص',emoji:'🎯',description:'عندك طلقة واحدة طوال اللعبة. اختر وقت استخدامها ليلًا؛ الطبيب قد يحمي الهدف لكن الطلقة تستهلك.'},
  citizen:{label:'مواطن',emoji:'👤',description:'ناقش الآخرين في النهار وحاول كشف المافيا في التصويت.'}
};
let token=localStorage.getItem('mafia_token')||'';
let state=null;
let stream=null;
let channel='public';
let draft='';
let toastTimeout=null;
let roomsRequestId=0;
let settingsExpanded=true;
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clientTime=stamp=>new Date(stamp).toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit'});
function toast(text){const e=$('toast');e.textContent=text;e.classList.add('show');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>e.classList.remove('show'),3500);}
async function call(path,data={}){
  const response=await fetch(`/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,...data})});
  let dataOut={};try{dataOut=await response.json();}catch{}
  if(!response.ok||!dataOut.ok)throw Error(dataOut.error||'تعذر الاتصال.');
  return dataOut;
}
function reset(){window.VoiceChat?.reset();if(stream){stream.close();stream=null;}state=null;token='';localStorage.removeItem('mafia_token');$('game').hidden=true;$('welcome').hidden=false;refreshPublicRooms();}
function connect(){
  if(stream)stream.close();
  stream=new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  window.VoiceChat?.bind(stream);
  stream.addEventListener('state',e=>{
    try{state=JSON.parse(e.data);$('welcome').hidden=true;$('game').hidden=false;window.VoiceChat?.sync(state);render();}
    catch(err){console.error(err);}
  });
  stream.addEventListener('error',()=>{if(state)toast('الاتصال ضعيف... نحاول الرجوع تلقائيًا.');});
  fetch(`/api/state?token=${encodeURIComponent(token)}`).then(r=>{
    if(r.status===401){reset();toast('انتهت الجلسة، ادخل الغرفة مرة ثانية.');}
  }).catch(()=>{});
}
async function refreshPublicRooms(){
  if(!$('welcome')||$('welcome').hidden)return;
  const list=$('public-rooms-list');
  const requestId=++roomsRequestId;
  try{
    const response=await fetch('/api/rooms',{cache:'no-store'});
    if(!response.ok)throw Error('تعذر تحميل الغرف العامة.');
    const data=await response.json();
    if(requestId!==roomsRequestId||$('welcome').hidden)return;
    if(!Array.isArray(data.rooms)||data.rooms.length===0){
      list.innerHTML='<p class="empty-text">ما فيه غرف عامة تنتظر لاعبين حاليًا. تقدر تنشئ أول غرفة عامة! 🌍</p>';
      return;
    }
    list.innerHTML=data.rooms.map(room=>`<article class="public-room-item">
      <div class="public-room-meta"><strong>🎭 ${esc(room.name)}</strong><small>👑 ${esc(room.host)} · 👥 ${Number(room.players)} / ${Number(room.capacity)} لاعبين</small></div>
      <button class="secondary" data-public-code="${esc(room.code)}" ${room.full?'disabled':''}>${room.full?'ممتلئة':'انضم الآن ←'}</button>
    </article>`).join('');
  }catch(err){
    if(requestId===roomsRequestId&&!$('welcome').hidden)list.innerHTML=`<p class="empty-text">${esc(err.message)} <button class="subtle" id="retry-rooms">أعد المحاولة</button></p>`;
  }
}
function capLabel(){const available=state.capacity-state.countTotal;return `${state.countTotal} / ${state.capacity} دور • ${available===0?'اكتمل توزيع الأدوار':`متبقي ${available}`}`;}
function roomHeader(){return `<div class="room-head"><div><div class="overline">${state.visibility==='public'?'🌍 غرفة عامة':'🔒 غرفة خاصة'} • ${state.phase==='lobby'?'بانتظار الدخول':'جولة '+state.round}</div><h2 class="room-name">🎭 ${esc(state.roomName)}</h2></div><div class="flex"><div class="room-code-pill"><button data-action="copy" aria-label="نسخ رمز الغرفة">نسخ الرمز</button>${esc(state.code)}</div><button class="subtle" data-action="invite">🔗 رابط دعوة</button><button class="subtle" data-action="leave">خروج</button></div></div>`;}
function ruleToggle(name,label,help,editable=true) {
  const enabled=!!state.rules?.[name];
  const isHost=state.me.id===state.hostId;
  return `<div class="setting-row"><div><strong>${label}</strong><p class="hint">${help}</p></div>
    ${isHost&&editable?`<button data-action="toggle-rule" data-rule="${name}" class="toggle-button ${enabled?'enabled':''}" aria-pressed="${enabled}">${enabled?'مفعّل ✓':'مقفّل ✕'}</button>`:`<span class="tag ${enabled?'green':''}">${enabled?'مفعّل':'مقفّل'}</span>`}</div>`;
}
function settingsBlock(){
  if(state.phase!=='lobby')return '';
  const isHost=state.hostId===state.me.id;
  const isLobby=state.phase==='lobby';
  const full=state.countTotal>=state.capacity;
  const countRows=Object.entries(roles).map(([name,meta])=>`<div class="role-row"><div class="role-name">${meta.emoji} ${meta.label}</div><div class="stepper">${isHost&&isLobby?`<button aria-label="تقليل ${meta.label}" data-action="role-minus" data-role="${name}" ${state.counts[name]===0?'disabled':''}>−</button>`:''}<span>${state.counts[name]}</span>${isHost&&isLobby?`<button aria-label="زيادة ${meta.label}" data-action="role-plus" data-role="${name}" ${full?'disabled':''}>+</button>`:''}</div></div>`).join('');
  const ready=state.countTotal===state.capacity&&state.players.length===state.capacity&&state.counts.mafia>=1&&state.counts.mafia<state.capacity;
  const msg=state.players.length<state.capacity?`باقي ${state.capacity-state.players.length} لاعب للدخول.`:
    state.countTotal<state.capacity?`أضف ${state.capacity-state.countTotal} دور حتى يكتمل التوزيع.`:
    !ready?'لازم مافيا واحدة على الأقل وشخص من غير المافيا.':'الجميع جاهز!';
  return `<details id="room-settings" class="card settings-panel" ${settingsExpanded?'open':''}>
    <summary class="section-title">⚙️ إعدادات الغرفة <span class="tag">${isHost?'أنت المضيف':'المضيف يتحكم'} · ${isLobby?'قبل البدء':'أثناء الجولة'}</span></summary>
    <div class="room-privacy"><div><strong>${state.visibility==='public'?'🌍 عامة':'🔒 خاصة'}</strong><p class="hint">${state.visibility==='public'?'تظهر في قائمة الغرف العامة ويمكن لأي أحد الانضمام.':'لا تظهر في قائمة الغرف؛ الدخول برمز أو رابط الدعوة.'}</p></div>${isHost&&isLobby?`<button class="subtle" data-action="toggle-visibility">${state.visibility==='public'?'اجعلها خاصة 🔒':'اجعلها عامة 🌍'}</button>`:''}</div>
    <h3 class="settings-subtitle">💬 إعدادات الشات</h3>
    ${ruleToggle('textChat','الشات الكتابي','تشغيل أو إيقاف إرسال الرسائل للاعبين أثناء الجولة.')}
    ${ruleToggle('voiceChat','الشات الصوتي 🎙️','اختياري. النهار للجميع، والليل للمافيا؛ المستبعد يستمع فقط في المرحلتين.')}
    <h3 class="settings-subtitle">🎭 قواعد اللعب</h3>
    ${ruleToggle('revealRoles','كشف دور المستبعد','يظهر دور اللاعب بعد إخراجه بالتصويت أو المافيا أو القنّاص. عند الإيقاف يُعلن اسمه فقط.',isLobby)}
    ${!isLobby?`<p class="hint">نوع الغرفة والأدوار وكشف الأدوار لا تتغير أثناء الجولة. يمكن للمضيف تشغيل وإيقاف الشاتين أثناء اللعب.</p>`:''}
    ${isLobby?`${isHost?`<label class="form-label" for="capacity-input">عدد اللاعبين المطلوب</label><div class="capacity-row"><span class="muted">حدد مقاعد الغرفة:</span><input id="capacity-input" type="number" inputmode="numeric" min="3" max="500" value="${state.capacity}" class="field"><button class="subtle" data-action="save-capacity">حفظ</button></div>`:
    `<p class="status">عدد اللاعبين المطلوب: <strong>${state.capacity}</strong></p>`}
    <div style="margin-top:18px"><h3 class="section-title">🎭 عدد الأدوار</h3>${countRows}</div>
    <div class="progress" role="progressbar" aria-valuenow="${state.countTotal}" aria-valuemin="0" aria-valuemax="${state.capacity}"><span style="width:${100*state.countTotal/state.capacity}%"></span></div><p class="status">${capLabel()}</p>
    <p class="hint">زر الزيادة يقفل تلقائيًا إذا ساوى مجموع الأدوار عدد اللاعبين، وتقدر تنقص أي دور وتعيد توزيعه.</p>
    <div class="event">${esc(msg)}</div>
    ${isHost?`<button class="primary big" data-action="start" ${!ready?'disabled':''}>🚀 ابدأ الجولة</button>`:''}`:''}
  </details>`;
}
function playersBlock(){
  const isHost=state.hostId===state.me.id;
  const list=state.players.map(p=>`<div class="player ${!p.alive?'ghost':''}"><div style="min-width:0"><div class="player-name">${p.alive?'👤':'💤'} ${esc(p.name)} ${p.id===state.me.id?'(أنت)':''}</div><small>${p.host?'👑 المضيف • ':''}${p.role?`${roles[p.role].emoji} ${roles[p.role].label} • `:''}${p.teammate?'شريك المافيا • ':''}${p.alive?'موجود':'مستبعد'}</small></div>${isHost&&p.id!==state.me.id&&state.phase==='lobby'?`<button class="mini" data-action="kick" data-player="${p.id}">إزالة</button>`:''}</div>`).join('');
  return `<section class="card"><h3 class="section-title">👥 اللاعبون <span class="tag">${state.players.length} / ${state.capacity}</span></h3><div class="player-grid">${list}</div></section>`;
}
function roleBlock(){
  if(state.phase==='lobby')return '';
  const role=roles[state.me.role];
  const text=state.me.alive?role.description:'خرجت من الجولة، وتقدر تتابع الأحداث بدون كتابة أو تصويت.';
  const sniperStatus=state.me.role==='sniper'?`<div class="event">${state.me.sniperUsed?'🎯 استُخدمت بطاقتك الوحيدة. لن تعود حتى بداية لعبة جديدة.':'🎯 بطاقتك جاهزة: طلقة واحدة فقط؛ احتفظ بها لأي ليلة.'}</div>`:'';
  const investigation=state.me.investigation?`<div class="event">🔍 فحص الليلة ${state.me.investigation.round}: ${esc(state.me.investigation.name)} ${state.me.investigation.isMafia?'من المافيا 🕶️':'ليس من المافيا ✅'}</div>`:'';
  return `<div class="myrole"><div class="role-em">${role.emoji}</div><div><h3>دورك السري: ${role.label}${state.me.alive?'':' • مستبعد'}</h3><p>${text}</p></div></div>${sniperStatus}${investigation}`;
}
function actionBlock(){
  if(!state.me.alive)return `<p class="status">تقدر تتابع اللعبة. انتظر نهاية الجولة.</p>`;
  const phase=state.phase;
  if(phase==='night'){
    if(state.me.role==='citizen')return `<p class="status">🌙 أنت مواطن، انتظر الصباح حتى تبدأ المناقشة.</p>`;
    if(state.me.role==='sniper'){
      if(state.me.sniperUsed)return `<p class="status">🎯 استخدمت طلقتك الوحيدة. تابع بقية الأدوار؛ لن تعود البطاقة حتى تبدأ لعبة جديدة.</p>`;
      const candidates=state.players.filter(p=>p.alive&&p.id!==state.me.id);
      return `<p class="status">🎯 عندك بطاقة واحدة فقط. تقدر تطلقها في أي ليلة أو تحتفظ بها.</p>
        <div class="choice-list">${candidates.map(p=>`<button data-action="sniper-fire" data-target="${p.id}">🎯 استهداف ${esc(p.name)}</button>`).join('')}
        <button class="skip" data-action="sniper-skip">احتفظ بالطلقة لهذه الليلة</button></div>
        <p class="hint">بعد تأكيد إطلاقها تُستهلك البطاقة فورًا، حتى لو حمى الطبيب الهدف.</p>`;
    }
    const candidates=state.players.filter(p=>p.alive&&(state.me.role!=='mafia'||!p.teammate)&&(state.me.role!=='detective'||p.id!==state.me.id));
    const prompt=state.me.role==='mafia'?'اختر هدف المافيا لليلة:':state.me.role==='doctor'?'اختر لاعبًا تحميه (تقدر تحمي نفسك):':'اختر لاعبًا للتحقيق في هويته:';
    return `<p class="status">${prompt}</p><div class="choice-list">${candidates.map(p=>`<button data-action="target" data-target="${p.id}" class="${state.me.nightTarget===p.id?'selected':''}">${esc(p.name)} ${state.me.nightTarget===p.id?'✓':''}</button>`).join('')}</div><p class="hint">اختيارك سري ويمكن تغييره حتى ينتهي الليل.</p>`;
  }
  if(phase==='voting')return `<p class="status">🗳️ من تتوقع أنه مافيا؟ لا يمكنك التصويت لنفسك.</p><div class="choice-list">${state.players.filter(p=>p.alive&&p.id!==state.me.id).map(p=>`<button data-action="target" data-target="${p.id}" class="${state.me.vote===p.id?'selected':''}">${esc(p.name)}</button>`).join('')}<button class="skip ${state.me.vote==='skip'?'selected':''}" data-action="target" data-target="skip">تخطي التصويت</button></div><p class="hint">عند تصويت الجميع تُحسب النتيجة تلقائيًا.</p>`;
  if(phase==='day')return `<p class="status">☀️ ناقش اللاعبين في الشات العام وحاول تكشف المافيا.</p>${state.me.id===state.hostId?`<button class="subtle" data-action="skip-day">🗳️ الانتقال للتصويت الآن</button>`:''}`;
  return '';
}
function statusCard(){
  if(state.phase==='lobby')return '';
  const name={night:'🌙 مرحلة الليل',day:'☀️ نقاش النهار',voting:'🗳️ وقت التصويت',finished:'🏆 انتهت الجولة'}[state.phase];
  return `<div class="stat-strip"><div class="list-inline"><strong>${name}</strong><span class="tag">الجولة ${state.round}</span></div>${state.until?'<div id="countdown" class="clock">--:--</div>':''}</div><div class="event">${esc(state.announcement)}</div>${state.phase==='finished'?`<div class="card"><div class="winner">${state.winner==='mafia'?'🏴 المافيا فازت':'🏆 المواطنون فازوا'}</div>${state.hostId===state.me.id?'<button class="primary big" data-action="restart">جولة جديدة ↻</button>':''}</div>`:''}`;
}
function chatBlock(){
  const canTalk=state.rules.textChat&&state.me.alive&&(['day','voting'].includes(state.phase)||(state.phase==='night'&&state.me.role==='mafia'));
  const mafiaAllowed=state.me.role==='mafia';
  if(channel==='mafia'&&!mafiaAllowed)channel='public';
  const messages=channel==='mafia'?state.mafiaChat:state.publicChat;
  const open=canTalk&&(channel==='public'?['day','voting'].includes(state.phase):(state.phase==='night'&&mafiaAllowed));
  const html=messages.length?messages.map(msg=>`<article class="chat-message ${msg.system?'system':''}"><div class="sender">${esc(msg.sender)} <span class="timestamp">${clientTime(msg.at)}</span></div><p>${esc(msg.text)}</p>${!msg.system&&msg.senderId!==state.me.id?`<div class="msg-actions"><button data-action="report" data-message="${msg.id}">إبلاغ</button><button data-action="block" data-player="${msg.senderId}">إخفاء اللاعب</button></div>`:''}</article>`).join(''):'<div class="empty-text">ما فيه رسائل للحين.</div>';
  return `<section class="card chat-card"><h3 class="section-title">💬 المحادثة</h3><div class="tabs"><button data-action="tab" data-channel="public" class="${channel==='public'?'active':''}">الشات العام</button>${mafiaAllowed?`<button data-action="tab" data-channel="mafia" class="${channel==='mafia'?'active':''}">🕶️ شات المافيا</button>`:''}</div>
    <div class="chat-log" id="chat-log">${html}</div><form class="chat-send" id="chat-form"><input class="field" type="text" id="chat-text" maxlength="280" placeholder="${open?'اكتب رسالتك...':'الشات مغلق الآن'}" ${open?'':'disabled'} value="${esc(draft)}" autocomplete="off"><button class="primary" ${open?'':'disabled'}>إرسال</button></form><p class="hint">احترم اللاعبين. تقدر تبلغ عن أي إساءة أو تخفي رسائل صاحبها. لا تشارك معلومات شخصية.</p></section>`;
}
function render(){
  if(!state)return;
  const active=document.activeElement?.id||null;
  const selected=active&&$(active)?.selectionStart;
  const isLobby=state.phase==='lobby';
  $('game').innerHTML=`${roomHeader()}${statusCard()}<div class="columns"><div>${isLobby?'':`<section class="card"><h3 class="section-title">🎭 دورك وقراراتك</h3>${roleBlock()}${actionBlock()}</section>`}${settingsBlock()}</div><div>${playersBlock()}${!isLobby?`${window.VoiceChat?.ui()||''}${chatBlock()}`:`<div class="card chat-card"><p class="status">🎙️ يتحكم المضيف بالصوت والشات من إعدادات الغرفة. يبدأ الصوت بعد انطلاق الجولة.</p></div>`}</div></div><div class="footer-controls"><span class="fine">نسخة تجريبية • الغرف مؤقتة وتختفي إذا أُعيد تشغيل الخادم</span></div>`;
  if(active&&$(active)&&!$(active).disabled){$(active).focus();if(typeof selected==='number'&&$(active).setSelectionRange)try{$(active).setSelectionRange(selected,selected);}catch{}}
  const log=$('chat-log');if(log)log.scrollTop=log.scrollHeight;
  tick();
}
function tick(){const e=$('countdown');if(!e||!state?.until)return;const remaining=Math.max(0,Math.ceil((state.until-Date.now())/1000));e.textContent=`${String(Math.floor(remaining/60)).padStart(2,'0')}:${String(remaining%60).padStart(2,'0')}`;}
setInterval(tick,1000);
$('create-room').addEventListener('click',async()=>{
  try{const visibility=document.querySelector('input[name="new-room-visibility"]:checked')?.value||'private';const data=await call('create',{name:$('player-name').value,visibility,roomName:$('new-room-name').value});token=data.token;localStorage.setItem('mafia_token',token);connect();toast(visibility==='public'?'تم إنشاء غرفة عامة؛ ستظهر في قائمة الغرف!':'تم إنشاء غرفة خاصة. شارك الرمز مع أصحابك!');}
  catch(e){toast(e.message);}
});
$('join-room').addEventListener('click',async()=>{
  try{const data=await call('join',{name:$('player-name').value,code:$('room-code').value});token=data.token;localStorage.setItem('mafia_token',token);connect();}
  catch(e){toast(e.message);}
});
$('room-code').addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');});
$('refresh-rooms').addEventListener('click',refreshPublicRooms);
$('public-rooms-list').addEventListener('click',async e=>{
  if(e.target.id==='retry-rooms'){refreshPublicRooms();return;}
  const button=e.target.closest('[data-public-code]');
  if(!button||button.disabled)return;
  if(!$('player-name').value.trim()){toast('اكتب اسم اللاعب أولًا قبل الانضمام.');$('player-name').focus();return;}
  button.disabled=true;
  try{const data=await call('join',{name:$('player-name').value,code:button.dataset.publicCode});token=data.token;localStorage.setItem('mafia_token',token);connect();}
  catch(err){toast(err.message);refreshPublicRooms();}
  finally{button.disabled=false;}
});
setInterval(refreshPublicRooms,10000);
refreshPublicRooms();
$('game').addEventListener('input',e=>{if(e.target.id==='chat-text')draft=e.target.value;});
$('game').addEventListener('toggle',e=>{if(e.target.id==='room-settings')settingsExpanded=e.target.open;},true);
$('game').addEventListener('submit',async e=>{
  if(e.target.id!=='chat-form')return;
  e.preventDefault();
  const msg=$('chat-text')?.value?.trim();if(!msg)return;
  try{await call('chat',{channel,text:msg});draft='';const inp=$('chat-text');if(inp){inp.value='';inp.focus();}}
  catch(err){toast(err.message);}
});
$('game').addEventListener('click',async e=>{
  const element=e.target.closest('[data-action]');if(!element||element.disabled||!state)return;
  const action=element.dataset.action;
  try{
    if(action==='copy'){
      await navigator.clipboard.writeText(state.code);toast('تم نسخ رمز الغرفة.');return;
    }
    if(action==='invite'){
      const url=new URL('/',window.location.origin);
      url.searchParams.set('room',state.code);
      await navigator.clipboard.writeText(url.toString());
      toast('تم نسخ رابط الدعوة. أرسله لأصحابك!');return;
    }
    if(action==='tab'){channel=element.dataset.channel;render();return;}
    if(action==='leave'){if(!confirm('تبي تطلع من الغرفة؟'))return;await call('leave');reset();return;}
    if(action==='voice-listen'){await window.VoiceChat?.toggleListen();return;}
    if(action==='voice-mic'){await window.VoiceChat?.toggleMic();return;}
    if(action==='toggle-rule'){const rule=element.dataset.rule;await call('settings',{[rule]:!state.rules[rule]});toast('تم حفظ الإعداد.');return;}
    if(action==='toggle-visibility'){const visibility=state.visibility==='public'?'private':'public';await call('settings',{visibility});toast(visibility==='public'?'صارت الغرفة عامة ويمكن للجميع رؤيتها.':'صارت الغرفة خاصة، وتم إخفاؤها من القائمة.');return;}
    if(action==='role-plus'||action==='role-minus'){
      const name=element.dataset.role;const counts={...state.counts};counts[name]+=action==='role-plus'?1:-1;
      await call('settings',{counts});return;
    }
    if(action==='save-capacity'){await call('settings',{capacity:Number($('capacity-input').value)});return;}
    if(action==='start'){await call('start');toast('انطلقت الجولة! دورك يظهر لك وحدك.');return;}
    if(action==='sniper-fire'){
      if(!confirm('متأكد؟ بطاقتك الوحيدة ستنتهي بعد الإطلاق ولا يمكن التراجع.'))return;
      await call('action',{targetId:element.dataset.target});toast('🎯 أُطلقت الطلقة! لن تعود البطاقة لهذه اللعبة.');return;
    }
    if(action==='sniper-skip'){await call('action',{targetId:'skip'});toast('احتفظت بالطلقة للجولة القادمة.');return;}
    if(action==='target'){await call('action',{targetId:element.dataset.target});toast('تم حفظ اختيارك بسرية.');return;}
    if(action==='skip-day'){await call('skip-day');return;}
    if(action==='restart'){settingsExpanded=true;await call('restart');return;}
    if(action==='kick'){
      if(!confirm('متأكد أنك تبي تشيل هذا اللاعب؟'))return;
      await call('kick',{playerId:element.dataset.player});toast('تم حذف اللاعب.');return;
    }
    if(action==='report'){await call('report',{messageId:element.dataset.message});toast('تم استلام البلاغ داخل هذه الغرفة التجريبية.');return;}
    if(action==='block'){await call('block',{playerId:element.dataset.player});toast('لن تظهر رسائل هذا اللاعب لك.');return;}
  }catch(err){toast(err.message);}
});
// Sharing a room URL fills the invite code; a player still chooses a name.
const invitedRoom=new URLSearchParams(window.location.search).get('room');
if(invitedRoom&&/^[A-Z2-9]{6}$/i.test(invitedRoom))$('room-code').value=invitedRoom.toUpperCase();
if(token)connect();
