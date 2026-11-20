/** Browser-safe C-3a DTOs. Never import server-only SQLite or Node crypto into UI. */
export type TargetInboxTriageMode="process"|"undo";
export type TargetInboxItem={
  id:string;title:string;status:"open"|"completed";
  triageRevision:number;taskRevision:number;
  effectiveAreaId:string;canProcess:boolean;expectedRevision:string|null;
};
