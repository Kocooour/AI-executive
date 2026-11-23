"use client";
/** C-3b: only mounted for actor-private editable Inbox rows.
 * Never retain titles, suggestions or model output in browser storage. */
import {useCallback,useEffect,useId,useRef,useState} from "react";
import type {TargetInboxItem} from "../../lib/target-inbox-client-types";
import {fetchC3bProposal,getC3bConsent,acceptC3b,cancelC3b,receiptC3b,
  type C3bProposal,type C3bAccept,type C3bReceipt,
  C3B_CONSENT_CHANGED}
  from "../../lib/target-inbox-c3b-client";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";

export type C3bOutcome={
  command:C3bAccept;status:"sending"|"committed"|"uncertain";
  next:C3bReceipt["next"];
};
type Props={item:TargetInboxItem;restoreGeneration:string;
  language:"cs"|"en";disabled:boolean;
  onOutcome:(outcome:C3bOutcome)=>boolean;onRevoked:()=>void;
  onStale:()=>void};
export default function TargetInboxC3b({item,restoreGeneration,
  language,disabled,onOutcome,onRevoked,onStale}:Props){
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const root=useRef<HTMLDivElement|null>(null);
  const whyId=useId();
  const acceptInFlight=useRef(false);
  const lastBlur=useRef<number|null>(null);
  const pendingPreview=useRef<AbortController|null>(null);
  const pendingAI=useRef<AbortController|null>(null);
  // Parent wake/refusal handlers can be refreshed without retriggering the
  // network effect on every Inbox redraw. Always invoke the latest handler.
  const revoked=useRef(onRevoked);
  revoked.current=onRevoked;
  const [visible,setVisible]=useState(false);
  const [fetchKey,setFetchKey]=useState(0);
  const [suggestion,setSuggestion]=useState<C3bProposal|null>(null);
  const [alternative,setAlternative]=useState<C3bProposal|null>(null);
  const [aiBusy,setAiBusy]=useState(false);
  const [aiNotice,setAiNotice]=useState<"off"|"failed"|null>(null);
  const [aiConsentEnabled,setAiConsentEnabled]=useState(false);
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
      // React's effect cleanup runs on the following commit. Abort right now:
      // a late AI response in the same event turn must never resurrect a
      // proposal invalidated by the explicit consent/ACL boundary.
      pendingPreview.current?.abort();
      pendingAI.current?.abort();pendingAI.current=null;
      setAiBusy(false);setAiNotice(null);
      setSuggestion(null);setAlternative(null);
      setAiConsentEnabled(false);setStatus("idle");setFetchKey(n=>n+1);
    };
    const blurred=()=>{lastBlur.current=Date.now();};
    const awakened=()=>{
      if(lastBlur.current!==null&&Date.now()-lastBlur.current>=60_000)
        changed();
      lastBlur.current=null;
    };
    window.addEventListener(C3B_CONSENT_CHANGED,changed);
    window.addEventListener("blur",blurred);
    window.addEventListener("focus",awakened);
    let channel:BroadcastChannel|null=null;
    try{
      if(typeof BroadcastChannel!=="undefined"){
        channel=new BroadcastChannel(C3B_CONSENT_CHANGED);
        channel.onmessage=changed;
      }
    }catch{}
    return ()=>{
      window.removeEventListener(C3B_CONSENT_CHANGED,changed);
      window.removeEventListener("blur",blurred);
      window.removeEventListener("focus",awakened);
      channel?.close();
    };
  },[]);
  const reload=useCallback(()=>{
    pendingAI.current?.abort();pendingAI.current=null;
    setSuggestion(null);
    setAlternative(null);
    setAiBusy(false);setAiNotice(null);
    setAiConsentEnabled(false);
    setStatus("idle");
    setFetchKey(n=>n+1);
  },[]);
  useEffect(()=>{
    if(!visible||disabled||!runtime?.known()||
       runtime.generation()!==generation)return;
    const abort=new AbortController();
    pendingPreview.current=abort;
    setStatus("loading");
    setAlternative(null);setAiNotice(null);setAiBusy(false);
    void (async()=>{
      // Release the local, signed rules proposal before any remote AI work.
      // A delayed provider must not block the user's Accept/manual controls.
      const rules=await fetchC3bProposal(item.id,abort.signal,"rules");
      if(abort.signal.aborted||!runtime.known()||
         runtime.generation()!==generation)return;
      if(rules.ok===false){
        setSuggestion(null);
        if(rules.reason==="signed-out"){revoked.current();setStatus("failed");}
        else setStatus(rules.reason==="disabled"?"off":"failed");
        return;
      }
      if(rules.value.restoreGeneration!==restoreGeneration||
         rules.value.source!=="rule"){
        setSuggestion(null);setStatus("failed");return;
      }
      setSuggestion(rules.value);setStatus("ready");
      // No automatic "best" request. An optional OpenAI call requires a
      // separate explicit click AND freshly confirmed two-store consent.
    })();
    return ()=>{
      abort.abort();
      pendingAI.current?.abort();pendingAI.current=null;
      if(pendingPreview.current===abort)pendingPreview.current=null;
    };
  },[visible,disabled,runtime,generation,item.id,restoreGeneration,
    fetchKey]);
  async function requestAI(){
    if(disabled||!suggestion||status!=="ready"||aiBusy||
       pendingAI.current||alternative||suggestion.source==="ai"||
       !runtime?.known()||runtime.generation()!==generation)return;
    const ctrl=new AbortController();
    pendingAI.current=ctrl;
    setAiBusy(true);setAiNotice(null);
    try{
      // A consent grant is not inferred from the presence of an AI button
      // or a previously cached preview; check a fresh durable two-store read.
      const consent=await getC3bConsent(ctrl.signal);
      if(ctrl.signal.aborted||!runtime.known()||
         runtime.generation()!==generation)return;
      if(consent.ok===false){
        if(consent.reason==="signed-out"){revoked.current();return;}
        setAiNotice("failed");return;
      }
      if(!consent.value.enabled||consent.value.pending){
        setAiNotice("off");return;
      }
      const result=await fetchC3bProposal(item.id,ctrl.signal,"best");
      if(ctrl.signal.aborted||!runtime.known()||
         runtime.generation()!==generation)return;
      if(result.ok===true&&result.value.source==="ai"&&
         result.value.restoreGeneration===restoreGeneration&&
         result.value.token!==suggestion.token){
        // Only expose an ALTERNATIVE. Never replace the signed rule action
        // until the owner explicitly selects it.
        setAlternative(result.value);
      }else if(result.ok===false&&result.reason==="signed-out"){
        setSuggestion(null);revoked.current();
      }else setAiNotice("failed");
    }finally{
      if(pendingAI.current===ctrl){
        pendingAI.current=null;setAiBusy(false);
      }
    }
  }
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
    pendingAI.current?.abort();pendingAI.current=null;
    setAiBusy(false);setAlternative(null);
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
        {suggestion.source==="ai"&&<small data-testid="target-c3b-ai-selected">
          {speak("AI návrh","AI suggestion")}</small>}
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
      {!alternative&&suggestion.source==="rule"&&<button type="button"
        disabled={disabled||aiBusy} onClick={()=>void requestAI()}>
        {aiBusy?speak("Ověřuji alternativu AI…","Checking AI alternative…"):
          speak("Získat alternativu AI","Get AI alternative")}
      </button>}
      {aiNotice==="off"&&<small role="status">{speak(
        "AI návrhy nejsou povoleny v Nastavení.",
        "AI suggestions are not enabled in Settings.")}</small>}
      {aiNotice==="failed"&&<small role="status">{speak(
        "Alternativu AI nyní nelze načíst. Pravidlový návrh zůstává dostupný.",
        "AI alternative unavailable; local rules remain available.")}</small>}
      {alternative&&<button type="button" disabled={disabled}
        onClick={()=>{
          // Explicit selection changes both the visible action and its token.
          // The prior rules token remains untouched until this user click.
          setSuggestion(alternative);setAlternative(null);setExpanded(false);
        }}>
        {speak("Zobrazit alternativní návrh AI","Show alternative AI suggestion")}
      </button>}
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
