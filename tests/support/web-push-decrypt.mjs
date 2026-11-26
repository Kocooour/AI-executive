// Test-only RFC 8291 (aes128gcm) Web Push decryption with a synthetic browser key
// pair, so tests and the fake push server can prove exactly what a device received.
import {createDecipheriv,createECDH,createHmac,randomBytes} from "node:crypto";

const hmac=(key,data)=>createHmac("sha256",key).update(data).digest();

/** A synthetic browser subscription key pair (never a real device). */
export function syntheticBrowserKeys(){
  const ecdh=createECDH("prime256v1");
  ecdh.generateKeys();
  const auth=randomBytes(16);
  return {
    ecdh,auth,
    keys:{p256dh:ecdh.getPublicKey().toString("base64url"),auth:auth.toString("base64url")},
  };
}

/** Decrypt one aes128gcm push body for the given synthetic browser keys. */
export function decryptWebPush(body,{ecdh,auth}){
  const buffer=Buffer.from(body);
  const salt=buffer.subarray(0,16);
  const idLength=buffer[20];
  const serverPublic=buffer.subarray(21,21+idLength);
  const ciphertext=buffer.subarray(21+idLength);
  const shared=ecdh.computeSecret(serverPublic);
  const prkKey=hmac(auth,shared);
  const keyInfo=Buffer.concat([Buffer.from("WebPush: info\0"),ecdh.getPublicKey(),serverPublic,Buffer.from([1])]);
  const ikm=hmac(prkKey,keyInfo);
  const prk=hmac(salt,ikm);
  const cek=hmac(prk,Buffer.from("Content-Encoding: aes128gcm\0\x01","binary")).subarray(0,16);
  const nonce=hmac(prk,Buffer.from("Content-Encoding: nonce\0\x01","binary")).subarray(0,12);
  const decipher=createDecipheriv("aes-128-gcm",cek,nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length-16));
  const plain=Buffer.concat([decipher.update(ciphertext.subarray(0,ciphertext.length-16)),decipher.final()]);
  let end=plain.length-1;
  while(end>=0&&plain[end]===0)end--;
  if(plain[end]!==2)throw new Error("missing last-record delimiter");
  return plain.subarray(0,end).toString("utf8");
}
