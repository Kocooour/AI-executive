/**
 * C17 strict browser-evidence decision. This is intentionally pure:
 * unit tests exercise synthetic DATA, never simulated browser lifecycle
 * events. The real witness is the independent native Chrome/CDP harness.
 */
export type NativeCacheNotUsedEvent={
  frameId?:string;
  loaderId?:string;
  reasons:{reason:string;type?:string}[];
};
export type NativeBackEvidence={
  initialPageShowObserved:boolean;
  postBackPageShowObserved:boolean;
  persisted:boolean|null|undefined;
  originalDocumentToken:string|null|undefined;
  returnedDocumentToken:string|null|undefined;
  topFrameId:string|null|undefined;
  returnedLoaderId:string|null|undefined;
  backReasonStartIndex:number|null|undefined;
  cacheNotUsed:readonly NativeCacheNotUsedEvent[];
};

export function matchingNativeBackReasons(evidence:NativeBackEvidence){
  const {topFrameId,returnedLoaderId,backReasonStartIndex,cacheNotUsed}=evidence;
  if(!topFrameId||!returnedLoaderId||
     backReasonStartIndex===null||backReasonStartIndex===undefined||
     !Number.isSafeInteger(backReasonStartIndex)||
     backReasonStartIndex<0||backReasonStartIndex>cacheNotUsed.length)return [];
  return cacheNotUsed.slice(backReasonStartIndex)
    .filter(event=>event.frameId===topFrameId&&event.loaderId===returnedLoaderId)
    .flatMap(event=>event.reasons)
    .filter(reason=>typeof reason.reason==="string"&&reason.reason.trim().length>0);
}

export function validateNativeBackEvidence(
  evidence:NativeBackEvidence,{strict=true}:{strict?:boolean}={}
):"restored"|"not_restored"{
  if(!evidence.initialPageShowObserved)
    throw Error("Missing real initial pageshow");
  if(!evidence.postBackPageShowObserved)
    throw Error("Missing real post-Back pageshow");
  if(typeof evidence.persisted!=="boolean")
    throw Error("Post-Back pageshow persisted value is not boolean");
  if(typeof evidence.originalDocumentToken!=="string"||
     !evidence.originalDocumentToken||
     typeof evidence.returnedDocumentToken!=="string"||
     !evidence.returnedDocumentToken)
    throw Error("Missing original/returned document token");
  if(evidence.persisted){
    if(evidence.returnedDocumentToken!==evidence.originalDocumentToken)
      throw Error("Restored page did not retain the original document token");
    return "restored";
  }
  if(evidence.returnedDocumentToken===evidence.originalDocumentToken)
    throw Error("Cache miss reused the original document token");
  if(strict&&matchingNativeBackReasons(evidence).length===0)
    throw Error("Unexplained native cache miss for the returned top-level loader");
  return "not_restored";
}
