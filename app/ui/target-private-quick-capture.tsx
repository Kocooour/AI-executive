"use client";
/** One global '+' opens explicit NOTE / TASK choice when the task-create gate
 * is active. The existing notes-only path is rendered unchanged when off. */
import {useEffect,useRef,useState} from "react";
import {handleOverlayKeys} from "./focus";
import TargetPrivateNoteAreaChooser from "./target-private-note-area-chooser";
import TargetPrivateTaskAreaChooser from "./target-private-task-area-chooser";

export default function TargetPrivateQuickCapture({
  language="cs",onClose,onNoteCreated,onTaskCreated,initialKind="choose",
}:{
  language?:"cs"|"en";onClose:()=>void;onNoteCreated:()=>void;
  onTaskCreated:()=>void;initialKind?:"choose"|"note";
}){
  const [kind,setKind]=useState<"choose"|"note"|"task">(initialKind);
  const initialRef=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(kind==="choose")initialRef.current?.focus();},[kind]);
  if(kind==="note")return <TargetPrivateNoteAreaChooser language={language}
    createEnabled onClose={onClose} onCreated={onNoteCreated}/>;
  if(kind==="task")return <TargetPrivateTaskAreaChooser language={language}
    onClose={onClose} onCreated={onTaskCreated}/>;
  const cs=language==="cs";
  return <div className="captureOverlay" onClick={onClose}>
    <div className="captureModal" role="dialog" aria-modal="true"
      aria-label={cs?"Rychlé přidání":"Quick capture"}
      data-testid="target-private-quick-capture"
      onClick={event=>event.stopPropagation()}
      onKeyDown={event=>handleOverlayKeys(event,onClose)}>
      <h2>{cs?"Co chcete přidat?":"What would you like to add?"}</h2>
      <p role="note">{cs
        ?"Nové položky jsou soukromé. Oblast si vždy výslovně vyberete."
        :"New items are private. You must explicitly select an Area."}</p>
      <div className="captureActions">
        <button type="button" ref={initialRef}
          data-testid="target-capture-task-kind"
          onClick={()=>setKind("task")}>{cs?"Úkol":"Task"}</button>
        <button type="button" data-testid="target-capture-note-kind"
          onClick={()=>setKind("note")}>{cs?"Poznámka":"Note"}</button>
        <button type="button" onClick={onClose}>{cs?"Zavřít":"Close"}</button>
      </div>
    </div>
  </div>;
}
