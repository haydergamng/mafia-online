'use strict';
// WebRTC peer-to-peer audio. The server authorizes and relays signals only.
const VoiceChat=(()=>{
  let joined=false;
  let microphone=null;
  let currentChannel=null;
  let currentRoom=null;
  const connections=new Map();
  let boundStream=null;

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
  function stop(){joined=false;clearPeers();stopMic();currentChannel=null;currentRoom=null;refresh();}
  function reset(){stop();}
  async function send(id,signal){
    if(!joined||!canListen())return;
    try{await call('voice-signal',{targetId:id,signal});}catch(e){console.warn('Voice signal failed',e.message);}
  }
  function peerConnection(peer){
    if(connections.has(peer.id))return connections.get(peer.id);
    if(typeof RTCPeerConnection==='undefined')return null;
    const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
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
      audio.play().catch(()=>{});
      item.audio?.remove();item.audio=audio;
    };
    pc.onconnectionstatechange=()=>{
      if(pc.connectionState==='failed'||pc.connectionState==='closed')closePeer(peer.id);
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
      clearPeers();
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
      await call('voice-presence',{joined:true});
      joined=true;sync(state);refresh();toast('🔊 دخلت الشات الصوتي. المايك مغلق حتى تشغّله.');
    }catch(e){toast(e.message);}
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
  function ui(){
    if(!state)return '';
    const available=canListen();
    const label=state.voice?.channel==='mafia-night'?'🌙 شات المافيا':'☀️ الشات العام';
    const listening=joined&&available;
    return `<section id="voice-widget" class="card voice-widget">
      <h3 class="section-title">🎙️ الشات الصوتي <span class="tag ${available?'green':''}">${available?'متاح':'غير متاح'}</span></h3>
      <p class="status">${!state.rules.voiceChat?'المضيف قفل الشات الصوتي.':state.phase==='lobby'?'يفتح الشات الصوتي بعد بدء اللعبة.':!available?'أنت لاعب حي خارج المافيا؛ الصوت مغلق في الليل.':state.me.alive?label:'👻 متفرج: تسمع الجميع نهارًا والمافيا ليلًا، دون الكلام.'}</p>
      ${available?`<div class="voice-buttons"><button class="${listening?'danger':'secondary'}" data-action="voice-listen">${listening?'🔇 مغادرة الصوت':'🔊 دخول الصوت'}</button><button class="${talking()?'primary':'subtle'}" data-action="voice-mic" ${!listening||!canSpeak()?'disabled':''}>${talking()?'🎤 كتم المايك':'🎙️ فتح المايك'}</button></div>`:''}
      ${available&&listening?`<p class="hint">داخل القناة الصوتية · ${state.voice.peers.length} مستمع/متحدث آخر. ${canSpeak()?'المايك مغلق افتراضيًا.':'وضع الاستماع فقط.'}</p>`:''}
      <p class="hint">الدخول الصوتي اختياري. تقدر تغادر أو تكتم المايك بأي وقت. في الغرف العامة لا تشارك معلوماتك الشخصية.</p>
    </section>`;
  }
  return {sync,reset,bind,toggleListen,toggleMic,ui};
})();
// Top-level const does not become a window property in classic browser scripts.
window.VoiceChat=VoiceChat;
if(stream)VoiceChat.bind(stream);
