/** R3-FE-4a: the staging server runs at most TWO read children at once (503
 * "concurrency_limit" beyond that, process-wide). A cold load or a wake used to start
 * the sidebar list, the Projects/Notes list and the open detail together, so one of them
 * regularly got a 503. Reads of detail/list screens therefore go through ONE shared
 * client-side queue of 1 request at a time; the slot is handed over directly to the next
 * waiter (no gap in which a newcomer could jump the queue). A request aborted while
 * waiting leaves the queue without ever touching the network. */
const LIMIT=1;
// The server only permits two read children concurrently. Aborting a
// client request cannot prove that a fetch which ignored abort has stopped;
// keep counting that underlying fetch until its promise actually settles.
const NETWORK_LIMIT=2;
let networkInFlight=0;
let active=0;
const waiting:Array<()=>void>=[];

function abortError(signal:AbortSignal|null|undefined):unknown{
  return signal?.reason??new DOMException("Aborted","AbortError");
}
function release():void{
  const next=waiting.shift();
  if(next)next(); // the slot passes to the next waiter
  else active--;
}

export function queuedTargetFetch(fetchImpl:typeof fetch=fetch):typeof fetch{
  return (async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const signal=init?.signal;
    if(signal?.aborted)throw abortError(signal);
    if(active>=LIMIT){
      await new Promise<void>((resolve,reject)=>{
        const waiter=()=>{signal?.removeEventListener("abort",onAbort);resolve();};
        const onAbort=()=>{
          const index=waiting.indexOf(waiter);
          if(index>=0)waiting.splice(index,1);
          reject(abortError(signal));
        };
        waiting.push(waiter);
        signal?.addEventListener("abort",onAbort,{once:true});
      });
    }else active++;
    try{
      if(signal?.aborted)throw abortError(signal);
      // Abort releases the *logical* queue slot promptly, but a transport
      // ignoring cancellation still occupies one of the two physical slots.
      // Never start more requests while those zombie fetches remain pending.
      // Fail closed instead of hanging the UI or exceeding the backend limit.
      const pending=Promise.resolve().then(()=>{
        if(signal?.aborted)throw abortError(signal);
        if(networkInFlight>=NETWORK_LIMIT)
          throw new Error("Target read capacity exhausted");
        networkInFlight++;
        let network:Promise<Response>;
        try{network=Promise.resolve(fetchImpl(input,init));}
        catch(error){networkInFlight--;throw error;}
        // Count the underlying network promise, not the abort race. Attach
        // both handlers so rejected/late operations cannot leak capacity.
        void network.then(()=>{networkInFlight--;},()=>{networkInFlight--;});
        return network;
      });
      if(!signal)return await pending;
      let onAbort=()=>{};
      const stopped=new Promise<never>((_,reject)=>{
        onAbort=()=>reject(abortError(signal));
        signal.addEventListener("abort",onAbort,{once:true});
      });
      try{
        const response=await Promise.race([pending,stopped]);
        if(signal.aborted){
          try{void response.body?.cancel().catch(()=>{});}catch{/* best effort */}
          throw abortError(signal);
        }
        return response;
      }
      catch(error){
        if(signal.aborted)void pending.then(response=>{
          try{void response.body?.cancel().catch(()=>{});}catch{/* discard late response */}
        },()=>{});
        throw error;
      }finally{signal.removeEventListener("abort",onAbort);}
    }finally{release();}
  }) as typeof fetch;
}

/** Test/inspection only. */
export function targetReadQueueState():{active:number;waiting:number}{
  return {active,waiting:waiting.length};
}
