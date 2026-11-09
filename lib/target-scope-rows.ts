/** R3-FE-3: presentation only. Groups the rows the server returned by their
 * Area (first appearance order, row order inside a group untouched). Nothing
 * is dropped, added, counted or re-ranked here, so the rendered rows are
 * exactly the server's rows. */
import type {GlobalIndexItem} from "./target-staging-global-index-client";

export type IndexRowGroup={
  areaId:string;areaKind:"private"|"shared";items:GlobalIndexItem[];
};

export function groupIndexRowsByArea(rows:readonly GlobalIndexItem[]):IndexRowGroup[]{
  const groups:IndexRowGroup[]=[];
  const byArea=new Map<string,IndexRowGroup>();
  for(const entry of rows){
    let group=byArea.get(entry.item.areaId);
    if(!group){
      group={areaId:entry.item.areaId,areaKind:entry.item.areaKind,items:[]};
      byArea.set(entry.item.areaId,group);
      groups.push(group);
    }
    group.items.push(entry);
  }
  return groups;
}
