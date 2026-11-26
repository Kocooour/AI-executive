/** E-2: the real Web Push transport behind TargetPushSender.
 *
 * `web-push` only builds the encrypted (aes128gcm) request and its VAPID headers;
 * this module sends it itself so that every connection is pinned to an address
 * that was resolved and checked here:
 *  - the endpoint must be an allowed push service (lib/target-push-endpoint.ts);
 *  - every resolved address must be public (no loopback, private, link-local,
 *    unique-local, CGNAT, multicast or reserved range), and the socket connects to
 *    exactly that checked address (no second lookup, so no DNS rebinding);
 *  - HTTPS only (except the loopback fake push origin of a test run), no proxy,
 *    no redirects, a bounded timeout and a bounded response.
 * Results: 2xx sent, 404/410 gone (the device is revoked), anything else failed
 * (retried by the pass). Nothing about endpoints, keys or payloads is logged. */
import {lookup as dnsLookup} from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import {BlockList,isIP} from "node:net";
import webpush from "web-push";
import {allowedTargetPushEndpoint,targetPushTestOrigin} from "./target-push-endpoint";
import type {TargetPushEnv,TargetPushSubscription} from "./target-push-endpoint";
import type {TargetVapidConfig} from "./target-push-vapid";
import type {TargetPushPayload,TargetPushSendResult,TargetPushSender} from "./target-attention-push-pass";

export const TARGET_PUSH_REQUEST_TIMEOUT_MS=15_000;
export const TARGET_PUSH_MAX_PAYLOAD_BYTES=3072;
/** Seconds a push service may hold an undelivered message (one day). */
export const TARGET_PUSH_TTL_SECONDS=86_400;
const MAX_RESPONSE_BYTES=16*1024;

