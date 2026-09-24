import type{AgentDefinition}from"./agents";import type{ContextBundle}from"./context";import type{ToolCall}from"./tools";
export interface AIMessage{role:"user"|"assistant";content:string}
export interface AIResponse{message:string;toolCalls?:ToolCall[]}
export interface AIProvider{complete(input:{agent:AgentDefinition;messages:AIMessage[];context?:ContextBundle|null}):Promise<AIResponse>}
export class LocalPreviewProvider implements AIProvider{async complete({messages,context}:Parameters<AIProvider["complete"]>[0]):Promise<AIResponse>{const q=messages[messages.length-1]?.content||"";if(!context)return{message:"AI provider is not connected yet. Core tools and local data are ready."};return{message:"Context ready: "+context.focus.title+" with "+context.related.length+" related entities. Provider connection will turn this into a model response. Query: "+q}}}
