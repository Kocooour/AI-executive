/** R3-FE-4a: ONE refusal budget per runtime, shared by every consumer (lists,
 * details, sidebar, plan). Per-hook budgets would multiply the allowed
 * refusal -> re-verify cycles with the number of mounted consumers. */
import {createRefusalBudget} from "./target-my-plan-embed";

const budgets=new WeakMap<object,ReturnType<typeof createRefusalBudget>>();
const orphan=createRefusalBudget();

export function refusalBudgetFor(runtime:object|null):ReturnType<typeof createRefusalBudget>{
  if(runtime===null)return orphan;
  let budget=budgets.get(runtime);
  if(!budget){budget=createRefusalBudget();budgets.set(runtime,budget);}
  return budget;
}
