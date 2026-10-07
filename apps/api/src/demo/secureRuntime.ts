import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAccountAuthService, type AccountAuthService } from "../auth/accountAuthService.js";
import { createAuthApiHandler, apiError } from "../auth/authApiHandler.js";
import { createCloudRecordingService } from "../cloud/cloudRecordingService.js";
import { createPrivateDiskObjectStorage, type PrivateDiskObjectStorage } from "../cloud/privateDiskObjectStorage.js";
import { processNextRecordingValidationJob } from "../cloud/validationWorker.js";
import { createCollaborationRepository } from "../collaboration/collaborationRepository.js";
import { createSecureWebSocketServer } from "../collaboration/secureWebSocketServer.js";
import { createCloudApiHandler } from "../http/cloudApiHandler.js";
import { createSecureCloudHandler } from "../http/secureCloudHandler.js";
import { createSecureRooms, type SecureRooms } from "../interview/secureRooms.js";
import { openAppDatabase, type AppDatabase } from "../persistence/database.js";
import { createSqliteMetadataRepository } from "../persistence/sqliteMetadataRepository.js";
import { createInterviewSignalingServer } from "../signaling/interviewSignalingServer.js";

export type SecureRuntimeOptions={dataDirectory?:string;authSecret?:string;publicBaseUrl?:string;allowedOrigins?:readonly string[];secureCookie?:boolean;createRequestId?:()=>string;testFaults?:{blockedUsers:Set<string>}};
export type SecureRuntime={db:AppDatabase;auth:AccountAuthService;rooms:SecureRooms;storage:PrivateDiskObjectStorage;sockets:ReturnType<typeof createSecureWebSocketServer>;handler(request:Request):Promise<Response>;close():void};
export function createSecureRuntime(options:SecureRuntimeOptions):SecureRuntime{
  if(options.testFaults&&process.env.NODE_ENV!=="test")throw new Error("testFaults are only available in NODE_ENV=test");
  const directory=resolve(options.dataDirectory??process.env.CODE_TAPE_DATA_DIR??".code-tape-data");
  mkdirSync(directory,{recursive:true,mode:0o700});
  const secret=options.authSecret??process.env.CODE_TAPE_AUTH_SECRET??readDevelopmentSecret(directory);
  const db=openAppDatabase(resolve(directory,"code-tape.sqlite")),metadata=createSqliteMetadataRepository(db),storage=createPrivateDiskObjectStorage({db,directory:resolve(directory,"objects"),publicBaseUrl:options.publicBaseUrl});
  let sockets:ReturnType<typeof createSecureWebSocketServer>|undefined;
  const auth=createAccountAuthService({db,secret,onRevoke:sid=>sockets?.closeSession(sid)});
  const allowedOrigins=options.allowedOrigins??(process.env.CODE_TAPE_ALLOWED_ORIGINS??"").split(",").map(value=>value.trim()).filter(Boolean);
  const authHandler=createAuthApiHandler({auth,allowedOrigins,secureCookie:options.secureCookie??process.env.NODE_ENV==="production"});
  const rooms=createSecureRooms({db,auth,onRoomClosed:id=>sockets?.closeRoom(id),onMemberRemoved:(roomId,userId)=>sockets?.removeMember(roomId,userId)});
  const cloud=createCloudApiHandler({service:createCloudRecordingService({metadata,objectStorage:storage,createId:prefix=>`${prefix}-${randomUUID()}`}),resolveOwnerId:async request=>(await auth.authenticate(request))?.user.id??null,allowLegacyAuth:false,createRequestId:options.createRequestId});
  const secureCloud=createSecureCloudHandler({db,metadata,storage,auth,cloud,publicBaseUrl:options.publicBaseUrl});
  sockets=createSecureWebSocketServer({rooms,repository:createCollaborationRepository(db),signaling:createInterviewSignalingServer({rooms:rooms.legacy}),allowedOrigins,testBlockedUsers:options.testFaults?.blockedUsers});
  let validating=false;
  async function drainValidation(){if(validating)return;validating=true;try{while(true){const result=await processNextRecordingValidationJob({metadata,objectStorage:storage});if(!result.ok&&"reason"in result)break;}}finally{validating=false;}}
  // A processing recording is itself the durable, re-entrant validation queue.
  const interval=setInterval(()=>{void drainValidation().catch(()=>undefined);},1000);interval.unref();void drainValidation().catch(()=>undefined);
  return {db,auth,rooms,storage,sockets,
    async handler(request:Request):Promise<Response>{
      try{
        const path=new URL(request.url).pathname;
        if(path.startsWith("/api/auth/"))return await authHandler(request);
        if(path.startsWith("/api/interviews/"))return await rooms.handler(request);
        const response=await secureCloud(request);if(response.ok&&request.method==="POST"&&/^\/api\/recordings\/upload-sessions\/[^/]+\/complete$/u.test(path))await drainValidation();return response;
      }catch(error){return apiError(error);}
    },
    close(){clearInterval(interval);sockets?.close();db.close();},
  };
}
function readDevelopmentSecret(directory:string):string{
  if(process.env.NODE_ENV==="production")throw new Error("CODE_TAPE_AUTH_SECRET is required in production");
  const path=resolve(directory,"auth-secret");if(existsSync(path))return readFileSync(path,"utf8").trim();
  const secret=randomBytes(48).toString("base64url");writeFileSync(path,secret,{flag:"wx",mode:0o600});return secret;
}
