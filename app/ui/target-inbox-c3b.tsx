"use client";
/** C-3b: only mounted for actor-private editable Inbox rows.
 * Never retain titles, suggestions or model output in browser storage. */
import {useCallback,useEffect,useRef,useState} from "react";
import type {TargetInboxItem} from "../../lib/target-inbox-client-types";
import {fetchC3bProposal,acceptC3b,receiptC3b,
  type C3bProposal,type C3bAccept,type C3bReceipt}
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
        if(result.reason==="signed-out"){onRevoked();setStatus("failed");}
        else setStatus(result.reason==="disabled"?"off":"failed");
      }
    });
    return ()=>abort.abort();
  },[visible,disabled,runtime,generation,item.id,restoreGeneration,
    fetchKey,onRevoked]);
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
  const summary=moving&&scheduling
    ?speak("Zařadit a naplánovat","Classify and schedule")
    :moving?speak("Zařadit úkol","Classify task")
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
