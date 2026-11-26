/** E-1: server-authored explanation of an already authorized candidate.
 * No additional reads, task titles, or private data beyond the read DTO.
 * The pinned evaluation instant and actor profile zone are never client inputs. */
export type AttentionExplanationLanguage="cs"|"en";
export type AttentionExplanation={attentionKey:string;reason:string;why:string};
type Source={attentionKey:string;reasonCode:"deadline_overdue"|"deadline_soon"|"planned_date_passed";relevantOn:string;thresholdHours:0|48};
export function explainAttention(
  item:Source, evaluatedAtMs:number,timeZone:string,language:AttentionExplanationLanguage,
):AttentionExplanation{
  const locale=language==="cs"?"cs-CZ":"en-GB";
  const date=new Intl.DateTimeFormat(locale,{dateStyle:"medium",timeZone:"UTC"})
    .format(new Date(item.relevantOn+"T12:00:00Z"));
  const evaluated=new Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"short",timeZone})
    .format(evaluatedAtMs);
  const planned=item.reasonCode==="planned_date_passed";
  const reason=language==="cs"
    ?(planned?"Propadlé Kdy":item.reasonCode==="deadline_overdue"?"Po termínu":"Termín do "+item.thresholdHours+" hodin")
    :(planned?"Planned day passed":item.reasonCode==="deadline_overdue"?"Overdue":"Due within "+item.thresholdHours+" hours");
  const source=language==="cs"?(planned?"Zdroj: osobní plán (Kdy)":"Zdroj: termín úkolu")
    :(planned?"Source: personal plan (When)":"Source: task deadline");
  return {attentionKey:item.attentionKey,reason:reason+" · "+date,
    why:source+" ("+date+"). "+(language==="cs"?"Vyhodnoceno: ":"Evaluated: ")+evaluated+"."};
}
