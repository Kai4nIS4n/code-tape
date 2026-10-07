import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { createSecureRuntime } from "../secureRuntime.js";
import { createCollaborationRepository } from "../../collaboration/collaborationRepository.js";
import type { CloudRecordingRecord, CloudRecordingShareLinkRecord } from "../../cloud/types.js";
import { createSqliteMetadataRepository } from "../../persistence/sqliteMetadataRepository.js";
import { tokenHash } from "../../auth/accountAuthService.js";

const secret="secure-runtime-test-secret-at-least-32-bytes";
type Login={user:{id:string;username:string};accessToken:string;expiresAt:number};
const base="http://localhost";
function request(path:string,options:{method?:string;body?:unknown;accessToken?:string;cookie?:string;headers?:Record<string,string>}={}){
  return new Request(`${base}${path}`,{method:options.method??"GET",headers:{origin:base,"content-type":"application/json","x-code-tape-client":"web",...(options.accessToken?{authorization:`Bearer ${options.accessToken}`}:{}) ,...(options.cookie?{cookie:options.cookie}:{}),...options.headers},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
}
async function register(runtime:ReturnType<typeof createSecureRuntime>,username:string){const response=await runtime.handler(request("/api/auth/register",{method:"POST",body:{username,password:"password-for-test"}}));assert.equal(response.status,201);return {login:await response.json() as Login,cookie:response.headers.get("set-cookie")!.split(";")[0]!};}

test("secure runtime uses standard JWT, rotates refresh and revokes session without legacy fallback",async()=>{
  const runtime=createSecureRuntime({dataDirectory:await mkdtemp(join(tmpdir(),"codetape-auth-")),authSecret:secret});
  try{
    const {login,cookie}=await register(runtime,"alice");assert.equal(login.accessToken.split(".").length,3);assert.ok(login.expiresAt>Date.now());
    const row=runtime.db.prepare("SELECT password_hash FROM users WHERE id=?").get(login.user.id) as {password_hash:string};assert.ok(row.password_hash.startsWith("$argon2id$"));
    assert.equal((await runtime.handler(request("/api/auth/me",{accessToken:login.accessToken}))).status,200);
    assert.equal((await runtime.handler(request("/api/recordings",{headers:{"x-owner-token":login.user.id}}))).status,401);
    assert.equal((await runtime.handler(request("/api/auth/token",{method:"POST",body:{refreshToken:login.user.id}}))).status,404);
    assert.equal((await runtime.handler(request("/api/auth/refresh",{method:"POST",body:{},cookie,headers:{origin:"https://hostile.invalid"}}))).status,403);
    const fresh=await runtime.handler(request("/api/auth/refresh",{method:"POST",body:{},cookie}));assert.equal(fresh.status,200);
    const raced=await runtime.handler(request("/api/auth/refresh",{method:"POST",body:{},cookie}));assert.equal(raced.status,409);assert.equal(raced.headers.get("set-cookie"),null);
    const nextCookie=fresh.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await runtime.handler(request("/api/auth/logout",{method:"POST",body:{},cookie:nextCookie}))).status,200);
    assert.equal((await runtime.handler(request("/api/auth/me",{accessToken:login.accessToken}))).status,401);
  }finally{runtime.close();}
});

test("room membership, one-use purpose-bound ticket and durable Yjs updates survive restart",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"codetape-room-"));let runtime=createSecureRuntime({dataDirectory:directory,authSecret:secret});
  try{
    const alice=(await register(runtime,"alice")).login,bob=(await register(runtime,"bobby")).login,charlie=(await register(runtime,"charlie")).login;
    const response=await runtime.handler(request("/api/interviews/rooms",{method:"POST",accessToken:alice.accessToken,body:{documents:{javascript:"const original = 1;"}}}));assert.equal(response.status,201);
    const created=await response.json() as {roomId:string;joinCode:string;epoch:number};
    assert.equal((await runtime.handler(request(`/api/interviews/rooms/${created.roomId}`,{accessToken:bob.accessToken}))).status,403);
    assert.equal((await runtime.handler(request(`/api/interviews/rooms/${created.roomId}/join`,{method:"POST",accessToken:bob.accessToken,body:{joinCode:created.joinCode}}))).status,200);
    assert.equal((await runtime.handler(request(`/api/interviews/rooms/${created.roomId}/join`,{method:"POST",accessToken:charlie.accessToken,body:{joinCode:created.joinCode}}))).status,403);
    const issue=await runtime.handler(request(`/api/interviews/rooms/${created.roomId}/ws-tickets`,{method:"POST",accessToken:bob.accessToken,body:{purpose:"collaboration"}}));const {ticket}=await issue.json() as {ticket:string};
    assert.throws(()=>runtime.rooms.consumeTicket(ticket,created.roomId,"signaling"));
    assert.equal(runtime.rooms.consumeTicket(ticket,created.roomId,"collaboration").user.id,bob.user.id);
    assert.throws(()=>runtime.rooms.consumeTicket(ticket,created.roomId,"collaboration"));
    const repository=createCollaborationRepository(runtime.db),state=repository.get(created.roomId,1),local=new Y.Doc();Y.applyUpdate(local,Y.encodeStateAsUpdate(state.doc));const vector=Y.encodeStateVector(local);local.getText("source:javascript").insert(0,"// offline edit\n");const update=Y.encodeStateAsUpdate(local,vector);
    const committed=repository.commit({roomId:created.roomId,epoch:1,updateId:"update-1",data:update});assert.equal(committed.revision,1);
    assert.deepEqual(repository.commit({roomId:created.roomId,epoch:1,updateId:"update-1",data:update}),{revision:1,duplicate:true});
    assert.throws(()=>repository.commit({roomId:created.roomId,epoch:1,updateId:"update-1",data:new Uint8Array([0,0])}));
    const malicious=new Y.Doc();malicious.getMap("secret-root").set("x",1);assert.throws(()=>repository.commit({roomId:created.roomId,epoch:1,updateId:"bad-root",data:Y.encodeStateAsUpdate(malicious)}));
    assert.equal(repository.get(created.roomId,1).revision,1);repository.close();local.destroy();malicious.destroy();
    runtime.close();runtime=createSecureRuntime({dataDirectory:directory,authSecret:secret});
    assert.equal((await runtime.handler(request("/api/auth/me",{accessToken:alice.accessToken}))).status,200);
    const reopened=createCollaborationRepository(runtime.db);assert.equal(reopened.get(created.roomId,1).doc.getText("source:javascript").toString(),"// offline edit\nconst original = 1;");assert.equal(reopened.get(created.roomId,1).revision,1);reopened.close();
  }finally{runtime.close();}
});

