"use client";
/** E-2: task attention notifications on target data (Settings → Notifications).
 * Renders nothing while the notification routes are off. Device state is
 * always re-read from the server; nothing is kept in browser storage. A browser
 * permission prompt is requested only after an explicit click. */
import {useCallback,useEffect,useRef,useState} from "react";
import "./target-push-settings.css";
import {base64UrlToBytes,browserSubscription,readTargetNotificationSettings,readTargetPushConfig,
  readTargetPushDeviceStatus,registerTargetPushDevice,revokeTargetPushDevice,sendTargetPushTest,subscribedWithKey,
  writeTargetNotificationSettings,type TargetNotificationSettings,type TargetPushFailure}
  from "../../lib/target-push-client";

type Device=
  |"checking"|"unsupported"|"insecure"|"server_unavailable"|"denied"|"not_registered"|"registered"|"unknown";
type View=
  |{kind:"loading"}|{kind:"hidden"}|{kind:"error"}
  |{kind:"ready";settings:TargetNotificationSettings;publicKey:string|null;device:Device;thisTarget:string|null};

const browserZone=():string=>{
  try{return Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC";}catch{return "UTC";}
};
const supported=():boolean=>typeof window!=="undefined"&&"serviceWorker" in navigator&&
  "PushManager" in window&&"Notification" in window;
/** The service worker may never become ready (failed registration): bound the wait. */
async function workerReady(ms=5000):Promise<ServiceWorkerRegistration> {
  return Promise.race([navigator.serviceWorker.ready,
    new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error()),ms))]);
}

