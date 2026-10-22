import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ZaloSession } from '../zalo-session.mjs';
import { safeCallError } from '../outgoing-diagnostics.mjs';
function fixture() {
    const listener = new EventEmitter(); let starts = 0;
    listener.start = () => { starts++; };
    listener.stop = () => listener.emit('disconnected', 1000);
    const api = { listener, getContext: () => ({ uid: 'test' }), custom() {} };
    const events = [], sent = [];
    const session = new ZaloSession((event, data) => events.push({event,data}), () => ({ready:true,send:async data => sent.push(data)}), () => true);
    session.attachApi(api);
    return {session,listener,events,sent,starts:()=>starts};
}
test('online reflects event socket, duplicate disconnection is visible and can be reconnected', () => {
    const f = fixture();
    try {
        assert.equal(f.session.state, 'connecting');
        f.listener.emit('connected');
        assert.equal(f.session.state, 'online');
        f.listener.emit('disconnected', 3000);
        assert.equal(f.session.state, 'disconnected');
        assert.equal(f.events.at(-1).data.code, 3000);
        assert.equal(f.session.retryTimer, undefined);
        f.session.reconnect();
        assert.equal(f.starts(), 2);
        assert.equal(f.session.state, 'connecting');
        f.listener.emit('connected');
        assert.equal(f.session.state, 'online');
    } finally { f.session.logout(); }
    assert.equal(f.session.state, 'offline');
});
test('disconnect clears pending ringing and logout cancels transient reconnect', () => {
    const f=fixture();
    f.listener.emit('connected');
    f.listener.emit('call', {act:'request', data:{}});
    assert.ok(f.session.pendingControl);
    f.listener.emit('disconnected', 1006);
    assert.equal(f.session.pendingControl, null);
    assert.ok(f.session.retryTimer);
    f.session.logout();
    assert.equal(f.session.state,'offline');
    assert.equal(f.session.api,null);
});
test('safe control-batch diagnostics reach the demo without event payloads', () => {
    const f = fixture();
    const summary = { validBatch: true, controlCount: 2, voipCount: 1, actions: ['voip:request', 'group:join'] };
    f.listener.emit('call_control_batch', summary);
    assert.deepEqual(f.events.at(-1), { event: 'zalo-control-batch', data: summary });
    assert.equal(JSON.stringify(f.events).includes('uidN'), false);
    f.session.logout();
});
test('independent answer sends only a sanitized signaling result without requiring a native helper',async()=>{
 const events=[];let sent;
 const session=new ZaloSession((event,data)=>events.push({event,data}),()=>null,()=>false);
 session.state='online';session.api={voiceCall:{answer:async payload=>{sent=payload;return {error_code:0,data:{secret:'never-forward-this'}};}}};
 const payload={callerId:'peer-name',callId:'42',status:0,codec:'[]',rtpAddress:'192.0.2.10:4200',
  rtcpAddress:'192.0.2.10:4200',session_id:'private-session',extendData:'{}'};
 assert.deepEqual(await session.answerIndependent(payload),{responseReceived:true,responseAccepted:true,peerConfirmed:false,responseCode:0});
 assert.deepEqual(sent,payload);
 assert.deepEqual(events,[{event:'zalo-signal',data:{command:402,action:'answer',success:true}}]);
 session.api=null;
 await assert.rejects(session.answerIndependent(payload),/Kết nối tài khoản/);
});
test('independent hangup sends HTTP endcall with caller identity and hides the response body',async()=>{
 const events=[];let sent;
 const session=new ZaloSession((event,data)=>events.push({event,data}),()=>null,()=>false);
 session.state='online';session.api={voiceCall:{end:async(uidTo,callId)=>{sent={uidTo,callId};return {error_code:0,data:{secret:'never-forward-this'}};}}};
 assert.deepEqual(await session.endCall('caller-noised-id','42'),{signalSent:true,responseCode:0});
 assert.deepEqual(sent,{uidTo:'caller-noised-id',callId:'42'});
 assert.deepEqual(events,[{event:'zalo-signal',data:{command:409,action:'endcall',success:true}}]);
 await assert.rejects(session.endCall('','42'),/Thiếu callerId/);
 session.state='offline';
 await assert.rejects(session.endCall('caller-noised-id','42'),/Zalo chưa kết nối/);
});
test('caller setup can be cancelled before the peer-facing request is sent',async()=>{
 const events=[];let sent;
 const session=new ZaloSession((event,data)=>events.push({event,data}),()=>null,()=>false);
 session.state='online';session.api={voiceCall:{cancel:async(...args)=>{sent=args;return {error_code:0,data:{secret:'never-forward-this'}};}}};
 assert.deepEqual(await session.cancelOutgoingCall('123','42',1),{signalSent:true,responseCode:0});
 assert.deepEqual(sent,['123','42',1]);
 assert.deepEqual(events,[{event:'zalo-signal',data:{command:405,action:'cancel',success:true}}]);
 assert.equal(JSON.stringify(events).includes('never-forward-this'),false);
});
test('caller sends negotiated 416 only through the explicit media-request phase',async()=>{
 const events=[];let sent;
 const session=new ZaloSession((event,data)=>events.push({event,data}),()=>null,()=>false);
 session.state='online';session.api={voiceCall:{request:async payload=>{sent=payload;return {accepted:true,secret:'never-forward-this'};}}};
 const payload={calleeId:'123',callId:'42',rtpAddress:'192.0.2.1:1000',rtcpAddress:'192.0.2.1:1001',
  codec:'[{"name":"opus/16000/1","payload":112}]',session:'private-session',extendData:'{"srtpMode":1}'};
 assert.deepEqual(await session.requestOutgoingMedia(payload),{requestAccepted:true,responseCode:null});
 assert.deepEqual(sent,payload);
 assert.deepEqual(events,[
  {event:'outgoing-call-stage',data:{flow:'invite',stage:'request-start'}},
  {event:'zalo-signal',data:{command:416,action:'request',success:true}},
  {event:'outgoing-call-stage',data:{flow:'invite',stage:'request-accepted'}},
 ]);
 assert.equal(JSON.stringify(events).includes('private-session'),false);
});
test('caller acknowledges a matching accepted answer with signaling command 408',async()=>{
 const events=[];let sent;
 const session=new ZaloSession((event,data)=>events.push({event,data}),()=>null,()=>false);
 session.state='online';session.api={voiceCall:{answerAck:async(...args)=>{sent=args;return {result:true};}}};
 assert.deepEqual(await session.acknowledgeOutgoingAnswer('123','42'),{responseCode:null});
 assert.deepEqual(sent,['123','42']);
 assert.deepEqual(events,[{event:'zalo-signal',data:{command:408,action:'answerack',success:true}}]);
});
test('friend picker receives only IDs and display names', async () => {
 const session=new ZaloSession(()=>{},()=>null,()=>false);
 session.state='online';
 session.api={getAllFriends:async(count,page)=>{
  assert.deepEqual([count,page],[200,1]);
  return [
   {userId:'123',displayName:'Alice',phoneNumber:'private',userKey:'secret'},
   {userId:'invalid',displayName:'Skip'},
   {userId:'456',zaloName:'Bob',phoneNumber:'private'},
  ];
 }};
 assert.deepEqual(await session.listFriends(),[
  {id:'123',name:'Alice'},
  {id:'456',name:'Bob'},
 ]);
 session.state='offline';
 await assert.rejects(session.listFriends(),/Kết nối tài khoản/);
});
test('outgoing call parses the first requestcall response, hides media secrets, and never claims ringing', async () => {
 const events=[];let sent;
 const session=new ZaloSession((event,data)=>events.push({event,data}),()=>null,()=>false);
 session.state='online';
 session.api={voiceCall:{requestCall:async payload=>{sent=payload;return {status:0,fromId:12,toId:123,id:42,protocol:1,
  sessId:'private-session',zrtc_config:{srtpMode:1,srtpKey:'never-forward-this'},
  servers:[{rtpaddr:'192.0.2.1:1000',rtcpaddr:'192.0.2.1:1001',relayTime:12,sent:'ignored',recv:null}]};}}};
 let internalPreflight;
 assert.deepEqual(await session.requestOutgoingCall('123','42',async value=>{internalPreflight=value;return {registered:true};}),{
  stage:'caller-relay-registered',callId:'42',status:0,relayCandidates:1,zrtcConfigPresent:true,
  configKeys:['srtpMode','srtpKey'],callerRelayRegistered:true,ringing:false,mediaReady:false,next:'start-browser-mic-then-send-request',
 });
 assert.equal(internalPreflight.sessionId,'private-session');
 assert.deepEqual(sent,{calleeId:'123',callId:'42',typeRequest:1,codec:'[]'});
 assert.deepEqual(events,[
  {event:'outgoing-call-stage',data:{flow:'preflight',stage:'requestcall-start'}},
  {event:'outgoing-call-stage',data:{flow:'preflight',stage:'response-parsed',status:0,relayCandidates:1,zrtcConfigPresent:true}},
  {event:'outgoing-call-stage',data:{flow:'relay',stage:'registration-start',relayCandidates:1}},
  {event:'zalo-outgoing-preflight',data:{callId:'42',status:0,relayCandidates:1,
   zrtcConfigPresent:true,configKeys:['srtpMode','srtpKey'],callerRelayRegistered:true}},
  {event:'outgoing-call-stage',data:{flow:'relay',stage:'caller-relay-ready',relayCandidates:1,callerRelayRegistered:true}},
 ]);
 assert.equal(JSON.stringify(events).includes('never-forward-this'),false);
 await assert.rejects(session.requestOutgoingCall('not-an-id','42'),/người bạn hợp lệ/);
 session.state='offline';
 await assert.rejects(session.requestOutgoingCall('123','42'),/Kết nối tài khoản/);
});
test('outgoing preflight records the failing phase and redacts sensitive error details', async () => {
 const events=[];
 const session=new ZaloSession((event,data)=>events.push({event,data}),()=>null,()=>false);
 session.state='online';
 session.api={voiceCall:{requestCall:async()=>{throw Object.assign(new Error('session=private-session-key failed at 192.0.2.44:8020 token=private-token-12345678901234567890'),{code:'ETIMEDOUT'});}}};
 await assert.rejects(session.requestOutgoingCall('123','42'),/private-session-key/);
 assert.deepEqual(events.map(x=>x.event),['outgoing-call-stage','outgoing-call-error']);
 assert.equal(events[1].data.stage,'requestcall');
 assert.equal(events[1].data.errorCode,'ETIMEDOUT');
 assert.equal(JSON.stringify(events).includes('private-session-key'),false);
 assert.equal(JSON.stringify(events).includes('private-token'),false);
 assert.equal(JSON.stringify(events).includes('192.0.2.44'),false);
});
test('outgoing relay failure is tagged separately from requestcall failure', async () => {
 const events=[];
 const session=new ZaloSession((event,data)=>events.push({event,data}),()=>null,()=>false);
 session.state='online';
 session.api={voiceCall:{requestCall:async()=>({status:0,fromId:12,toId:123,id:42,protocol:1,sessId:'private-session',
  zrtc_config:{srtpMode:1},servers:[{rtpaddr:'192.0.2.1:1000',rtcpaddr:'192.0.2.1:1001',relayTime:12,sent:'ignored',recv:null}]})}};
 await assert.rejects(session.requestOutgoingCall('123','42',async()=>{throw new Error('relay timed out');}),/relay timed out/);
 const failure=events.find(x=>x.event==='outgoing-call-error');
 assert.equal(failure.data.flow,'relay');
 assert.equal(failure.data.stage,'registration');
 assert.equal(failure.data.message,'relay timed out');
});
test('safe call error details redact tokens, IDs, and relay addresses', () => {
 const details=safeCallError(Object.assign(new Error('token=abc-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 session=my-session-1234567 user 12345678 from 192.0.2.1:443'),{code:7}));
 assert.equal(details.errorCode,7);
 assert.equal(details.message.includes('abc-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'),false);
 assert.equal(details.message.includes('my-session'),false);
 assert.equal(details.message.includes('192.0.2.1'),false);
 assert.match(details.message,/\[redacted\]/);
 assert.match(details.message,/\[address\]/);
 assert.match(details.message,/\[id\]/);
});