const blocked=new BlockList();
for(const [net,prefix] of [
  ["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],
  ["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],
  ["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4],
] as const)blocked.addSubnet(net,prefix,"ipv4");
for(const [net,prefix] of [
  ["::",128],["::1",128],["::ffff:0:0",96],["64:ff9b::",96],["64:ff9b:1::",48],["100::",64],
  ["2001::",23],["2001:db8::",32],["2002::",16],["fc00::",7],["fe80::",10],["fec0::",10],["ff00::",8],
] as const)blocked.addSubnet(net,prefix,"ipv6");

/** True only for a globally routable unicast address. */
export function publicPushAddress(address:string):boolean {
  const family=isIP(address);
  if(family===4)return !blocked.check(address,"ipv4");
  if(family===6){
    const lower=address.toLowerCase();
    // IPv4-mapped/compatible forms are judged by their embedded IPv4 address.
    const mapped=/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if(mapped)return false;
    return !blocked.check(lower,"ipv6");
  }
  return false;
}

export type TargetPushResolver=(hostname:string)=>Promise<{address:string;family:number}[]>;
export type TargetPushTransport=(request:{
  url:URL;address:string;family:number;method:string;
  headers:Record<string,string|number>;body:Buffer|null;timeoutMs:number;
})=>Promise<number>;

const defaultResolver:TargetPushResolver=hostname=>dnsLookup(hostname,{all:true,verbatim:true});

/** One request to a pre-checked address; resolves with the HTTP status. */
export const defaultTargetPushTransport:TargetPushTransport=request=>new Promise((resolve,reject)=>{
  const secure=request.url.protocol==="https:";
  const options:https.RequestOptions={
    method:request.method,
    hostname:request.url.hostname,
    port:request.url.port||(secure?443:80),
    path:request.url.pathname+request.url.search,
    headers:request.headers,
    // Never a proxy or a connection-pool agent: each request owns its socket.
    agent:false,
    // Connect to exactly the checked address; SNI and certificate check still use the hostname.
    lookup:((_host:string,options:{all?:boolean},callback:(...args:unknown[])=>void)=>{
      if(options?.all)callback(null,[{address:request.address,family:request.family}]);
      else callback(null,request.address,request.family);
    }) as unknown as https.RequestOptions["lookup"],
    timeout:request.timeoutMs,
  };
  const req=(secure?https:http).request(options,response=>{
    let size=0;
    response.on("data",(chunk:Buffer)=>{
      size+=chunk.length;
      if(size>MAX_RESPONSE_BYTES)req.destroy(new Error("response too large"));
    });
    response.on("end",()=>resolve(response.statusCode??0));
    response.on("error",reject);
  });
  req.on("timeout",()=>req.destroy(new Error("timeout")));
  req.on("error",reject);
  if(request.body)req.write(request.body);
  req.end();
});

export interface TargetWebPushSenderOptions {
  readonly vapid:TargetVapidConfig;
  /** The device secret of the user's OWN live target, or null. */
  readonly subscriptionFor:(userId:string,targetId:string)=>TargetPushSubscription|null|Promise<TargetPushSubscription|null>;
  readonly env?:TargetPushEnv;
  readonly resolve?:TargetPushResolver;
  readonly transport?:TargetPushTransport;
  readonly timeoutMs?:number;
}

/** Encrypt and deliver one payload to one subscription. Never throws. */
export async function sendTargetWebPush(
  subscription:TargetPushSubscription,payload:TargetPushPayload,
  options:Omit<TargetWebPushSenderOptions,"subscriptionFor">,
):Promise<TargetPushSendResult> {
  const env=options.env??process.env;
  try{
    if(!allowedTargetPushEndpoint(subscription.endpoint,env))return "failed";
    const body=JSON.stringify({title:payload.title,body:payload.body,url:payload.url,tag:payload.tag});
    if(Buffer.byteLength(body,"utf8")>TARGET_PUSH_MAX_PAYLOAD_BYTES)return "failed";
    const url=new URL(subscription.endpoint);
    const test=targetPushTestOrigin(env);
    let address:string,family:number;
    if(test!==null&&url.origin===test){
      address="127.0.0.1";family=4;
    }else{
      const resolved=await (options.resolve??defaultResolver)(url.hostname);
      // Every answer must be public: a mixed answer could be steered to a private one.
      if(!resolved.length||resolved.some(r=>!publicPushAddress(r.address)))return "failed";
      ({address,family}=resolved[0]);
    }
    const details=webpush.generateRequestDetails(
      {endpoint:subscription.endpoint,keys:{p256dh:subscription.p256dh,auth:subscription.auth}},
      body,
      {vapidDetails:{subject:options.vapid.subject,publicKey:options.vapid.publicKey,
        privateKey:options.vapid.privateKey},
       TTL:TARGET_PUSH_TTL_SECONDS,contentEncoding:"aes128gcm",urgency:"normal"},
    );
    if(details.endpoint!==subscription.endpoint)return "failed";
    const headers:Record<string,string|number>={};
    for(const [name,value] of Object.entries(details.headers??{}))
      if(typeof value==="string"||typeof value==="number")headers[name]=value;
    const status=await (options.transport??defaultTargetPushTransport)({
      url,address,family,method:details.method,headers,
      body:details.body?Buffer.from(details.body):null,
      timeoutMs:options.timeoutMs??TARGET_PUSH_REQUEST_TIMEOUT_MS,
    });
    if(status>=200&&status<300)return "sent";
    if(status===404||status===410)return "gone";
    return "failed";
  }catch{
    return "failed";
  }
}

/** TargetPushSender for the identity-bound attention pass. */
export function createTargetWebPushSender(options:TargetWebPushSenderOptions):TargetPushSender {
  return {
    async sendTo(userId,targetId,payload){
      let subscription:TargetPushSubscription|null;
      try{subscription=await options.subscriptionFor(userId,targetId);}catch{return "failed";}
      // No secret (yet): retry later rather than revoking a device the user just added.
      if(!subscription)return "failed";
      return sendTargetWebPush(subscription,payload,options);
    },
  };
}
