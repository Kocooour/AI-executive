"use client";
/** R3-FE-1: one target data runtime per page load. Mounted by the server page
 * ONLY when AI_EXECUTIVE_TARGET_UI_ENABLED is on; features opt in through the
 * hooks below. Nothing here persists data or switches any screen. */
import {
  createContext,useContext,useEffect,useMemo,useRef,useState,useSyncExternalStore,
  type DependencyList,type ReactNode,
} from "react";
import {
  createTargetClientRuntime,type TargetClientRuntime,type TargetRuntimeDisposable,
} from "../../lib/target-client-runtime";

const RuntimeContext=createContext<TargetClientRuntime|null>(null);

export function TargetDataProvider({children}:{children:ReactNode}){
  // Created in an effect: server rendering and hydration never fetch.
  const [runtime,setRuntime]=useState<TargetClientRuntime|null>(null);
  useEffect(()=>{
    const created=createTargetClientRuntime();
    setRuntime(created);
    return ()=>{created.dispose();setRuntime(null);};
  },[]);
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

/** The runtime, or null outside a provider / before the first effect. */
export function useTargetRuntime():TargetClientRuntime|null{
  return useContext(RuntimeContext);
}

/** Current opaque generation ("" until known); re-renders on every change. */
export function useTargetGeneration():string{
  const runtime=useTargetRuntime();
  const subscribe=useMemo(
    ()=>(notify:()=>void)=>runtime?runtime.subscribe(notify):()=>{},[runtime]);
  return useSyncExternalStore(
    subscribe,()=>runtime?runtime.generation():"",()=>"");
}

/** Creates a feature session bound to `runtime.generation`, registers it and
 * disposes it on unmount, deps change and generation change. It is recreated
 * after a generation change, but only once a server-confirmed value exists.
 * Returns null while no session may exist. */
export function useTargetSession<T extends TargetRuntimeDisposable>(
  factory:(contextVersion:()=>string)=>T,deps:DependencyList,
):T|null{
  const runtime=useTargetRuntime();
  const generation=useTargetGeneration();
  const [session,setSession]=useState<T|null>(null);
  const factoryRef=useRef(factory);
  factoryRef.current=factory;
  const known=runtime?.known()===true;
  useEffect(()=>{
    if(!runtime||!known){setSession(null);return;}
    const created=factoryRef.current(runtime.generation);
    const unregister=runtime.register(created);
    setSession(created);
    return ()=>{unregister();created.dispose();setSession(null);};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[runtime,generation,known,...deps]);
  return session;
}
