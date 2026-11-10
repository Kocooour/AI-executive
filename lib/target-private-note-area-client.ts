/** R3-CAPTURE-1: no-store, strict private Area chooser transport.
 * Titles/ids live in memory only and are discarded on identity changes.
 * The GET result is a UI hint, NEVER a write authorization grant. */
export type PrivateNoteAreaChoice={id:string;title:string};
export type PrivateNoteAreaRead=
  |{ok:true;areas:PrivateNoteAreaChoice[]}
  |{ok:false;reason:"signed-out"|"stale"|"unavailable"|"aborted"|"invalid-response"};

const encoder=new TextEncoder();
const valid=(v:unknown,max:number):v is string=>{
  if(typeof v!=="string"||v.length===0||v.trim()!==v||
    !v.isWellFormed()||encoder.encode(v).length>max||
    /[\\u0000-\\u001f\\u007f]/u.test(v))return false;
  return true;
};
function earlier(a:string,b:string){
  const x=encoder.encode(a),y=encoder.encode(b);
  for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]<y[i];
  return x.length<y.length;
}
export function parsePrivateNoteAreaChoices(value:unknown):PrivateNoteAreaChoice[]|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const data=value as Record<string,unknown>;
  if(Object.keys(data).join(",")!=="areas"||!Array.isArray(data.areas)||
    data.areas.length>100)return null;
  const choices:PrivateNoteAreaChoice[]=[];
  for(const raw of data.areas){
    if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
    const a=raw as Record<string,unknown>;
    if(Object.keys(a).sort().join(",")!=="id,title"||
      !valid(a.id,512)||!valid(a.title,4096)||
      (choices.length>0&&!earlier(choices[choices.length-1].id,a.id)))return null;
    choices.push({id:a.id,title:a.title});
  }
  return choices;
}
async function readBounded(response:Response,signal:AbortSignal){
  const declared=response.headers.get("content-length");
  if(declared!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(declared)||
    !Number.isSafeInteger(Number(declared))||Number(declared)>600_000))
    throw Error("invalid length");
  if(!response.body)throw Error("empty body");
  const reader=response.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
  let bytes=0,text="",done=false;
  try{
    for(;;){
      if(signal.aborted)throw Error("aborted");
      const chunk=await reader.read();
      if(signal.aborted)throw Error("aborted");
      if(chunk.done){done=true;break;}
      bytes+=chunk.value.length;
      if(bytes>600_000)throw Error("large");
      text+=decoder.decode(chunk.value,{stream:true});
    }
    text+=decoder.decode();
    return JSON.parse(text) as unknown;
  }finally{
    if(!done)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
export async function loadPrivateNoteAreaChoices(
  signal:AbortSignal,fetchImpl:typeof fetch=fetch,
):Promise<PrivateNoteAreaRead>{
  if(signal.aborted)return {ok:false,reason:"aborted"};
  try{
    const response=await fetchImpl("/api/target-staging/notes/create-targets",{
      method:"GET",credentials:"same-origin",cache:"no-store",
      redirect:"error",headers:{accept:"application/json"},signal,
    });
    if(signal.aborted)return {ok:false,reason:"aborted"};
    if(response.status===401||response.status===403)return {ok:false,reason:"signed-out"};
    if(response.status===409)return {ok:false,reason:"stale"};
    if(response.status!==200)return {ok:false,reason:"unavailable"};
    if(response.redirected||
      response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json"||
      !(response.headers.get("cache-control")??"").split(",")
        .some(s=>s.trim().toLowerCase()==="no-store"))
      return {ok:false,reason:"invalid-response"};
    const areas=parsePrivateNoteAreaChoices(await readBounded(response,signal));
    return areas?{ok:true,areas}:{ok:false,reason:"invalid-response"};
  }catch{
    return {ok:false,reason:signal.aborted?"aborted":"unavailable"};
  }
}
