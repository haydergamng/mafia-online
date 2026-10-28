'use strict';
// WebRTC peer-to-peer audio. The server authorizes and relays signals only.
const VoiceChat=(()=>{
  let joined=false;
  let microphone=null;
  let currentChannel=null;
  let currentRoom=null;
  const connections=new Map();
  let boundStream=null;
  let iceServers=[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}];
  let hasTurn=false;
  let audioBlocked=false;
  let lastError='';
  function connectionCounts(){
    const peers=[...connections.values()];
    return {connected:peers.filter(p=>p.pc.connectionState==='connected').length,
      trying:peers.filter(p=>['new','connecting'].includes(p.pc.connectionState)).length,
      failed:peers.filter(p=>['failed','disconnected'].includes(p.pc.connectionState)).length};
  }
  async function getIceConfig(){
    const response=await fetch(`/api/voice-config?token=${encodeURIComponent(token)}`,{cache:'no-store'});
    if(!response.ok)throw Error('تعذر تحميل إعدادات الاتصال.');
    const data=await response.json();
    if(!Array.isArray(data.iceServers)||!data.iceServers.length)throw Error('إعدادات الصوت غير صالحة.');
    iceServers=data.iceServers;hasTurn=!!data.hasTurn;
  }

  function canListen(){return !!(state?.rules?.voiceChat&&state?.voice?.channel);}
  function canSpeak(){return !!(canListen()&&state.voice.canSpeak);}
  function talking(){return !!microphone?.getAudioTracks().some(t=>t.readyState==='live');}
  function refresh(){const target=document.getElementById('voice-widget');if(target)target.outerHTML=ui();}
  function closePeer(id){
    const peer=connections.get(id);if(!peer)return;
    connections.delete(id);
    peer.pc.onicecandidate=null;peer.pc.ontrack=null;peer.pc.onnegotiationneeded=null;
    peer.pc.close();peer.audio?.remove();
  }
  function clearPeers(){for(const id of [...connections.keys()])closePeer(id);}
  async function stopMic(){
    const old=microphone;microphone=null;
    for(const item of connections.values())try{await item.sender.replaceTrack(null);}catch{}
    old?.getTracks().forEach(t=>t.stop());
  }
  function stop(){joined=false;clearPeers();stopMic();currentChannel=null;currentRoom=null;lastError='';audioBlocked=false;refresh();}
  function reset(){stop();}
  async function send(id,signal){
    if(!joined||!canListen())return;
    try{await call('voice-signal',{targetId:id,signal});}catch(e){console.warn('Voice signal failed',e.message);}
  }
  function peerConnection(peer){
    if(connections.has(peer.id))return connections.get(peer.id);
    if(typeof RTCPeerConnection==='undefined')return null;
    const pc=new RTCPeerConnection({iceServers});
    // Spectators are receive-only at the WebRTC transport level too.
    const transceiver=pc.addTransceiver('audio',{direction:canSpeak()?'sendrecv':'recvonly'});
    const item={pc,sender:transceiver.sender,audio:null,candidates:[],speaker:peer.speaker};
    connections.set(peer.id,item);
    const micTrack=microphone?.getAudioTracks()[0];
    if(micTrack&&canSpeak())item.sender.replaceTrack(micTrack).catch(console.warn);
    pc.onicecandidate=e=>{if(e.candidate)send(peer.id,{type:'candidate',candidate:e.candidate.toJSON()});};
    pc.ontrack=e=>{
      if(!item.speaker)return; // المستبعد لا يصل صوته للاعبين
      const audio=document.createElement('audio');
      audio.autoplay=true;audio.playsInline=true;
      audio.dataset.voicePlayer=peer.id;
      audio.srcObject=e.streams[0]||new MediaStream([e.track]);
      document.getElementById('voice-audios')?.append(audio);
      audio.play().then(()=>{audioBlocked=false;refresh();}).catch(()=>{
        audioBlocked=true;
        lastError='المتصفح منع تشغيل صوت اللاعبين تلقائيًا. اضغط «تشغيل السماعة».';
        refresh();
      });
      item.audio?.remove();item.audio=audio;
    };
    pc.onconnectionstatechange=()=>{
      if(pc.connectionState==='failed'){
        lastError=hasTurn?'فشل الاتصال. جرّب «إعادة اتصال الصوت».':'فشل الاتصال المباشر. جرّب «إعادة اتصال الصوت»؛ قد تحتاج شبكتكم إلى TURN.';
      }
      if(pc.connectionState==='connected')lastError='';
      refresh();
    };
    pc.onnegotiationneeded=async()=>{
      // A deterministic offerer prevents simultaneous offers.
      if(!joined||!state||state.me.id>=peer.id||pc.signalingState!=='stable')return;
      try{
        const offer=await pc.createOffer();
        if(pc.signalingState!=='stable')return;
        await pc.setLocalDescription(offer);
        await send(peer.id,{type:'offer',sdp:pc.localDescription.sdp});
      }catch(e){console.warn('Voice offer failed',e);}
    };
    return item;
  }
  function sync(next){
    if(!next?.voice)return;
    // When the host disables voice, the server revokes everyone's presence.
    // Don't show a stale connected state if the host later enables it again.
    if(joined && !next.rules?.voiceChat){
      stop();
      return;
    }
    if(next.code!==currentRoom||next.voice.channel!==currentChannel){
      clearPeers();currentRoom=next.code;currentChannel=next.voice.channel;
    }
    if(!joined||!canListen()){
      clearPeers();lastError='';
      if(talking())stopMic();
      refresh();return;
    }
    if(!canSpeak()&&talking())stopMic();
    const allowed=new Set(next.voice.peers.map(p=>p.id));
    for(const id of connections.keys())if(!allowed.has(id))closePeer(id);
    for(const peer of next.voice.peers){
      const existing=connections.get(peer.id);
      if(existing){existing.speaker=peer.speaker;continue;}
      peerConnection(peer);
    }
    refresh();
  }
  async function receive(event){
    if(!joined||!canListen()||typeof RTCPeerConnection==='undefined')return;
    let msg;try{msg=JSON.parse(event.data);}catch{return;}
    const source=state?.voice?.peers.find(p=>p.id===msg.from);
    if(!source)return;
    const item=peerConnection(source);if(!item)return;
    const pc=item.pc;
    try{
      if(msg.signal.type==='offer'){
        if(pc.signalingState!=='stable')return;
        await pc.setRemoteDescription({type:'offer',sdp:msg.signal.sdp});
        const answer=await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await send(source.id,{type:'answer',sdp:pc.localDescription.sdp});
      }else if(msg.signal.type==='answer'){
        if(pc.signalingState!=='have-local-offer')return;
        await pc.setRemoteDescription({type:'answer',sdp:msg.signal.sdp});
      }else if(msg.signal.type==='candidate'){
        if(pc.remoteDescription)await pc.addIceCandidate(msg.signal.candidate);
        else item.candidates.push(msg.signal.candidate);
      }
      if(pc.remoteDescription&&item.candidates.length){
        for(const candidate of item.candidates.splice(0))await pc.addIceCandidate(candidate);
      }
    }catch(e){console.warn('Voice connection issue',e);}
  }
  function bind(source){
    if(boundStream===source)return;
    boundStream=source;source.addEventListener('signal',receive);
  }
  async function toggleListen(){
    if(!canListen()){toast('الشات الصوتي غير متاح في هذه المرحلة.');return;}
    if(joined){
      joined=false;clearPeers();await stopMic();
      try{await call('voice-presence',{joined:false});}catch(e){toast(e.message);}
      refresh();return;
    }
    if(typeof RTCPeerConnection==='undefined'){toast('هذا الجهاز لا يدعم الاتصال الصوتي WebRTC.');return;}
    try{
      await getIceConfig();
      await call('voice-presence',{joined:true});
      joined=true;lastError='';sync(state);refresh();
      toast('🔊 دخلت الشات الصوتي. لتسمع أحدًا، لازم يدخل الصوت هو أيضًا.');
    }catch(e){lastError=e.message;toast(e.message);refresh();}
  }
  async function toggleMic(){
    if(!joined||!canSpeak()){toast('الميكروفون غير متاح لك الآن.');return;}
    if(talking()){await stopMic();refresh();toast('تم كتم المايك.');return;}
    if(!navigator.mediaDevices?.getUserMedia){toast('الميكروفون يحتاج متصفحًا آمنًا (HTTPS) وإذن الوصول.');return;}
    try{
      microphone=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      const track=microphone.getAudioTracks()[0];
      await Promise.all([...connections.values()].map(item=>item.sender.replaceTrack(track)));
      refresh();toast('🎤 المايك يعمل الآن.');
    }catch(e){toast('تعذر فتح المايك. تأكد من الأذونات على الجهاز.');}
  }
  async function retry(){
    if(!joined||!canListen())return;
    clearPeers();lastError='';
    try{await getIceConfig();sync(state);toast('نعيد الاتصال الصوتي باللاعبين...');}
    catch(e){lastError=e.message;toast(e.message);}
    refresh();
  }
  async function unlockAudio(){
    const audios=[...document.querySelectorAll('#voice-audios audio')];
    let errors=0;
    for(const el of audios)try{await el.play();}catch{errors++;}
    audioBlocked=errors>0;
    if(audioBlocked)toast('الصوت محظور من إعدادات المتصفح. تحقق من السماعة والإذن.');
    else{lastError='';toast('🔊 السماعة جاهزة.');}
    refresh();
  }
  function ui(){
    if(!state)return '';
    const available=canListen();
    const label=state.voice?.channel==='mafia-night'?'🌙 شات المافيا':'☀️ الشات العام';
    const listening=joined&&available;
    const counts=connectionCounts();
    const status=listening?(counts.connected?`🟢 متصل صوتيًا مع ${counts.connected} لاعب`:counts.trying?'🟡 جاري توصيل الصوت...':state.voice.peers.length?'🔴 لم يكتمل اتصال الصوت':'بانتظار دخول لاعب آخر إلى الشات الصوتي'):'لم تدخل القناة الصوتية بعد';
    return `<section id="voice-widget" class="card voice-widget">
      <h3 class="section-title">🎙️ الشات الصوتي <span class="tag ${available?'green':''}">${available?'متاح':'غير متاح'}</span></h3>
      <p class="status">${!state.rules.voiceChat?'المضيف قفل الشات الصوتي.':state.phase==='lobby'?'يفتح الشات الصوتي بعد بدء اللعبة.':!available?'أنت لاعب حي خارج المافيا؛ الصوت مغلق في الليل.':state.me.alive?label:'👻 متفرج: تسمع الجميع نهارًا والمافيا ليلًا، دون الكلام.'}</p>
      ${available?`<div class="voice-buttons"><button class="${listening?'danger':'secondary'}" data-action="voice-listen">${listening?'🔇 مغادرة الصوت':'🔊 دخول الصوت'}</button><button class="${talking()?'primary':'subtle'}" data-action="voice-mic" ${!listening||!canSpeak()?'disabled':''}>${talking()?'🎤 كتم المايك':'🎙️ فتح المايك'}</button></div>`:''}
      ${available&&listening?`<p class="hint">${status} · ${state.voice.peers.length} داخل القناة. ${canSpeak()?'شغّل المايك للتحدث.':'وضع الاستماع فقط.'}</p>`:''}
      ${listening&&audioBlocked?`<button class="secondary" data-action="voice-unlock">🔈 تشغيل السماعة</button>`:''}
      ${listening&&state.voice.peers.length&&counts.connected<state.voice.peers.length?`<button class="subtle" data-action="voice-retry">🔄 إعادة اتصال الصوت</button>`:''}
      ${listening&&lastError?`<p class="hint" role="status">⚠️ ${lastError}</p>`:''}
      <p class="hint">الدخول الصوتي اختياري. تقدر تغادر أو تكتم المايك بأي وقت. في الغرف العامة لا تشارك معلوماتك الشخصية.</p>
    </section>`;
  }
  return {sync,reset,bind,toggleListen,toggleMic,retry,unlockAudio,ui};
})();
// Top-level const does not become a window property in classic browser scripts.
window.VoiceChat=VoiceChat;
// Handle only new voice diagnostics here; existing app.js stays untouched.
document.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-action]');
  if(!button||button.disabled)return;
  if(button.dataset.action==='voice-retry')VoiceChat.retry();
  if(button.dataset.action==='voice-unlock')VoiceChat.unlockAudio();
});
if(stream)VoiceChat.bind(stream);
