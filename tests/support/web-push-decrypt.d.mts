import type {ECDH} from "node:crypto";
export interface SyntheticBrowserKeys {ecdh:ECDH;auth:Buffer;keys:{p256dh:string;auth:string}}
export function syntheticBrowserKeys():SyntheticBrowserKeys;
export function decryptWebPush(body:Uint8Array,keys:{ecdh:ECDH;auth:Buffer}):string;