export default function TargetPushSettings({language="cs",onActive}:{
  language?:"cs"|"en";onActive?:(active:boolean)=>void;
}){
  const cs=language==="cs";
  const t=(c:string,e:string)=>cs?c:e;
  const [view,setView]=useState<View>({kind:"loading"});
  const [busy,setBusy]=useState(false);
  // A ref, not only state: two clicks before a re-render must not start two actions.
  const busyRef=useRef(false);
  const [notice,setNotice]=useState("");
  const noticeRef=useRef<HTMLParagraphElement|null>(null);
  const [draft,setDraft]=useState<{quietStart:string;quietEnd:string;timeZone:string}|null>(null);
  // Unsaved quiet-hours edits survive any other action's reload.
  const draftDirty=useRef(false);
  const onActiveRef=useRef(onActive);
  onActiveRef.current=onActive;
  const failureText=(reason:TargetPushFailure)=>reason==="stale"
    ?t("Nastavení se mezitím změnilo. Načetla jsem aktuální stav, zkuste to prosím znovu.",
      "Settings changed meanwhile. The current state was reloaded; please try again.")
    :reason==="limited"?t("Příliš mnoho pokusů. Zkuste to za chvíli.","Too many attempts. Try again shortly.")
    :reason==="unauthorized"?t("Přihlášení vypršelo.","Your session ended.")
    :reason==="invalid"?t("Čas nebo časové pásmo není platné (např. Europe/Prague).","The time or time zone is not valid (e.g. Europe/Prague).")
    :t("Akci se nepodařilo dokončit.","The action could not be completed.");

  const load=useCallback(async(signal?:AbortSignal)=>{
    const [settings,config]=await Promise.all([readTargetNotificationSettings(signal),readTargetPushConfig(signal)]);
    if(signal?.aborted)return;
    if(settings.ok===false&&settings.reason==="disabled"){setView({kind:"hidden"});onActiveRef.current?.(false);return;}
    onActiveRef.current?.(true);
    if(settings.ok===false||config.ok===false){setView({kind:"error"});return;}
    const publicKey=config.value.available?config.value.publicKey:null;
    let device:Device="not_registered",thisTarget:string|null=null;
    if(!supported())device="unsupported";
    else if(!window.isSecureContext)device="insecure";
    else if(!publicKey)device="server_unavailable";
    else if(Notification.permission==="denied")device="denied";
    else if(Notification.permission==="granted"){
      try{
        const registration=await workerReady();
        const existing=await registration.pushManager.getSubscription();
        const plain=browserSubscription(existing);
        if(existing&&plain&&subscribedWithKey(existing,publicKey)){
          // Read-only: opening Settings never registers a device.
          const status=await readTargetPushDeviceStatus(plain);
          if(status.ok===false)device="unknown";
          else if(status.value){device="registered";thisTarget=status.value;}
        }
      }catch{device="unknown";}
    }
    if(signal?.aborted)return;
    setView({kind:"ready",settings:settings.value,publicKey,device,thisTarget});
    if(!draftDirty.current)
      setDraft({quietStart:settings.value.quietStart,quietEnd:settings.value.quietEnd,timeZone:settings.value.timeZone});
  },[]);

  useEffect(()=>{
    const controller=new AbortController();
    void load(controller.signal);
    return ()=>controller.abort();
  },[load]);

  if(view.kind==="hidden")return null;
  if(view.kind==="loading")return <p role="status" data-testid="target-push-settings">{t("Načítám upozornění…","Loading notifications…")}</p>;
  if(view.kind==="error")return <section data-testid="target-push-settings"><p role="alert">
    {t("Nastavení upozornění teď nejde načíst.","Notification settings are unavailable right now.")}</p>
    <button type="button" onClick={()=>{setView({kind:"loading"});void load();}}>{t("Zkusit znovu","Try again")}</button></section>;

  const {settings,publicKey,device,thisTarget}=view;
  const run=async(action:()=>Promise<string|null>)=>{
    if(busyRef.current)return;
    busyRef.current=true;setBusy(true);setNotice("");
    let message:string|null;
    try{message=await action();}
    catch{
      // A refused permission, a failed subscribe/unsubscribe or a dead service worker.
      message=t("Akci se v tomto prohlížeči nepodařilo dokončit.","The browser could not complete the action.");
    }
    try{await load();}catch{setView({kind:"error"});}
    busyRef.current=false;setBusy(false);
    if(message){
      setNotice(message);
      // The clicked control may be gone (enable <-> test/disable): keep focus on the outcome.
      window.setTimeout(()=>noticeRef.current?.focus(),0);
    }
  };
  const save=(next:Partial<Pick<TargetNotificationSettings,"timeZone"|"attentionPush"|"quietStart"|"quietEnd"|"paused">>,quiet=false)=>
    run(async()=>{
      const r=await writeTargetNotificationSettings(settings,{timeZone:settings.timeZone,
        attentionPush:settings.attentionPush,quietStart:settings.quietStart,quietEnd:settings.quietEnd,
        paused:settings.paused,...next});
      if(r.ok===false)return failureText(r.reason);
      // Only a saved quiet-hours form may be replaced by the server values.
      if(quiet)draftDirty.current=false;
      return t("Uloženo.","Saved.");
    });
  const enableDevice=()=>run(async()=>{
    if(!publicKey||!supported())return t("Tento prohlížeč upozornění nepodporuje.","This browser does not support notifications.");
    const permission=await Notification.requestPermission();
    if(permission!=="granted")return t("Oznámení nejsou v prohlížeči povolená.","Notifications are not allowed in this browser.");
    const registration=await workerReady();
    let subscription=await registration.pushManager.getSubscription();
    // A subscription for another key (e.g. the older reminders) cannot be reused:
    // replace it, which also stops the older pushes on this device.
    if(subscription&&!subscribedWithKey(subscription,publicKey)){await subscription.unsubscribe();subscription=null;}
    if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,
      applicationServerKey:base64UrlToBytes(publicKey)});
    let plain=browserSubscription(subscription);
    if(!plain)return t("Zařízení se nepodařilo přihlásit.","The device could not be registered.");
    let r=await registerTargetPushDevice(settings,plain);
    if(r.ok===false&&r.reason==="not_found"){
      // A removed device's endpoint cannot be reused: start a new subscription once.
      await subscription.unsubscribe();
      subscription=await registration.pushManager.subscribe({userVisibleOnly:true,
        applicationServerKey:base64UrlToBytes(publicKey)});
      plain=browserSubscription(subscription);
      const fresh=await readTargetNotificationSettings();
      if(!plain||fresh.ok===false)return t("Zařízení se nepodařilo přihlásit.","The device could not be registered.");
      r=await registerTargetPushDevice(fresh.value,plain);
    }
    if(r.ok===false)return failureText(r.reason);
    // Registration changes the notification epoch, not the settings revision.
    // Read again so the write cannot overwrite another device's explicit choice.
    const fresh=await readTargetNotificationSettings();
    if(fresh.ok===false)return failureText(fresh.reason);
    // Revision zero identifies the untouched UTC default, not an intentionally
    // selected UTC zone. After the first settings write, never auto-change it.
    const deviceZone=browserZone();
    const adoptZone=fresh.value.expectedSettingsRevision===0&&fresh.value.timeZone==="UTC"&&deviceZone!=="UTC";
    if(!fresh.value.attentionPush||adoptZone){
      const w=await writeTargetNotificationSettings(fresh.value,{timeZone:adoptZone?deviceZone:fresh.value.timeZone,attentionPush:true,
        quietStart:fresh.value.quietStart,quietEnd:fresh.value.quietEnd,paused:fresh.value.paused});
      if(w.ok===false)return failureText(w.reason);
    }
    const enabled=t("Upozornění jsou na tomto zařízení zapnutá.","Notifications are on for this device.");
    return adoptZone?enabled+" "+t("Časové pásmo bylo nastaveno podle tohoto zařízení ("+deviceZone+").",
      "Time zone was set from this device ("+deviceZone+")."):enabled;
  });
  const disableDevice=()=>run(async()=>{
    const registration=await workerReady();
    const subscription=await registration.pushManager.getSubscription();
    if(thisTarget){
      const r=await revokeTargetPushDevice(settings,thisTarget);
      if(r.ok===false&&r.reason!=="not_found")return failureText(r.reason);
    }
    if(subscription&&publicKey&&subscribedWithKey(subscription,publicKey))await subscription.unsubscribe();
    return t("Na tomto zařízení se upozornění už nebudou zobrazovat.","This device will no longer show notifications.");
  });
  const removeDevice=(targetId:string)=>run(async()=>{
    const r=await revokeTargetPushDevice(settings,targetId);
    return r.ok===false?failureText(r.reason):t("Zařízení bylo odebráno.","The device was removed.");
  });
  const test=()=>run(async()=>{
    const registration=await workerReady();
    const plain=browserSubscription(await registration.pushManager.getSubscription());
    if(!plain)return t("Toto zařízení není přihlášené.","This device is not registered.");
    const r=await sendTargetPushTest(plain,language);
    if(r.ok===false)return r.reason==="not_found"
      ?t("Toto zařízení není přihlášené.","This device is not registered."):failureText(r.reason);
    return r.value.result==="sent"
      ?t("Testovací oznámení bylo předáno službě oznámení.","The test notification was handed to the push service.")
      :r.value.result==="gone"
        ?(r.value.revoked
          ?t("Služba oznámení zařízení už nezná, proto bylo odebráno. Zapněte upozornění znovu.","The push service no longer knows this device, so it was removed. Turn notifications on again.")
          :t("Služba oznámení zařízení už nezná. Odeberte ho v seznamu a zapněte upozornění znovu.","The push service no longer knows this device. Remove it from the list and turn notifications on again."))
        :t("Testovací oznámení se nepodařilo doručit.","The test notification could not be delivered.");
  });

  const deviceText:Record<Device,string>={
    checking:t("Ověřuji…","Checking…"),
    unsupported:t("Tento prohlížeč upozornění nepodporuje. Na iPhonu přidejte Lumi na plochu.","This browser does not support notifications. On iPhone, add Lumi to the Home Screen."),
    insecure:t("Upozornění vyžadují zabezpečené připojení (HTTPS).","Notifications require a secure (HTTPS) connection."),
    server_unavailable:t("Odesílání upozornění na serveru zatím není nastavené.","Sending notifications is not set up on the server yet."),
    denied:t("Oznámení jsou v prohlížeči zakázaná. Povolte je v nastavení zařízení.","Notifications are blocked in this browser. Allow them in the device settings."),
    not_registered:t("Toto zařízení zatím upozornění nedostává.","This device does not receive notifications yet."),
    registered:t("Toto zařízení dostává upozornění.","This device receives notifications."),
    unknown:t("Stav tohoto zařízení teď nejde ověřit.","This device's state cannot be checked right now."),
  };
  const zone=browserZone();
  return <section className="targetPushSettings" data-testid="target-push-settings" aria-labelledby="target-push-heading">
    <div className="sectionHeading">
      <div>
        <h2 id="target-push-heading">{t("Upozornění na úkoly","Task alerts")}</h2>
        <p>{t("Oznámení o úkolech po termínu a s termínem do 48 hodin. V tichých hodinách se odloží, denně přijdou nejvýš "+settings.dailyLimit+".",
          "Alerts for overdue tasks and tasks due within 48 hours. Held during quiet hours, at most "+settings.dailyLimit+" a day.")}</p>
      </div>
      <span className={"installStatus"+(device==="registered"?" installed":"")} data-testid="target-push-device-state">
        {deviceText[device]}</span>
    </div>
    <div className="notificationActions">
      {device!=="registered"&&<button type="button" className="primaryAction" data-testid="target-push-enable"
        disabled={busy||device==="unsupported"||device==="insecure"||device==="server_unavailable"}
        onClick={()=>void enableDevice()}>{t("Zapnout na tomto zařízení","Turn on for this device")}</button>}
      {device==="registered"&&<>
        <button type="button" data-testid="target-push-test" disabled={busy} onClick={()=>void test()}>
          {t("Poslat testovací oznámení","Send a test notification")}</button>
        <button type="button" data-testid="target-push-disable" disabled={busy} onClick={()=>void disableDevice()}>
          {t("Vypnout na tomto zařízení","Turn off for this device")}</button>
      </>}
    </div>
    <div className="preferenceGrid">
      <label className="preferenceToggle">
        <input type="checkbox" data-testid="target-push-attention" checked={settings.attentionPush} disabled={busy}
          onChange={e=>void save({attentionPush:e.target.checked})}/>
        <span>{t("Posílat upozornění na úkoly","Send task alerts")}</span>
      </label>
      <label className="preferenceToggle">
        <input type="checkbox" data-testid="target-push-paused" checked={settings.paused} disabled={busy||!settings.attentionPush}
          onChange={e=>void save({paused:e.target.checked})}/>
        <span>{t("Pozastavit (nic se neposílá, dokud pauzu nezrušíte)","Pause (nothing is sent until you resume)")}</span>
      </label>
      <label className="preferenceToggle">
        <input type="checkbox" checked={false} disabled aria-describedby="target-push-urgent-note"/>
        <span>{t("Naléhavá výjimka z tichých hodin","Urgent exception to quiet hours")}</span>
        <small id="target-push-urgent-note">{t("Zatím není k dispozici.","Not available yet.")}</small>
      </label>
      {draft&&<form className="targetPushQuiet" onSubmit={e=>{e.preventDefault();
        void save({quietStart:draft.quietStart,quietEnd:draft.quietEnd,timeZone:draft.timeZone.trim()},true);}}>
        <label>{t("Tiché hodiny od","Quiet hours from")}
          <input type="time" data-testid="target-push-quiet-start" disabled={busy} value={draft.quietStart} required
            onChange={e=>{draftDirty.current=true;setDraft({...draft,quietStart:e.target.value});}}/></label>
        <label>{t("do","until")}
          <input type="time" data-testid="target-push-quiet-end" disabled={busy} value={draft.quietEnd} required
            onChange={e=>{draftDirty.current=true;setDraft({...draft,quietEnd:e.target.value});}}/></label>
        <label>{t("Časové pásmo","Time zone")}
          <input type="text" data-testid="target-push-zone" disabled={busy} value={draft.timeZone} maxLength={64} required
            autoComplete="off" spellCheck={false} onChange={e=>{draftDirty.current=true;setDraft({...draft,timeZone:e.target.value});}}/></label>
        {zone!==draft.timeZone&&<button type="button" onClick={()=>{draftDirty.current=true;setDraft({...draft,timeZone:zone});}}>
          {t("Použít pásmo tohoto zařízení ("+zone+")","Use this device's zone ("+zone+")")}</button>}
        <button type="submit" disabled={busy}>{t("Uložit","Save")}</button>
      </form>}
    </div>
    <h3>{t("Zařízení","Devices")}</h3>
    {settings.targets.length===0
      ?<p data-testid="target-push-no-devices">{t("Žádné zařízení není přihlášené.","No device is registered.")}</p>
      :<ul className="targetPushDevices" data-testid="target-push-devices">{settings.targets.map((id,index)=>
        <li key={id}>
          <span>{t("Zařízení ","Device ")+(index+1)+(id===thisTarget?t(" (toto zařízení)"," (this device)"):"")}</span>
          <button type="button" disabled={busy} onClick={()=>void removeDevice(id)}
            aria-label={t("Odebrat zařízení ","Remove device ")+(index+1)}>{t("Odebrat","Remove")}</button>
        </li>)}</ul>}
    <p role="status" aria-live="polite" data-testid="target-push-notice" ref={noticeRef} tabIndex={-1}>{notice}</p>
  </section>;
}
