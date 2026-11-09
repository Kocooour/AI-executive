"use client";
/** R3-FE-3: the single global reading-scope switcher Vše / Osobní / Sdílené.
 * Loaded lazily by the app root only when the server page enabled target
 * scopes. It reads/writes only the address (see target-scope-state.ts); it
 * makes no request and never decides access. */
import {useId,useRef,type KeyboardEvent} from "react";
import {useSetTargetScope,useTargetScope} from "./target-scope-state";
import {scopesCopy,type ScopesLanguage} from "../../lib/target-scopes-copy";
import {urlScopes,type UrlScope} from "../../lib/view-url";
import "./target-scopes.css";

export default function TargetScopeSwitcher({language="cs"}:{language?:ScopesLanguage}){
  const copy=scopesCopy[language];
  const scope=useTargetScope();
  const setScope=useSetTargetScope();
  const baseId=useId();
  const buttons=useRef<Array<HTMLButtonElement|null>>([]);
  const labels:Record<UrlScope,{label:string;hint:string}>={
    all:{label:copy.all,hint:copy.allHint},
    personal:{label:copy.personal,hint:copy.personalHint},
    shared:{label:copy.shared,hint:copy.sharedHint},
  };
  function onKeyDown(event:KeyboardEvent<HTMLButtonElement>,index:number){
    const last=urlScopes.length-1;
    let next:number|null=null;
    if(event.key==="ArrowRight"||event.key==="ArrowDown")next=index===last?0:index+1;
    else if(event.key==="ArrowLeft"||event.key==="ArrowUp")next=index===0?last:index-1;
    else if(event.key==="Home")next=0;
    else if(event.key==="End")next=last;
    if(next===null)return;
    event.preventDefault();
    setScope(urlScopes[next]);
    buttons.current[next]?.focus();
  }
  return <div className="targetScopeSwitcher" role="radiogroup"
    aria-label={copy.groupLabel} data-testid="target-scope-switcher" data-scope={scope}>
    {urlScopes.map((value,index)=>{
      const checked=value===scope;
      const hintId=`${baseId}-${value}`;
      return <button key={value} type="button" role="radio"
        ref={element=>{buttons.current[index]=element;}}
        aria-checked={checked} aria-describedby={hintId}
        tabIndex={checked?0:-1} data-scope-option={value}
        className="targetScopeOption"
        onClick={()=>setScope(value)}
        onKeyDown={event=>onKeyDown(event,index)}>
        <span className="targetScopeDot" aria-hidden="true"/>
        <span>{labels[value].label}</span>
        <span id={hintId} className="srOnly">{labels[value].hint}</span>
      </button>;
    })}
  </div>;
}
