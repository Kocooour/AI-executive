/** R3-FE-1: pure mapping of every existing target-client failure shape to one
 * calm Czech taxonomy. No technical ids, status codes or stack traces reach the
 * message. `uncertain` never claims success or failure. */
export type TargetClientErrorKind=
  |"signed_out"|"forbidden_or_missing"|"stale"|"conflict"|"invalid"
  |"rate_limited"|"unavailable"|"offline"|"uncertain";
export type TargetClientErrorAction=
  |"sign_in"|"reload"|"verify"|"retry_later"|"none";
export type TargetClientError={
  kind:TargetClientErrorKind;action:TargetClientErrorAction;message:string;
};
/** A bare reason/status name, an HTTP status, or an HTTP status with the
 * server's short `error`/`code` text (used to tell 409 variants apart). */
export type TargetClientFailureInput=
  |string|number|{status:number;error?:string;code?:string}
  |{reason:string}|{status:string};

const table:Record<TargetClientErrorKind,{action:TargetClientErrorAction;message:string}>={
  signed_out:{action:"sign_in",
    message:"Přihlášení skončilo. Přihlaste se znovu; dříve zobrazené údaje byly skryty."},
  forbidden_or_missing:{action:"none",
    message:"Tato položka není dostupná, nebo k ní nemáte přístup."},
  stale:{action:"reload",
    message:"Obsah se mezitím změnil. Načtěte jej prosím znovu."},
  conflict:{action:"reload",
    message:"Položku mezitím změnil někdo jiný. Načtěte aktuální stav a zkuste to znovu."},
  invalid:{action:"none",
    message:"Požadavek se nepodařilo zpracovat. Zkontrolujte zadané údaje."},
  rate_limited:{action:"retry_later",
    message:"Požadavků je teď příliš mnoho. Zkuste to prosím za chvíli."},
  unavailable:{action:"retry_later",
    message:"Služba teď není dostupná. Zkuste to prosím později."},
  offline:{action:"retry_later",
    message:"Jste offline. Po obnovení připojení to zkuste znovu."},
  uncertain:{action:"verify",
    message:"Výsledek se právě ověřuje. Zatím nevíme, zda se změna uložila; nic prosím neopakujte."},
};
export const targetClientActionLabels:Record<
  Exclude<TargetClientErrorAction,"none">,string>={
  sign_in:"Přihlásit se",reload:"Načíst znovu",verify:"Ověřit stav",
  retry_later:"Zkusit znovu",
};

const norm=(value:string)=>value.trim().toLowerCase().replace(/[\s-]+/g,"_");
const make=(kind:TargetClientErrorKind):TargetClientError=>({kind,...table[kind]});

function byName(name:string):TargetClientErrorKind|null {
  switch(norm(name)){
    case "unauthorized":case "signed_out":case "session_revoked":
    case "session_expired":case "session_restored":case "authentication_required":
      return "signed_out";
    case "forbidden":case "not_found":case "not_available":
      return "forbidden_or_missing";
    case "stale":case "read_stale_reload":case "cursor_stale":case "aborted":
    case "superseded":case "resync_required":case "invalidated":
      return "stale";
    case "conflict":case "revision_conflict":return "conflict";
    case "invalid":case "invalid_request":case "invalid_response":case "bad_request":
    case "payload_too_large":return "invalid";
    case "rate_limited":case "too_many_requests":return "rate_limited";
    case "unavailable":case "disabled":case "busy":case "not_ready":
    case "staging_unavailable":return "unavailable";
    case "offline":case "network":case "network_error":return "offline";
    case "uncertain":return "uncertain";
    default:return null;
  }
}
function byStatus(status:number,text:string):TargetClientErrorKind {
  if(status===401)return "signed_out";
  if(status===403||status===404)return "forbidden_or_missing";
  if(status===409){
    const named=byName(text);
    if(named==="stale"||named==="conflict")return named;
    const lower=text.toLowerCase();
    if(lower.includes("stale"))return "stale";
    return "conflict";
  }
  if(status===400||status===413)return "invalid";
  if(status===429)return "rate_limited";
  return "unavailable";
}

/** Total: an unrecognised input degrades to the generic `unavailable` copy. */
export function mapTargetClientFailure(input:TargetClientFailureInput):TargetClientError {
  try{
    if(typeof input==="number")return make(byStatus(input,""));
    if(typeof input==="string")return make(byName(input)??"unavailable");
    if(input&&typeof input==="object"){
      if("reason" in input&&typeof input.reason==="string")
        return make(byName(input.reason)??"unavailable");
      if("status" in input){
        if(typeof input.status==="string")return make(byName(input.status)??"unavailable");
        if(typeof input.status==="number"&&Number.isInteger(input.status)){
          const text="error" in input&&typeof input.error==="string"?input.error
            :"code" in input&&typeof input.code==="string"?input.code:"";
          return make(byStatus(input.status,text));
        }
      }
    }
  }catch{/* fall through */}
  return make("unavailable");
}
