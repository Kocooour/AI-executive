/** E-2: the VAPID identity of target push.
 *
 * Dedicated keys come only from the root-owned EnvironmentFile; nothing is read
 * from or written to the legacy database, and no key is ever generated at runtime
 * or logged. Missing or inconsistent configuration means push is unavailable;
 * Home attention keeps working without it. Generation and rotation: DEPLOY.md. */
import {createECDH} from "node:crypto";

export const TARGET_VAPID_PUBLIC_ENV="AI_EXECUTIVE_TARGET_VAPID_PUBLIC_KEY";
export const TARGET_VAPID_PRIVATE_ENV="AI_EXECUTIVE_TARGET_VAPID_PRIVATE_KEY";
const B64URL=/^[A-Za-z0-9_-]+$/;

export interface TargetVapidConfig {
  readonly publicKey:string;
  readonly privateKey:string;
  readonly subject:string;
}
export type TargetVapidEnv=Record<string,string|undefined>;

const raw=(value:string|undefined,bytes:number):Buffer|null=>{
  if(typeof value!=="string"||!B64URL.test(value))return null;
  const buffer=Buffer.from(value,"base64url");
  return buffer.length===bytes&&buffer.toString("base64url")===value?buffer:null;
};

/** Apple rejects non-public VAPID subjects (BadJwtToken): only an explicit
 * https:/mailto: subject or the configured public HTTPS app origin is used. */
export function targetVapidSubject(env:TargetVapidEnv=process.env):string|null {
  const explicit=env.VAPID_SUBJECT?.trim();
  if(explicit){
    try{
      const url=new URL(explicit);
      if(url.protocol==="https:"||(url.protocol==="mailto:"&&url.pathname.includes("@")))return explicit;
    }catch{/* invalid */}
    return null;
  }
  for(const value of [env.AI_EXECUTIVE_PASSKEY_ORIGINS,env.AI_EXECUTIVE_ALLOWED_ORIGINS]
    .filter(Boolean).flatMap(v=>String(v).split(",")).map(v=>v.trim()).filter(Boolean)){
    try{
      const url=new URL(value);
      if(url.protocol==="https:"&&url.origin===value)return value;
    }catch{/* skip */}
  }
  return null;
}

/** The validated key pair and subject, or null when push is unavailable. The
 * private key must derive exactly the configured public key. */
export function targetVapidConfig(env:TargetVapidEnv=process.env):TargetVapidConfig|null {
  const publicKey=env[TARGET_VAPID_PUBLIC_ENV],privateKey=env[TARGET_VAPID_PRIVATE_ENV];
  const pub=raw(publicKey,65),priv=raw(privateKey,32);
  if(!pub||!priv||pub[0]!==4)return null;
  try{
    const ecdh=createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    if(!ecdh.getPublicKey().equals(pub))return null;
  }catch{return null;}
  const subject=targetVapidSubject(env);
  if(!subject)return null;
  return Object.freeze({publicKey:publicKey!,privateKey:privateKey!,subject});
}
