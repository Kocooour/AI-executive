import Dexie,{type Table}from"dexie";
export type EntityType="area"|"project"|"task"|"note";
export interface Entity{id:string;type:EntityType;title:string;content?:string;status:string;workspaceId:string;properties:Record<string,unknown>;createdAt:number;updatedAt:number}
class ExecutiveDB extends Dexie{entities!:Table<Entity,string>;constructor(){super("ai-executive");this.version(1).stores({entities:"id,type,status,workspaceId,updatedAt"})}}
export const db=new ExecutiveDB();
export async function seed(){if(await db.entities.count())return;const now=Date.now();await db.entities.bulkAdd([
{id:crypto.randomUUID(),type:"task",title:"Zavolat Petrovi",status:"open",workspaceId:"personal",properties:{area:"Work · Nabídka",today:true,inbox:false},createdAt:now,updatedAt:now},
{id:crypto.randomUUID(),type:"task",title:"Objednat servis",status:"open",workspaceId:"personal",properties:{area:"Cars",today:true,inbox:false},createdAt:now,updatedAt:now},
{id:crypto.randomUUID(),type:"task",title:"Koupit filtr",status:"open",workspaceId:"personal",properties:{area:"Home",today:true,inbox:false},createdAt:now,updatedAt:now}])}