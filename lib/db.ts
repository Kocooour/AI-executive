import Dexie,{type Table}from"dexie";
export type EntityType="area"|"project"|"task"|"note";
export interface Entity{id:string;type:EntityType;title:string;content?:string;status:string;workspaceId:string;properties:Record<string,unknown>;createdAt:number;updatedAt:number}
export interface Relation{id:string;workspaceId:string;sourceEntityId:string;targetEntityId:string;relationType:string;createdAt:number}
class ExecutiveDB extends Dexie{entities!:Table<Entity,string>;relations!:Table<Relation,string>;constructor(){super("ai-executive");this.version(1).stores({entities:"id,type,status,workspaceId,updatedAt"});this.version(2).stores({entities:"id,type,status,workspaceId,updatedAt",relations:"id,workspaceId,sourceEntityId,targetEntityId,relationType"})}}
export const db=new ExecutiveDB();
export async function seed(){if(await db.entities.count())return;const now=Date.now(),area=crypto.randomUUID(),project=crypto.randomUUID();await db.entities.bulkAdd([
{id:area,type:"area",title:"Work",status:"active",workspaceId:"personal",properties:{},createdAt:now,updatedAt:now},
{id:project,type:"project",title:"AI Executive",status:"active",workspaceId:"personal",properties:{areaId:area},createdAt:now,updatedAt:now},
{id:crypto.randomUUID(),type:"note",title:"Product direction",content:"Local-first, calm and extensible.",status:"active",workspaceId:"personal",properties:{projectId:project},createdAt:now,updatedAt:now},
{id:crypto.randomUUID(),type:"task",title:"Zavolat Petrovi",status:"open",workspaceId:"personal",properties:{area:"Work",projectId:project,today:true,inbox:false},createdAt:now,updatedAt:now},
{id:crypto.randomUUID(),type:"task",title:"Objednat servis",status:"open",workspaceId:"personal",properties:{area:"Cars",today:true,inbox:false},createdAt:now,updatedAt:now}])}