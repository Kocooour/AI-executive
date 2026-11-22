"use client";
/** C-3b: only mounted for actor-private editable Inbox rows.
 * Never retain titles, suggestions or model output in browser storage. */
import {useCallback,useEffect,useRef,useState} from "react";
import type {TargetInboxItem} from "../../lib/target-inbox-client-types";
import {fetchC3bProposal,acceptC3b,receiptC3b,
  type C3bProposal,type C3bAccept,type C3bReceipt,
  C3B_CONSENT_CHANGED}
  from "../../lib/target-inbox-c3b-client";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";

export type C3bOutcome={
  command:C3bAccept;status:"committed"|"uncertain";
  next:C3bReceipt["next"];
};
type Props={item:TargetInboxItem;restoreGeneration:string;
  language:"cs"|"en";disabled:boolean;
  onOutcome:(outcome:C3bOutcome)=>boolean;onRevoked:()=>void};
export default function TargetInboxC3b({item,restoreGeneration,
  language,disabled,onOutcome,onRevoked}:Props){
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const root=useRef<HTMLDivElement|null>(null);
  // Parent wake/refusal handlers can be refreshed without retriggering the
  // network effect on every Inbox redraw. Always invoke the latest handler.
  const revoked=useRef(onRevoked);
  revoked.current=onRevoked;
  const [visible,setVisible]=useState(false);
  const [fetchKey,setFetchKey]=useState(0);
  const [suggestion,setSuggestion]=useState<C3bProposal|null>(null);
  const [status,setStatus]=useState<"idle"|"loading"|"ready"|"off"|"failed"|"sending">("idle");
  const [expanded,setExpanded]=useState(false);
  const speak=(cs:string,en:string)=>language==="cs"?cs:en;
  useEffect(()=>{
    const el=root.current;
    if(!el)return;
    if(typeof IntersectionObserver==="undefined"){
      setVisible(true);return;
    }
    const observer=new IntersectionObserver(entries=>{
      if(entries.some(x=>x.isIntersecting))setVisible(true);
    },{rootMargin:"180px"});
    observer.observe(el);
    return ()=>observer.disconnect();
  },[]);
  // An explicit revoke/renewal in Settings (including another tab) retires
  // already displayed AI actions. A fresh read may show local rules instead.
  useEffect(()=>{
    const changed=()=>{
      setSuggestion(null);setStatus("idle");setFetchKey(n=>n+1);
    };
    window.addEventListener(C3B_CONSENT_CHANGED,changed);
    window.addEventListener("focus",changed);
    let channel:BroadcastChannel|null=null;
    try{
      if(typeof BroadcastChannel!=="undefined"){
        channel=new BroadcastChannel(C3B_CONSENT_CHANGED);
        channel.onmessage=changed;
      }
    }catch{}
    return ()=>{
      window.removeEventListener(C3B_CONSENT_CHANGED,changed);
      window.removeEventListener("focus",changed);
      channel?.close();
    };
  },[]);
  const reload=useCallback(()=>{
    setSuggestion(null);
    setStatus("idle");
    setFetchKey(n=>n+1);
  },[]);
  useEffect(()=>{
    if(!visible||disabled||!runtime?.known()||
       runtime.generation()!==generation)return;
    const abort=new AbortController();
    setStatus("loading");
    void fetchC3bProposal(item.id,abort.signal).then(result=>{
      if(abort.signal.aborted||!runtime.known()||
         runtime.generation()!==generation)return;
      if(result.ok===true){
        if(result.value.restoreGeneration!==restoreGeneration){
          setSuggestion(null);setStatus("failed");return;
        }
        setSuggestion(result.value);setStatus("ready");
      }else{
        setSuggestion(null);
        if(result.reason==="signed-out"){revoked.current();setStatus("failed");}
        else setStatus(result.reason==="disabled"?"off":"failed");
      }
    });
    return ()=>abort.abort();
  },[visible,disabled,runtime,generation,item.id,restoreGeneration,
    fetchKey]);
  async function accept(){
    if(disabled||!suggestion||status!=="ready"||
       !runtime?.known()||runtime.generation()!==generation)return;
    const command:C3bAccept={
      commandId:crypto.randomUUID(),taskId:item.id,
      restoreGeneration:suggestion.restoreGeneration,
      token:suggestion.token,displayedWhy:suggestion.why,
      displayedChanges:suggestion.changes,
    };
    // The original UUID must be saved without private text BEFORE dispatch.
    // Refuse the write if the tab recovery witness cannot be persisted.
    if(!onOutcome({command,status:"uncertain",next:null}))return;
    setStatus("sending");
    const sent=await acceptC3b(command);
    if(!runtime.known()||runtime.generation()!==generation)return;
    if(sent.ok===false&&sent.reason==="signed-out"){
      setSuggestion(null);onRevoked();return;
    }
    // A network error, 409 or a stale HTTP release does NOT prove a
    // pinned write did not commit. Always check the ORIGINAL receipt.
    const checked=await receiptC3b(command);
    if(!runtime.known()||runtime.generation()!==generation)return;
    if(checked.ok&&checked.value.status==="committed"){
      onOutcome({command,status:"committed",next:checked.value.next});
      return;
    }
    onOutcome({command,status:"uncertain",next:null});
    if(checked.ok&&checked.value.status==="not_recorded")
      setStatus("failed");
  }
  const changes=suggestion?.changes;
  const moving=Boolean(changes&&(changes.projectId!=="unchanged"||
    changes.taskAreaId!=="unchanged"));
  const scheduling=Boolean(changes&&changes.whenOn!=="unchanged");
  // The destination is not merely an explanation behind "Why?". Show the
  // server-committed target name (present in the signed Why) AND the exact day
  // before the one-click Accept, including combined project+Today actions.
  const summary=moving
    ?suggestion!.why+(scheduling?
      " "+speak("Osobní plán: ","Personal plan: ")+changes!.whenOn:"")
    :scheduling?speak("Naplánovat na ","Schedule for ")+changes!.whenOn
    :speak("Ponechat umístění a zpracovat","Keep placement and process");
  return <div ref={root} className="targetInboxSuggestion"
      data-testid={"target-c3b-suggestion-"+item.id}>
    {status==="ready"&&suggestion&&<>
      <div className="targetInboxSuggestionHeading">
        <span>{summary}</span>
        <button type="button" aria-expanded={expanded}
          onClick={()=>setExpanded(x=>!x)}
          aria-label={speak("Proč tento návrh?","Why this suggestion?")}>
          {speak("Proč?","Why?")}
        </button>
        <button type="button" disabled={disabled||status!=="ready"}
          onClick={()=>void accept()}>
          {speak("Přijmout","Accept")}
        </button>
      </div>
      {expanded&&<p className="targetInboxSuggestionWhy">
        {suggestion.why}</p>}
    </>}
    {status==="loading"&&<small role="status">
      {speak("Připravuji návrh…","Preparing suggestion…")}</small>}
    {status==="failed"&&<button type="button" onClick={reload}
        disabled={disabled}>
      {speak("Zkusit návrh znovu","Retry suggestion")}</button>}
    {status==="sending"&&<small role="status">
      {speak("Ověřuji zápis…","Checking the write…")}</small>}
  </div>;
}
