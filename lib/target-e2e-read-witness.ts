/** Content-free, request-scoped proof for isolated browser-test builds only.
 * The opaque ID is sent in a harmless same-origin request header so CDP can
 * associate a parsed-body mark with exactly the request it observed. */
export const TARGET_E2E_READ_WITNESS_HEADER="x-lumi-e2e-read-id";

export function targetE2eReadWitness():string|null{
  if(process.env.NEXT_PUBLIC_LUMI_E2E_QUEUE_WITNESS!=="1"||typeof window==="undefined")
    return null;
  try{return crypto.randomUUID();}catch{return null;}
}

export function targetE2eReadHeaders(id:string|null):Record<string,string>{
  return id?{[TARGET_E2E_READ_WITNESS_HEADER]:id}:{};
}

export function markTargetE2eRead(kind:string,id:string|null):void{
  if(!id)return;
  try{performance.mark("lumi-e2e:"+kind+":"+id);}catch{/* passive test witness */}
}
