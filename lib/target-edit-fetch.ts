/** R3-FE-4b: the staging server runs at most two read children at once, and the shared client
 * read queue (lib/target-read-queue.ts) takes ONE request at a time. Writes must never occupy
 * that slot (a stalled PATCH would starve every list), but the read-only preflights and the
 * receipt checks (POST .../status, .../receipt) are server READS and therefore queue.
 * Pure routing: both fetches are injected. */
export function isTargetReadRequest(input:Parameters<typeof fetch>[0],init?:RequestInit):boolean{
  const method=(init?.method??(input instanceof Request?input.method:"GET")).toUpperCase();
  if(method==="GET")return true;
  if(method!=="POST")return false;
  const raw=input instanceof Request?input.url:String(input);
  let path:string;
  try{path=new URL(raw,"https://lumi.invalid").pathname;}catch{return false;}
  return path.endsWith("/status")||path.endsWith("/receipt");
}

export function routeTargetFetch(queued:typeof fetch,direct:typeof fetch=fetch):typeof fetch{
  return ((input:Parameters<typeof fetch>[0],init?:RequestInit)=>
    isTargetReadRequest(input,init)?queued(input,init):direct(input,init)) as typeof fetch;
}
