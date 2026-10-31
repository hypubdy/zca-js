import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IndependentCall} from '../independent-call.mjs';
import {buildCompoundRtcpReport, decodeZrtpRelayMedia, encodeZrtpRelayMedia, parseCompoundRtcp} from '../../../dist/call/index.js';
function request() {return {act:'request',data:{uidFrom:'123',uidTo:'456',uidN:'test-peer',ts:Date.now(),params:JSON.stringify({id:42,sessId:'synthetic-private-session-do-not-log',rtpIP:'127.0.0.1:1234',rtcpIP:'127.0.0.1:1235',codec:'[{"name":"opus","payload":112}]'})}};}
test('independent offer is held privately and diagnostics never contain session data',()=>{
 const events=[];const engine=new IndependentCall((event,data)=>events.push({event,data}));
 engine.observe(request());
 assert.equal(engine.status().nativeEngine,false);assert.equal(engine.status().mediaReady,false);
 assert.equal(engine.status().offerParsed,true);
 assert.deepEqual(engine.status().codecs,[{name:'opus',payload:112}]);
 assert.equal(engine.status().offerDiagnostics.sessionIdLength,'synthetic-private-session-do-not-log'.length);
 assert.ok(!JSON.stringify(events).includes('synthetic-private'));
 engine.observe({act:'end_call'});assert.equal(engine.status().offerParsed,false);
});
test('incoming-offer diagnostics expose negotiated fields and redact identifiers and crypto material',()=>{
 const events=[];const engine=new IndependentCall((event,data)=>events.push({event,data}));
 const secret='must-never-appear-in-diagnostics';
 engine.observe({act:'request',data:{uidFrom:'123456789',uidTo:'987654321',uidN:'peer',ts:1,
  params:JSON.stringify({id:42,sessId:secret,rtpIP:'192.0.2.2:30000',rtcpIP:'192.0.2.2:30001',
   codec:'[{"name":"opus/16000/1","payload":112,"frmPtime":20,"dynamicFptime":0}]',
   extendData:JSON.stringify({srtpMode:1,srtcp:1,authToken:secret}),
   zrtc_config:{srtpMode:1,srtpRTCP:1,srtpKey:secret,packetMode:3}})}});
 const diagnostic=events.find(item=>item.event==='independent-offer').data;
 assert.deepEqual(diagnostic.codecs,[{name:'opus/16000/1',payload:112,frmPtime:20,dynamicFptime:0}]);
 assert.deepEqual(diagnostic.rtp,{present:true,valid:true,family:'ipv4',port:30000});
 assert.deepEqual(diagnostic.extendData,{present:true,fields:{srtpMode:1,srtcp:1}});
 assert.deepEqual(diagnostic.zrtcConfig,{present:true,fields:{srtpMode:1,srtpRTCP:1,packetMode:3}});
 assert.ok(!JSON.stringify(events).includes(secret));
 assert.ok(!JSON.stringify(events).includes('123456789'));
});
test('incoming video request exposes only the negotiated video codec hints',()=>{
 const events=[];const engine=new IndependentCall((event,data)=>events.push({event,data}));
 engine.observe({act:'request',data:{uidFrom:'123456',uidTo:'987654',uidN:'peer',ts:1,
  params:JSON.stringify({id:9,sessId:'private-video-session',rtpIP:'192.0.2.4:4200',rtcpIP:'192.0.2.4:4200',
   codec:'[{"name":"opus/48000/2","payload":113}]',video:{enable:1,credential:'must-not-leak'},
   extendData:JSON.stringify({callType:1,video:{codec:1,payload:96,secret:'must-not-leak'}})})}});
 const diagnostic=events.find(item=>item.event==='independent-offer').data;
 assert.equal(diagnostic.videoRequested,true);assert.equal(diagnostic.videoCodecId,1);
 assert.deepEqual(diagnostic.extendData.fields.video,{codec:1,payload:96});
 assert.equal(diagnostic.extendData.fields.callType,1);
 assert.equal(engine.status().answerTrialAvailable,false);
 assert.equal(engine.status().videoCallTrialAvailable,false);
 assert.ok(!JSON.stringify(events).includes('private-video-session'));
 assert.ok(!JSON.stringify(events).includes('must-not-leak'));
});
test('video diagnostics retain only integer codec IDs from a bounded codec list',()=>{
 const events=[];const engine=new IndependentCall((event,data)=>events.push({event,data}));
 engine.observe({act:'request',data:{uidFrom:'123456',uidTo:'987654',uidN:'peer',ts:1,
  params:JSON.stringify({id:11,sessId:'private-codec-session',rtpIP:'192.0.2.6:4200',rtcpIP:'192.0.2.6:4200',
   codec:'[{"name":"opus/48000/2","payload":113}]',video:{enable:1},
   extendData:JSON.stringify({callType:1,video:{codec:[1,2,3]}})})}});
 const diagnostic=events.find(item=>item.event==='independent-offer').data;
 assert.equal(diagnostic.videoEnable,1);
 assert.deepEqual(diagnostic.videoCodecIds,[1,2,3]);
 assert.ok(!JSON.stringify(events).includes('private-codec-session'));
});
test('native h264 video capability objects retain name and payload',()=>{
 const events=[];const engine=new IndependentCall((event,data)=>events.push({event,data}));
 engine.observe({act:'request',data:{uidFrom:'123456',uidTo:'987654',uidN:'peer',ts:1,
  params:JSON.stringify({id:12,sessId:'private-h264-session',rtpIP:'192.0.2.7:4200',rtcpIP:'192.0.2.7:4200',
   codec:'[{"name":"opus/48000/2","payload":113}]',video:{enable:1},
   extendData:JSON.stringify({callType:1,video:{codec:[{name:'h264',payload:97}]}})})}});
 const diagnostic=events.find(item=>item.event==='independent-offer').data;
 assert.deepEqual(diagnostic.videoCodecs,[{name:'h264',payload:97}]);
 assert.ok(!JSON.stringify(events).includes('private-h264-session'));
});
test('explicit callType audio overrides the video capability/request bit',()=>{
 const events=[];const engine=new IndependentCall((event,data)=>events.push({event,data}));
 engine.observe({act:'request',data:{uidFrom:'123456',uidTo:'987654',uidN:'peer',ts:1,
  params:JSON.stringify({id:10,sessId:'private-audio-session',rtpIP:'192.0.2.5:4200',rtcpIP:'192.0.2.5:4200',
   codec:'[{"name":"opus/48000/2","payload":113}]',video:{enable:1},
   extendData:JSON.stringify({callType:0,video:{codec:[1,2]}})})}});
 const diagnostic=events.find(item=>item.event==='independent-offer').data;
 assert.equal(diagnostic.callType,0);
 assert.equal(diagnostic.videoRequested,false);
 assert.equal(engine.status().limitation.includes('video encoder'),false);
 assert.ok(!JSON.stringify(events).includes('private-audio-session'));
});
test('unsupported offer stays unready; no probe before fresh offer',async()=>{
 const events=[];const engine=new IndependentCall((event,data)=>events.push({event,data}));
 engine.observe({act:'request',data:{params:'{}'}});
 assert.equal(engine.status().offerParsed,false);
 assert.equal(events[0].event,'independent-error');
 await assert.rejects(engine.probe(),/lời mời/);
 engine.observe(request());engine.pending.at=Date.now()-60001;
 await assert.rejects(engine.probe(),/lời mời/);
});
test('matched SRTCP traverses relay type5 and authenticates a compound report offline',()=>{
 const engine=new IndependentCall(()=>{});
 const offer={uidTo:'456',uidFrom:'123',sessionId:'012345678901234567890123456789',extendData:JSON.stringify({srtpMode:1,srtcp:1}),
  zrtcConfig:{srtpMode:1,srtpRTCP:1,srtpKey:'abcdefghijklmnopqrstuvwxyz1234'}};
 const codec={name:'opus/16000/1',payloadType:112,sampleRate:16000,channels:1,frameMs:20};
 const security=engine.prepareRtpSecurity(offer,codec);
 const plain=buildCompoundRtcpReport({ssrc:security.localSsrc,cname:'synthetic@example.test'});
 const protectedPacket=security.srtcpProtect.protect(plain);
 const outbound=encodeZrtpRelayMedia({kind:'audioRtcp',token:0x12345678,payload:protectedPacket});
 const received=decodeZrtpRelayMedia(outbound);
 assert.equal(received.kind,'audioRtcp');assert.equal(received.token,0x12345678);
 assert.deepEqual(Buffer.from(security.srtcpUnprotect.unprotect(received.payload)),plain);
 assert.deepEqual(parseCompoundRtcp(plain).map(item=>item.packetType),[201,202]);
 security.protect.destroy();security.srtcpProtect.destroy();security.srtcpUnprotect.destroy();security.masterKeySalt.fill(0);
});
test('SRTCP capability mismatch fails closed while call remains unconfirmed',()=>{
 const engine=new IndependentCall(()=>{});
 const offer={uidTo:'456',uidFrom:'123',sessionId:'012345678901234567890123456789',extendData:JSON.stringify({srtpMode:1,srtcp:1}),
  zrtcConfig:{srtpMode:1,srtpRTCP:0,srtpKey:'abcdefghijklmnopqrstuvwxyz1234'}};
 const codec={name:'opus/16000/1',payloadType:112,sampleRate:16000,channels:1,frameMs:20};
 assert.throws(()=>engine.prepareRtpSecurity(offer,codec),/srtcp không khớp/);
 assert.equal(engine.status().mediaReady,false);
});
test('missing local srtpRTCP uses native false default when remote negotiates srtcp zero',()=>{
 const engine=new IndependentCall(()=>{});
 const offer={uidTo:'456',uidFrom:'123',sessionId:'012345678901234567890123456789',extendData:JSON.stringify({srtpMode:1,srtcp:0}),
  zrtcConfig:{srtpMode:1,srtpKey:'abcdefghijklmnopqrstuvwxyz1234'}};
 const codec={name:'opus/16000/1',payloadType:112,sampleRate:16000,channels:1,frameMs:20};
 const security=engine.prepareRtpSecurity(offer,codec);
 assert.equal(security.srtcpEnabled,false);
 assert.equal(security.srtcpProtect,null);
 assert.equal(security.srtcpUnprotect,null);
 security.protect.destroy();security.masterKeySalt.fill(0);
 assert.throws(()=>engine.prepareRtpSecurity({...offer,extendData:JSON.stringify({srtpMode:1,srtcp:1})},codec),/không khớp/);
});
test('answer trial builds explicit supported capabilities and confirms only matching peer ACK',()=>{
 const events=[];const engine=new IndependentCall((event,data)=>events.push({event,data}));
 engine.pending={at:Date.now(),offer:{callId:42,uidFrom:'123',uidTo:'456',uidN:'peer-name',
  sessionId:'synthetic-private-session',rtpAddress:'192.0.2.10:4200',rtcpAddress:'192.0.2.10:4200',
  extendData:JSON.stringify({srtpMode:1,srtcp:0,packetMode:2}),zrtcConfig:{srtpMode:1},
  codecs:[{name:'opus/48000/2',payload:113,frmPtime:20,dynamicFptime:0}]}};
 engine.relay={registered:true,relay:{address:'192.0.2.10',port:4200}};engine.opus={};engine.srtpSend={};
 engine.codec={name:'opus/48000/2',payloadType:113};engine.srtpProfile=1;engine.srtcpEnabled=false;
 assert.equal(engine.status().answerTrialAvailable,true);
 const answer=engine.buildAcceptedAnswer();
 assert.deepEqual(answer,{callerId:'peer-name',callId:'42',status:0,
  codec:'[{"name":"opus/48000/2","payload":113,"frmPtime":20,"dynamicFptime":0}]',
  rtpAddress:'192.0.2.10:4200',rtcpAddress:'192.0.2.10:4200',session_id:'synthetic-private-session',session:'synthetic-private-session',
  extendData:'{"packetMode":2,"srtpMode":1,"srtcp":0,"sP2P":0,"gccMode":0,"gccAudio":false,"gccSVLR":false,"gccEarlyCall":false,"tpType":0,"spTcp":0}'});
 engine.markAnswerSignalSent();
 engine.observe({act:'answer_ack',data:{callId:41}});assert.equal(engine.status().confirmed,false);
 engine.observe({act:'answer_ack',data:{callId:42}});assert.equal(engine.status().confirmed,true);
 assert.equal(engine.status().answerTrialAvailable,false);
 assert.ok(events.some(item=>item.event==='independent-confirmed'));
});
test('matching answer ACK is retained if it arrives before the HTTP answer finishes',()=>{
 const engine=new IndependentCall(()=>{});
 engine.pending={at:Date.now(),offer:{callId:42,codecs:[]}};engine.relay={registered:true};
 engine.beginAnswerSignal();
 engine.observe({act:'answer_ack',data:{callId:42}});
 assert.equal(engine.status().confirmed,true);
 engine.markAnswerSignalSent();
 assert.equal(engine.status().confirmed,true);
 assert.equal(engine.status().answerInFlight,false);
});
test('receive diagnostics count relay RTP and SRTP rejection without exposing packet contents',()=>{
 const events=[];const engine=new IndependentCall((event,data)=>events.push({event,data}));
 engine.mediaDiagnostics={relayAudio:0,relayRtcp:0,invalidHeader:0,wrongPayloadType:0,wrongSsrc:0,
  srtpAuthenticated:0,srtpRejected:0,srtpAuthFailures:0,srtpReplayRejected:0,srtpOtherRejected:0,
  invalidRtp:0,opusDecoded:0,opusDecodeFailed:0,deliveredToBrowser:0};
 engine.masterKeySalt=Buffer.alloc(30);engine.codec={payloadType:112};engine.remoteSsrc=0x1234;engine.srtpProfile=1;engine.opus={close(){}};
 engine.srtpReceive={unprotect(){throw new Error('SRTP authentication failed');},destroy(){}};
 const packet=Buffer.alloc(22);packet[0]=0x80;packet[1]=112;packet.writeUInt16BE(7,2);packet.writeUInt32BE(0x1234,8);
 engine.receiveRelayMedia({kind:'audio',payload:packet});
 assert.equal(engine.status().mediaDiagnostics.relayAudio,1);
 assert.equal(engine.status().mediaDiagnostics.srtpRejected,1);
 assert.equal(engine.status().mediaDiagnostics.srtpAuthFailures,1);
 assert.ok(!JSON.stringify(events).includes('SRTP authentication failed'));
 assert.ok(events.some(item=>item.event==='independent-media-diagnostics'));
 engine.clearRelay(false);
});
test('final media counters survive call teardown without retaining offer or packet data',()=>{
 const events=[];const engine=new IndependentCall((event,data)=>events.push({event,data}));
 engine.pending={offer:{sessionId:'private-session',callId:42,codecs:[]}};
 engine.mediaDiagnostics={relayAudio:13,srtpAuthenticated:0,srtpRejected:13,srtpAuthFailures:13,
  relayRtpSent:765,relayRtpSendErrors:0,deliveredToBrowser:0};
 engine.observe({act:'end_call'});
 const final=engine.status().lastMediaDiagnostics;
 assert.equal(final.relayAudio,13);assert.equal(final.srtpAuthFailures,13);assert.equal(final.relayRtpSent,765);
 assert.equal(engine.status().offerParsed,false);
 const ended=events.find(item=>item.event==='independent-call-ended');
 assert.deepEqual(ended.data.mediaDiagnostics,final);
 assert.ok(!JSON.stringify(ended).includes('private-session'));
});
test('browser mic PCM is held before ACK then counted as RTP sent after confirmation',()=>{
 const engine=new IndependentCall(()=>{});let sent=0;
 engine.mediaDiagnostics={browserPcmSamples:0,pcmHeldBeforeConfirmation:0,opusEncodedPackets:0,relayRtpSent:0,relayRtpSendErrors:0,
  relayAudio:0,relayRtcp:0,srtpAuthenticated:0,srtpRejected:0,srtpAuthFailures:0,srtpReplayRejected:0,srtpOtherRejected:0};
 engine.relay={registered:true,sendAudio(){sent++;}};
 engine.opus={pushBrowserPcm48k(){return [Uint8Array.from([1,2,3])];}};
 engine.srtpSend={protect(packet){return packet;}};
 engine.rtpSender={packet(){return Uint8Array.from([0x80,0x70,0,1]);}};
 assert.equal(engine.sendBrowserPcm(new Int16Array(480)),0);
 assert.equal(sent,0);
 assert.equal(engine.mediaDiagnostics.pcmHeldBeforeConfirmation,480);
 engine.confirmed=true;
 assert.equal(engine.sendBrowserPcm(new Int16Array(480)),1);
 assert.equal(sent,1);
 assert.equal(engine.mediaDiagnostics.relayRtpSent,1);
 assert.equal(engine.mediaDiagnostics.opusEncodedPackets,1);
});
test('automatic relay connection coalesces a simultaneous manual retry',async()=>{
 const engine=new IndependentCall(()=>{});let opens=0,resolve;
 engine._registerRelay=()=>{opens++;return new Promise(done=>{resolve=done;});};
 const automatic=engine.registerRelay();const retry=engine.registerRelay();
 assert.strictEqual(retry,automatic);assert.equal(opens,1);
 resolve({registered:true});await automatic;
 assert.equal(engine.relayTask,undefined);
});
test('caller relay registration uses 401 ids/session and closes before discarding call state',async()=>{
 const events=[];const engine=new IndependentCall((event,data)=>events.push({event,data}));let init,endpoint,options,closedWith;
 engine.openRelay=async (input,relay,opts)=>{init=input;endpoint=relay;options=opts;return {registered:true,close:sendEnd=>{closedWith=sendEnd;}};};
 const preflight={status:0,fromId:-12,toId:34,callId:55,sessionId:'private-outgoing-session-1234567890',
  zrtcConfig:{srtpMode:1,srtpRTCP:0,srtpKey:'abcdefghijklmnopqrstuvwxyz1234',packetMode:2},
  servers:[{rtpAddress:'127.0.0.1:1000',rtcpAddress:'127.0.0.1:1001',sent:1,recv:1}]};
 const result=await engine.registerOutgoingRelay(preflight,'34');
 assert.deepEqual(init,{isCaller:true,userId:0xfffffff4,partnerId:34,callId:55,sessionId:'private-outgoing-session-1234567890',subcommand:2});
 assert.deepEqual(endpoint,{address:'127.0.0.1',port:1000});assert.equal(typeof options.onError,'function');
 assert.equal(result.registered,true);assert.equal(result.ringing,false);assert.equal(engine.status().outgoingRelayRegistered,true);
 assert.deepEqual(engine.activeCall(),{uidN:'34',callId:55,callType:1,direction:'outgoing',stage:'relay-registered'});
 assert.equal(engine.status().browserBridgeAvailable,true);
 const mediaRequest=engine.buildOutgoingRequest();
 assert.deepEqual(mediaRequest,{calleeId:'34',callId:'55',rtpAddress:'127.0.0.1:1000',rtcpAddress:'127.0.0.1:1001',
  codec:'[{"name":"opus/16000/1","payload":112,"frmPtime":20,"dynamicFptime":0}]',session:'private-outgoing-session-1234567890',
  extendData:'{"callType":0,"newZrtc":0,"platform":2,"packetMode":2,"gccMode":0,"srtpMode":1,"sP2P":0,"srtcp":0,"gccAudio":0,"gccSVLR":0,"tpType":0,"spTcp":0,"gccEarlyCall":0}'});
 engine.beginOutgoingRequest();engine.markOutgoingRequestSent();
 engine.observe({act:'answer',data:{callId:55,status:0,params:JSON.stringify({platform:2,
  codec:'[{"name":"opus/16000/1","payload":112,"frmPtime":20}]',
  extendData:JSON.stringify({srtpMode:1,srtcp:0,packetMode:2})})}});
 assert.deepEqual(engine.prepareOutgoingAnswer(),{callId:55,calleeId:'34'});
 engine.confirmOutgoingAnswer(55);assert.equal(engine.status().confirmed,true);
 assert.ok(!JSON.stringify(events).includes('private-outgoing-session'));
 engine.clear(true);assert.equal(closedWith,true);assert.equal(engine.status().outgoingRelayRegistered,false);
});
test('caller answer parsing keeps negotiated fields private and does not confirm media by itself',async()=>{
 const events=[];const engine=new IndependentCall((event,data)=>events.push({event,data}));
 engine.outgoing={callId:55,calleeId:'34',stage:'request-sent'};
 engine.observe({act:'answer',data:{callId:'55',status:'0',params:JSON.stringify({platform:2,
  codec:'[{"name":"opus/16000/1","payload":112,"frmPtime":20}]',
  extendData:JSON.stringify({srtpMode:1,srtcp:0,srtpKey:'must-not-log'})})}});
 assert.equal(engine.outgoing.stage,'answer-received');assert.equal(engine.outgoing.answer.callId,55);
 assert.equal(engine.status().confirmed,false);
 const event=events.find(item=>item.event==='independent-outgoing-answer');
 assert.deepEqual(event.data.codecs,[{name:'opus/16000/1',payload:112,frmPtime:20,dynamicFptime:0}]);
 assert.ok(!JSON.stringify(events).includes('must-not-log'));
});
test('caller video relay keeps native callType 1 video capability in outgoing request',async()=>{
 const engine=new IndependentCall(()=>{}); let request, videoRtcp;
 engine.openRelay=async(...args)=>{request=args; return {registered:true,sendVideo(){},sendVideoRtcp(data){videoRtcp=data;},sendAudio(){},sendAudioRtcp(){},close(){}};};
 const preflight={status:0,fromId:-12,toId:34,callId:56,sessionId:'private-video-session-1234567890',
  zrtcConfig:{srtpMode:1,srtpRTCP:0,srtpKey:'abcdefghijklmnopqrstuvwxyz1234',packetMode:2},
  servers:[{rtpAddress:'127.0.0.1:1000',rtcpAddress:'127.0.0.1:1001',relayTime:1}]};
 await engine.registerOutgoingRelay(preflight,'34',3);
 assert.equal(engine.outgoing.callType,3);
 assert.equal(engine.outgoing.capabilities.callType,1);
 assert.deepEqual(engine.outgoing.capabilities.video.codec,[{name:'h264',payload:97}]);
 assert.equal(engine.buildOutgoingRequest().extendData.includes('"callType":1'),true);
 assert.equal('video' in engine.buildOutgoingRequest(),false,'params.video is opt-in after the peer regression');
 assert.equal(request[0].subcommand,2);
 assert.equal(engine.status().videoPacketMode,2);
 const rtp=engine.videoBridge.packetizer.packetize(Uint8Array.from([0,0,0,1,0x65,1,2,3]),90000)[0];
 assert.equal(new DataView(rtp.buffer).getUint32(8),preflight.fromId>>>0,'outgoing video RTP uses caller SSRC');
 assert.equal(engine.videoBridge.remoteVideoSsrc,preflight.toId,'remote video SSRC is callee');
 engine.sendVideoPli();
 const rtcpSummaries=parseCompoundRtcp(videoRtcp);
 const pli=rtcpSummaries.find(item=>item.packetType===206);
 assert.ok(pli,'PLI is carried in the compound RTCP packet');
 assert.equal(pli.senderSsrc,preflight.fromId>>>0,'PLI sender is caller');
 assert.equal(pli.mediaSsrc,preflight.toId,'PLI media SSRC is callee');
 assert.ok(rtcpSummaries.some(item=>item.packetType===200||item.packetType===201),'PLI is compound with an SR/RR');
 engine.clear();
});
test('video answer trial builds the observed H264 capability when the bridge is ready',()=>{
 const engine=new IndependentCall(()=>{});
 engine.pending={at:Date.now(),offer:{callId:77,uidFrom:'123',uidTo:'456',uidN:'peer-name',videoRequested:true,
  videoCodecs:[{name:'h264',payload:97}],sessionId:'synthetic-video-session',rtpAddress:'192.0.2.10:4200',rtcpAddress:'192.0.2.10:4200',
  extendData:JSON.stringify({srtpMode:1,srtcp:0,packetMode:2}),zrtcConfig:{srtpMode:1,packetMode:2},
  codecs:[{name:'opus/48000/2',payload:113,frmPtime:20,dynamicFptime:0}]} };
 engine.relay={registered:true,relay:{address:'192.0.2.10',port:4200}}; engine.opus={}; engine.srtpSend={}; engine.videoBridge={};
 engine.codec={name:'opus/48000/2',payloadType:113}; engine.srtpProfile=1; engine.srtcpEnabled=false;
 const answer=engine.buildAcceptedAnswer(); const capabilities=JSON.parse(answer.extendData);
 assert.equal(capabilities.callType,1); assert.deepEqual(capabilities.video.codec,[{name:'h264',payload:97}]);
});
