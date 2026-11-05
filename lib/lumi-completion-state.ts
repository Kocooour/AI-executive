/** UI-04b: presentation-only completion state. Never infer ACL from colors. */
import type {Entity} from "./db";
import {taskDueTone} from "./task-views";

export type LumiCompletionTone="plain"|"warning"|"danger"|"complete";

/** A deadline or explicitly high priority draws a contour, never a fill. */
export function taskPreviewCompletionTone(task:Entity,today:string):LumiCompletionTone{
  if(task.status==="completed")return "complete";
  if(task.type!=="task"||task.status!=="open")return "plain";
  const due=taskDueTone(task,today);
  if(due==="dueOverdue")return "danger";
  if(due==="dueSoon"||task.properties.priority==="high")return "warning";
  return "plain";
}

export function taskPreviewStateText(tone:LumiCompletionTone,language:string):string{
  const cs=language==="cs";
  if(tone==="complete")return cs?"Dokončený úkol":"Completed task";
  if(tone==="danger")return cs?"Úkol po termínu":"Overdue task";
  if(tone==="warning")return cs?"Úkol vyžaduje pozornost":"Task needs attention";
  return cs?"Nedokončený úkol":"Open task";
}
