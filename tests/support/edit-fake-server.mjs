// R3-FE-4b: scriptable fake of the staging write routes (no network, no store).
export const REV="a".repeat(64);
export const GEN="11111111-1111-4111-8111-111111111111";
export const json=(body,status=200,extra={})=>new Response(JSON.stringify(body),{
  status,headers:{"cache-control":"no-store","content-type":"application/json",...extra},
});
export const ctx=(over={})=>({expectedRevision:REV,writeAreaId:"area1",restoreGeneration:GEN,...over});

/** `handlers` maps "METHOD path" (query stripped) to (request)=>Response|Promise|throw. */
export function fakeServer(handlers){
  const calls=[];
  const fetchFake=async(input,init={})=>{
    const url=new URL(String(input),"https://lumi.test");
    const method=(init.method||"GET").toUpperCase();
    const key=method+" "+decodeURIComponent(url.pathname);
    const call={method,path:decodeURIComponent(url.pathname),search:url.search,init,
      body:init.body?JSON.parse(init.body):null,headers:init.headers||{}};
    calls.push(call);
    const handler=handlers[key];
    if(!handler)return json({error:"Not found"},404);
    return handler(call);
  };
  return {fetchFake,calls,
    writes:()=>calls.filter(c=>["PATCH","DELETE"].includes(c.method)||
      (c.method==="POST"&&!/\/(status|receipt)$/.test(c.path))),
    count:(key)=>calls.filter(c=>c.method+" "+c.path===key).length};
}
export const TASK="task-1";
export const NOTE="note-1";
export const STATUS_PREFLIGHT="GET /api/target-staging/task-temporal/status";
export const TITLE=`PATCH /api/target-staging/tasks/${TASK}/title`;
export const TITLE_RECEIPT=`POST /api/target-staging/tasks/${TASK}/title/status`;
export const TASK_DELETE=`POST /api/target-staging/tasks/${TASK}/delete`;
export const TASK_DELETE_RECEIPT=`POST /api/target-staging/tasks/${TASK}/delete/status`;
export const STATUS_PATCH="PATCH /api/target-staging/task-temporal/status";
export const STATUS_RECEIPT="POST /api/target-staging/task-temporal/status/receipt";
export const WHEN_PREFLIGHT="GET /api/target-staging/task-temporal/personal-when/command";
export const WHEN_PATCH="PATCH /api/target-staging/task-temporal/personal-when/command";
export const WHEN_RECEIPT="POST /api/target-staging/task-temporal/personal-when/command/receipt";
export const NOTE_PREFLIGHT=`GET /api/target-staging/notes/${NOTE}/edit`;
export const NOTE_EDIT=`PATCH /api/target-staging/notes/${NOTE}/edit`;
export const NOTE_EDIT_RECEIPT=`POST /api/target-staging/notes/${NOTE}/edit/status`;
export const NOTE_DELETE=`DELETE /api/target-staging/notes/${NOTE}`;
export const NOTE_DELETE_RECEIPT=`POST /api/target-staging/notes/${NOTE}/delete/status`;
export const TASK_DETAIL="GET /api/target-staging/task-temporal/detail";
export const NOTE_DETAIL=`GET /api/target-staging/notes/${NOTE}`;
export const taskBody=(title="Old",over={})=>({task:{id:TASK,title,projectId:null,areaId:"area1",areaKind:"private",status:"open",completedAtMs:null,dueOn:null,...over}});
export const noteBody=(title="T0",body="B0",over={})=>({note:{id:NOTE,title,body,projectId:null,areaId:"area1",areaKind:"private",revision:1,...over}});
