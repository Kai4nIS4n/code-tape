import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { ApiFailure, randomToken, tokenHash } from "../auth/accountAuthService.js";
import type { AppDatabase } from "../persistence/database.js";
import type { ObjectStorage } from "./objectStorage.js";

export function createPrivateDiskObjectStorage(input:{db:AppDatabase;directory:string;publicBaseUrl?:string;now?:()=>number}){
  const db=input.db,root=resolve(input.directory),now=input.now??Date.now,base=(input.publicBaseUrl??"").replace(/\/+$/u,"");
  const filePath=(key:string)=>resolve(root,tokenHash(key));
  const storage:ObjectStorage={
    createUploadTarget(target){
      const token=randomToken();db.prepare("INSERT INTO upload_targets(hash,object_key,mime_type,max_size,expires_at) VALUES(?,?,?,?,?)").run(tokenHash(token),target.objectKey,target.mimeType,target.maxSizeBytes,now()+30*60*1000);
      return {kind:target.kind,method:"PUT",url:`${base}/api/uploads/${token}`,headers:{"content-type":target.mimeType},maxSizeBytes:target.maxSizeBytes};
    },
    async putObject(object){
      await mkdir(root,{recursive:true});const staging=resolve(root,`.staging-${randomUUID()}`),destination=filePath(object.key);
      await writeFile(staging,object.body,{flag:"wx",mode:0o600});
      try{await rename(staging,destination);db.prepare("INSERT INTO stored_objects(object_key,mime_type,size_bytes) VALUES(?,?,?) ON CONFLICT(object_key) DO UPDATE SET mime_type=excluded.mime_type,size_bytes=excluded.size_bytes").run(object.key,object.contentType,object.body.byteLength);}catch(error){await unlink(staging).catch(()=>undefined);throw error;}
    },
    async getObject(key){const row=db.prepare("SELECT mime_type,size_bytes FROM stored_objects WHERE object_key=?").get(key) as {mime_type:string;size_bytes:number}|undefined;if(!row)return null;try{return {key,body:new Uint8Array(await readFile(filePath(key))),contentType:row.mime_type,sizeBytes:row.size_bytes};}catch(error){if((error as {code?:string}).code==="ENOENT")return null;throw error;}},
    async deleteObject(key){await unlink(filePath(key)).catch(error=>{if((error as {code?:string}).code!=="ENOENT")throw error;});db.prepare("DELETE FROM stored_objects WHERE object_key=?").run(key);},
    // Internal placeholder: a descriptor is always rewritten with a checked playback grant.
    getAssetUrl(key){return `${base}/api/private-object-unavailable/${encodeURIComponent(tokenHash(key))}`;},
  };
  return {...storage,
    async stream(key:string,request:Request):Promise<Response>{
      const row=db.prepare("SELECT mime_type,size_bytes FROM stored_objects WHERE object_key=?").get(key) as {mime_type:string;size_bytes:number}|undefined;if(!row)throw new ApiFailure(404,"not-found","asset unavailable");
      const info=await stat(filePath(key)).catch(()=>null);if(!info||info.size!==row.size_bytes)throw new ApiFailure(404,"not-found","asset unavailable");
      let start=0,end=info.size-1,status=200;const range=request.headers.get("range");
      const headers:Record<string,string>={"content-type":row.mime_type,"accept-ranges":"bytes","cache-control":"private, no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff"};
      if(range){const match=/^bytes=(\d*)-(\d*)$/u.exec(range);if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{...headers,"content-range":`bytes */${info.size}`}});if(!match[1]){const suffix=Number(match[2]);start=Math.max(0,info.size-suffix);}else{start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end);}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=info.size)return new Response(null,{status:416,headers:{...headers,"content-range":`bytes */${info.size}`}});status=206;headers["content-range"]=`bytes ${start}-${end}/${info.size}`;}
      headers["content-length"]=String(Math.max(0,end-start+1));
      const body=request.method==="HEAD"||info.size===0?null:Readable.toWeb(createReadStream(filePath(key),{start,end})) as ReadableStream<Uint8Array>;
      return new Response(body,{status,headers});
    },
  };
}
export type PrivateDiskObjectStorage=ReturnType<typeof createPrivateDiskObjectStorage>;