test("owner/share grants protect actual GET HEAD Range and are revoked with their source",async()=>{
  const runtime=createSecureRuntime({dataDirectory:await mkdtemp(join(tmpdir(),"codetape-assets-")),authSecret:secret});
  try{
    const alice=await register(runtime,"alice"),bob=await register(runtime,"bobby"),metadata=createSqliteMetadataRepository(runtime.db),now=new Date().toISOString();
    const recording:CloudRecordingRecord={id:"recording-private",ownerId:alice.login.user.id,localPackageId:"local-1",title:"private",schemaVersion:"0.1.0",status:"ready",visibility:"private",createdAt:now,updatedAt:now,completedAt:now,deletedAt:null,durationMs:1000,initialLanguage:"javascript",hasAudio:true,hasCamera:false,totalSizeBytes:10,eventCount:0,snapshotCount:0,failureCode:null,failureMessage:null};
    const kinds=["manifest","meta","events","snapshots","media","thumbnail"] as const;
    await metadata.createUpload({recording,session:{id:"upload-1",recordingId:recording.id,ownerId:recording.ownerId,status:"completed",expiresAt:now,idempotencyKey:"asset-fixture",createdAt:now,completedAt:now},assets:kinds.map(kind=>({id:`asset-${kind}`,recordingId:recording.id,kind,objectKey:`private/${kind}`,sha256:"0".repeat(64),sizeBytes:10,mimeType:kind==="media"?"video/webm":"application/json",uploadedAt:now,validatedAt:now}))});
    for(const kind of kinds)await runtime.storage.putObject({key:`private/${kind}`,body:new TextEncoder().encode("0123456789"),contentType:kind==="media"?"video/webm":"application/json"});
    assert.equal((await runtime.handler(request(`/api/recordings/${recording.id}/playback`,{accessToken:bob.login.accessToken}))).status,404);
    const owned=await runtime.handler(request(`/api/recordings/${recording.id}/playback`,{accessToken:alice.login.accessToken})),descriptor=await owned.json() as {mediaUrl:string;thumbnailUrl:string};assert.equal(owned.status,200);
    const media=await runtime.handler(request(descriptor.mediaUrl,{headers:{range:"bytes=2-5"}}));assert.equal(media.status,206);assert.equal(media.headers.get("content-range"),"bytes 2-5/10");assert.equal(await media.text(),"2345");
    const head=await runtime.handler(request(descriptor.mediaUrl,{method:"HEAD"}));assert.equal(head.status,200);assert.equal(head.headers.get("content-length"),"10");assert.equal(await head.text(),"");
    assert.equal((await runtime.handler(request("/dev/object-storage/objects/cHJpdmF0ZS9tZWRpYQ"))).status,404);
    const link:CloudRecordingShareLinkRecord={id:"share-1",recordingId:recording.id,tokenHash:tokenHash("share-token"),createdBy:recording.ownerId,createdAt:now,expiresAt:null,revokedAt:null};await metadata.createShareLink(link);
    const shared=await runtime.handler(request("/api/share/share-token/playback")),shareDescriptor=await shared.json() as {mediaUrl:string;thumbnailUrl:string};assert.equal(shared.status,200);
    assert.equal((await runtime.handler(request(shareDescriptor.thumbnailUrl))).status,200);
    assert.equal((await runtime.handler(request(`/api/recordings/${recording.id}/share-links/share-1`,{method:"DELETE",accessToken:alice.login.accessToken}))).status,200);
    assert.equal((await runtime.handler(request(shareDescriptor.mediaUrl,{headers:{range:"bytes=0-2"}}))).status,403);assert.equal((await runtime.handler(request(shareDescriptor.thumbnailUrl,{method:"HEAD"}))).status,403);
    await runtime.handler(request("/api/auth/logout",{method:"POST",body:{},cookie:alice.cookie}));assert.equal((await runtime.handler(request(descriptor.mediaUrl))).status,403);
  }finally{runtime.close();}
});
