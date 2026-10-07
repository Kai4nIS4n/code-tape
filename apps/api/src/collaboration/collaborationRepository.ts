import * as Y from "yjs";
import { ApiFailure, tokenHash } from "../auth/accountAuthService.js";
import { SOURCE_LANGUAGES } from "../interview/secureRooms.js";
import type { AppDatabase } from "../persistence/database.js";
import { COLLABORATION_MAX_FRAME_BYTES, COLLABORATION_MAX_UPDATE_BYTES } from "@code-tape/recording-schema";

export function createCollaborationRepository(db:AppDatabase){
  const documents=new Map<string,{doc:Y.Doc;revision:number;tailCount:number;tailBytes:number}>();
  function get(roomId:string,epoch:number){
    const key=`${roomId}:${epoch}`,cached=documents.get(key);if(cached)return cached;
    const row=db.prepare("SELECT state,covered_revision FROM collaborative_documents WHERE room_id=? AND epoch=?").get(roomId,epoch) as {state:Buffer;covered_revision:number}|undefined;
    if(!row)throw new ApiFailure(409,"epoch-mismatch","workspace generation unavailable");
    const doc=emptyDocument();Y.applyUpdate(doc,new Uint8Array(row.state));
    const tail=db.prepare("SELECT bytes,revision FROM collaborative_updates WHERE room_id=? AND epoch=? ORDER BY revision").all(roomId,epoch) as Array<{bytes:Buffer;revision:number}>;
    let revision=row.covered_revision,tailBytes=0;for(const item of tail){Y.applyUpdate(doc,new Uint8Array(item.bytes));revision=item.revision;tailBytes+=item.bytes.length;}
    const loaded={doc,revision,tailCount:tail.length,tailBytes};documents.set(key,loaded);return loaded;
  }
  return {get,
    commit(input:{roomId:string;epoch:number;updateId:string;data:Uint8Array}){
      if(!/^[\w.-]{1,128}$/u.test(input.updateId))throw new ApiFailure(400,"bad-update","invalid updateId");
      if(input.data.byteLength>COLLABORATION_MAX_UPDATE_BYTES)throw new ApiFailure(413,"quota-exceeded","update exceeds 256 KiB");
      const hash=tokenHash(Buffer.from(input.data).toString("base64"));
      const receipt=db.prepare("SELECT update_hash,revision FROM update_receipts WHERE room_id=? AND epoch=? AND update_id=?").get(input.roomId,input.epoch,input.updateId) as {update_hash:string;revision:number}|undefined;
      if(receipt){if(receipt.update_hash!==hash)throw new ApiFailure(409,"update-id-conflict","updateId reused with different bytes");return {revision:receipt.revision,duplicate:true};}
      const current=get(input.roomId,input.epoch),pending=emptyDocument();
      let persisting=false;
      try{
        Y.applyUpdate(pending,Y.encodeStateAsUpdate(current.doc));Y.applyUpdate(pending,input.data);
        let sourceBytes=0;for(const [name,type]of pending.share){if(!SOURCE_LANGUAGES.some(language=>name===`source:${language}`)||!(type instanceof Y.Text))throw new ApiFailure(400,"bad-update","only the five source text roots are allowed");if(type.toDelta().some((item:{insert?:unknown;attributes?:unknown})=>typeof item.insert!=="string"||item.attributes!==undefined))throw new ApiFailure(400,"bad-update","source documents only accept unformatted text");sourceBytes+=Buffer.byteLength(type.toString());}
        const encoded=Y.encodeStateAsUpdate(pending);
        if(sourceBytes>1024*1024||encoded.byteLength>COLLABORATION_MAX_FRAME_BYTES-1024)throw new ApiFailure(413,"quota-exceeded","workspace exceeds source or CRDT state budget");
        const revision=current.revision+1,tailCount=current.tailCount+1,tailBytes=current.tailBytes+input.data.byteLength;
        const compact=tailCount>=500||tailBytes>=1024*1024;
        persisting=true;
        db.transaction(()=>{
          db.prepare("INSERT INTO collaborative_updates(room_id,epoch,revision,bytes) VALUES(?,?,?,?)").run(input.roomId,input.epoch,revision,Buffer.from(input.data));
          db.prepare("INSERT INTO update_receipts(room_id,epoch,update_id,update_hash,revision) VALUES(?,?,?,?,?)").run(input.roomId,input.epoch,input.updateId,hash,revision);
          if(compact){db.prepare("UPDATE collaborative_documents SET state=?,covered_revision=? WHERE room_id=? AND epoch=?").run(Buffer.from(encoded),revision,input.roomId,input.epoch);db.prepare("DELETE FROM collaborative_updates WHERE room_id=? AND epoch=? AND revision<=?").run(input.roomId,input.epoch,revision);}
        })();
        // Only a committed document may enter the broadcast/sync state.
        current.doc.destroy();current.doc=pending;current.revision=revision;current.tailCount=compact?0:tailCount;current.tailBytes=compact?0:tailBytes;
        return {revision,duplicate:false};
      }catch(error){pending.destroy();if(error instanceof ApiFailure)throw error;throw new ApiFailure(persisting?500:400,persisting?"storage-failed":"bad-update",persisting?"update was not saved":"invalid Yjs update");}
    },
    close(){for(const item of documents.values())item.doc.destroy();documents.clear();},
  };
}
function emptyDocument(){const doc=new Y.Doc();for(const language of SOURCE_LANGUAGES)doc.getText(`source:${language}`);return doc;}
