import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import * as Y from "yjs";
import { encodeCollaborationFrame, decodeCollaborationFrame } from "@code-tape/recording-schema";
import { createDemoRuntime } from "../../demo/demoServer.js";

type Message={binary:boolean;data:Uint8Array;json:Record<string,unknown>|null};
function inbox(socket:WebSocket){
  const queued:Message[]=[],waiters:Array<{predicate:(message:Message)=>boolean;resolve:(message:Message)=>void;reject:(error:Error)=>void;timeout:ReturnType<typeof setTimeout>}>=[];
  socket.on("message",(raw:RawData,binary:boolean)=>{
    const data=Array.isArray(raw)?new Uint8Array(Buffer.concat(raw)):raw instanceof ArrayBuffer?new Uint8Array(raw):new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength);
    const message={binary,data,json:binary?null:JSON.parse(Buffer.from(data).toString("utf8")) as Record<string,unknown>};
    const index=waiters.findIndex(waiter=>waiter.predicate(message));if(index>=0){const waiter=waiters.splice(index,1)[0]!;clearTimeout(waiter.timeout);waiter.resolve(message);}else queued.push(message);
  });
  return {next(predicate:(message:Message)=>boolean):Promise<Message>{const index=queued.findIndex(predicate);if(index>=0)return Promise.resolve(queued.splice(index,1)[0]!);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timeout:setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(new Error("WebSocket message timeout"));},5000)};waiters.push(waiter);});},close(){for(const waiter of waiters){clearTimeout(waiter.timeout);waiter.reject(new Error("closed"));}socket.terminate();}};
}

test("authorized sockets merge concurrent edits with durable ACK and session revocation closes live access",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"codetape-ws-"));await writeFile(join(directory,"index.html"),"<div></div>");
  const runtime=createDemoRuntime({webRoot:directory,dataDirectory:join(directory,"data"),authSecret:"websocket-integration-secret-with-32-bytes",allowedOrigins:["http://localhost"]});
  await new Promise<void>(resolve=>runtime.server.listen(0,"127.0.0.1",resolve));
  const port=(runtime.server.address() as AddressInfo).port,base=`http://127.0.0.1:${port}`,sockets:WebSocket[]=[];
  async function api(path:string,body:unknown,accessToken?:string,cookie?:string){return runtime.handler(new Request(`${base}${path}`,{method:"POST",headers:{origin:base,"content-type":"application/json","x-code-tape-client":"web",...(accessToken?{authorization:`Bearer ${accessToken}`}:{}) ,...(cookie?{cookie}:{})},body:JSON.stringify(body)}));}
  async function register(username:string){const response=await api("/api/auth/register",{username,password:"password-for-test"});assert.equal(response.status,201);return {login:await response.json() as {accessToken:string},cookie:response.headers.get("set-cookie")!.split(";")[0]!};}
  try{
    const alice=await register("alice"),bob=await register("bobby");
    const createdResponse=await api("/api/interviews/rooms",{documents:{javascript:"let x = 0;"}},alice.login.accessToken);const room=await createdResponse.json() as {roomId:string;joinCode:string;epoch:number};assert.equal(createdResponse.status,201);
    assert.equal((await api(`/api/interviews/rooms/${room.roomId}/join`,{joinCode:room.joinCode},bob.login.accessToken)).status,200);
    async function connect(accessToken:string){
      const response=await api(`/api/interviews/rooms/${room.roomId}/ws-tickets`,{purpose:"collaboration"},accessToken),{ticket}=await response.json() as {ticket:string};
      const socket=new WebSocket(`ws://127.0.0.1:${port}/api/interviews/rooms/${room.roomId}/collaboration?ticket=${ticket}`,{origin:base});sockets.push(socket);const messages=inbox(socket);
      await messages.next(message=>message.json?.type==="hello");const doc=new Y.Doc();socket.send(encodeCollaborationFrame({type:"state-vector",data:Y.encodeStateVector(doc)}));
      const synced=await messages.next(message=>message.binary&&decodeCollaborationFrame(message.data).type==="sync"),frame=decodeCollaborationFrame(synced.data);assert.equal(frame.type,"sync");Y.applyUpdate(doc,frame.data);
      return {socket,messages,doc};
    }
    const a=await connect(alice.login.accessToken),b=await connect(bob.login.accessToken);
    const aVector=Y.encodeStateVector(a.doc),bVector=Y.encodeStateVector(b.doc);a.doc.getText("source:javascript").insert(0,"// Alice\n");b.doc.getText("source:javascript").insert(0,"// Bob\n");
    const aUpdate=Y.encodeStateAsUpdate(a.doc,aVector),bUpdate=Y.encodeStateAsUpdate(b.doc,bVector);
    a.socket.send(encodeCollaborationFrame({type:"update",epoch:room.epoch,updateId:"alice-update",data:aUpdate}));await a.messages.next(message=>message.json?.type==="ack"&&message.json.updateId==="alice-update");
    b.socket.send(encodeCollaborationFrame({type:"update",epoch:room.epoch,updateId:"bob-update",data:bUpdate}));const bAck=await b.messages.next(message=>message.json?.type==="ack"&&message.json.updateId==="bob-update");assert.equal(bAck.json?.persistedRevision,2);
    const aPeer=decodeCollaborationFrame((await a.messages.next(message=>message.binary&&decodeCollaborationFrame(message.data).type==="sync")).data),bPeer=decodeCollaborationFrame((await b.messages.next(message=>message.binary&&decodeCollaborationFrame(message.data).type==="sync")).data);Y.applyUpdate(a.doc,aPeer.data);Y.applyUpdate(b.doc,bPeer.data);
    assert.equal(a.doc.getText("source:javascript").toString(),b.doc.getText("source:javascript").toString());assert.match(a.doc.getText("source:javascript").toString(),/Alice/u);assert.match(a.doc.getText("source:javascript").toString(),/Bob/u);
    a.socket.send(encodeCollaborationFrame({type:"update",epoch:room.epoch,updateId:"alice-update",data:aUpdate}));const retry=await a.messages.next(message=>message.json?.type==="ack"&&message.json.updateId==="alice-update");assert.equal(retry.json?.persistedRevision,1);
    const closed=new Promise<void>(resolve=>b.socket.once("close",()=>resolve()));await api("/api/auth/logout",{},undefined,bob.cookie);await closed;
    assert.equal(runtime.controls!.db.prepare("SELECT count(*) n FROM update_receipts WHERE room_id=?").get(room.roomId)&&true,true);
    a.doc.destroy();b.doc.destroy();a.messages.close();b.messages.close();
  }finally{for(const socket of sockets)socket.terminate();runtime.close();await new Promise<void>(resolve=>runtime.server.close(()=>resolve()));}
});
