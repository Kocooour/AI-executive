import{runTool,type ToolCall,type ToolResult}from"./tools";
export interface AgentDefinition{id:string;name:string;instructions:string;allowedTools:ToolCall["name"][]}
export const assistantAgent:AgentDefinition={id:"assistant",name:"Assistant",instructions:"Help the user work with their entities using only explicitly allowed tools.",allowedTools:["search_entities","get_entity","create_entity","update_entity","get_context"]};
export async function executeAgentTool(agent:AgentDefinition,call:ToolCall):Promise<ToolResult>{if(!agent.allowedTools.includes(call.name))return{ok:false,error:"Tool "+call.name+" is not allowed for agent "+agent.id};return runTool(call)}
