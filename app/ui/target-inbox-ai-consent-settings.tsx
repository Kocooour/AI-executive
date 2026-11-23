"use client";
/** Explicit actor-owner AI consent; local rules never require this toggle. */
import {useCallback,useEffect,useState} from "react";
import "./target-inbox-ai-consent-settings.css";
import {getC3bConsent,setC3bConsent,type C3bCapacity}
  from "../../lib/target-inbox-c3b-client";
type State={kind:"loading"|"disabled"|"error"}|
  {kind:"ready";enabled:boolean;pending:boolean;capacity:C3bCapacity|null};
export default function InboxAIConsentSettings({language="cs"}:{
  language?:"cs"|"en";
}){
  const [state,setState]=useState<State>({kind:"loading"});
  const [saving,setSaving]=useState(false);
  const [notice,setNotice]=useState("");
  const speak=(cs:string,en:string)=>language==="cs"?cs:en;
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    // A busy child-process pool can briefly return 503 during concurrent Inbox
    // previews. Never display a cached grant; re-read durable consent with a
    // small bounded retry budget, keeping the toggle hidden while unknown.
    setState({kind:"loading"});
    let r=await getC3bConsent(signal);
    for(const delay of [350,700,1050]){
      if(r.ok===true||r.reason!=="unavailable"||signal?.aborted)break;
      await new Promise<void>(resolve=>setTimeout(resolve,delay));
      if(signal?.aborted)return;
      r=await getC3bConsent(signal);
    }
    if(signal?.aborted)return;
    if(r.ok===true)setState({kind:"ready",...r.value});
    else setState({kind:r.reason==="disabled"?"disabled":"error"});
  },[]);
  useEffect(()=>{
    const ctrl=new AbortController();
    void refresh(ctrl.signal);
    return ()=>ctrl.abort();
  },[refresh]);
  useEffect(()=>{
    const onVisibility=()=>{
      if(document.visibilityState==="visible")void refresh();
      else setState({kind:"loading"}); // never show stale consent
    };
    document.addEventListener("visibilitychange",onVisibility);
    return ()=>document.removeEventListener("visibilitychange",onVisibility);
  },[refresh]);
  async function change(enable:boolean){
    if(saving||state.kind==="loading"||state.kind==="disabled"||
       state.kind==="ready"&&state.pending)return;
    // Reflect the explicit user intent in the controlled checkbox while POST
    // is pending. On failure, render a conservative unknown-state error.
    setSaving(true);setNotice("");
    setState({kind:"ready",enabled:enable,pending:false,
      capacity:state.kind==="ready"?state.capacity:null});
    try{
      // Explicit owner action. No auto-enabling during restore, page reload
      // or initial rollout; the two-store ledger must agree first.
      const r=await setC3bConsent(enable);
      if(r.ok){
        setState({kind:"ready",...r.value,
          capacity:state.kind==="ready"?state.capacity:null});
        setNotice(r.value.pending?speak(
          "Odvolání souhlasu probíhá; otevřené požadavky se dokončují nebo ruší.",
          "Consent withdrawal is pending while in-flight requests drain.")
          :enable?speak("Souhlas byl aktivován.","Consent enabled.")
          :speak("Souhlas byl odvolán.","Consent withdrawn."));
      }else{
        // The POST might have committed even if its response was lost.
        // Do not falsely claim AI is disabled: re-read durable consent.
        setNotice(speak("Výsledek změny není potvrzen. Ověřuji aktuální stav.",
          "The outcome is uncertain. Rechecking the current consent."));
        await refresh();
      }
    }finally{setSaving(false);}
  }
  if(state.kind==="disabled")return null;
  return <div className="targetInboxAIConsent"
      data-testid="target-c3b-consent-settings">
    <h2>{speak("AI návrhy pro Inbox","AI suggestions for Inbox")}</h2>
    <p>{speak(
      "Bez souhlasu fungují pouze lokální pravidla. Po výslovném zapnutí se OpenAI odesílá jen název aktuálního soukromého úkolu a názvy vašich soukromých Oblastí a projektů. Žádné poznámky ani sdílená data. Ukládání odpovědí je vypnuté, poskytovatel však může uchovávat bezpečnostní záznamy.",
      "Without consent only local rules run. Enabling sends OpenAI only the current private task title and names of your private Areas/projects, never notes or shared data. Response-object storage is disabled, but provider safety logs may still exist."
    )}</p>
    {state.kind==="loading"&&<p role="status">{speak(
      "Ověřuji souhlas…","Checking consent…")}</p>}
    {state.kind==="error"&&<p role="alert">{speak(
      "Aktuální stav souhlasu nelze ověřit. Mohl se změnit; obnovte kontrolu nebo souhlas odvolejte.",
      "Consent status cannot be verified. It may have changed; refresh or withdraw consent.")}</p>}
    {state.kind==="ready"&&<label className="targetInboxAIConsentToggle">
      <input type="checkbox" checked={state.enabled}
        disabled={saving||state.pending} onChange={e=>void change(e.target.checked)}/>
      {speak("Povolit OpenAI návrhy pro moje soukromé úkoly",
        "Allow OpenAI suggestions for my private tasks")}
    </label>}
    {state.kind==="ready"&&state.capacity&&<>
      <p role="status" data-testid="target-c3b-receipt-capacity">
        {speak("Kapacita historie Přijmout/Undo: ",
          "Accept/Undo receipt capacity: ")}
        {state.capacity.reserved} / {state.capacity.limit}
        {" · "}
        {speak("zbývá přibližně ","approximately ")}
        {state.capacity.remainingAccepts}
        {speak(" nových potvrzení"," new Accepts remain")}
      </p>
      {state.capacity.warning&&<p role="alert"
        data-testid="target-c3b-receipt-capacity-warning">
        {speak("Historie potvrzení se blíží kapacitě. Některé nové návrhy nemusí jít přijmout; starší potvrzení a možnost Undo zůstávají zachovány.",
          "Confirmation history is nearly full. Some new suggestions may not be accepted; existing confirmations and Undo remain available.")}
      </p>}
    </>}
    {state.kind==="ready"&&state.pending&&<p role="status">{speak(
      "Odvolání čeká na bezpečné dokončení rozběhnutých požadavků.",
      "Withdrawal is pending until active requests have drained.")}</p>}
    {state.kind==="error"&&<button type="button"
      disabled={saving} onClick={()=>void change(false)}>
      {speak("Odvolat souhlas i při neznámém stavu",
        "Withdraw consent even when status is unknown")}</button>}
    {notice&&<p role="status">{notice}</p>}
    <button type="button" disabled={saving} onClick={()=>void refresh()}>
      {speak("Ověřit aktuální souhlas","Refresh consent status")}</button>
  </div>;
}
