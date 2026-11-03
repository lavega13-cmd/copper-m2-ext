// Voice mode uses the same five tools as the chat. This file turns
// copperTools into the function list Gemini Live is handed, and runs a call
// the browser passes back, checked against the tool's own contract first.
import { asSchema, type FlexibleSchema, type ToolExecutionOptions } from "ai";
import { Behavior, type FunctionDeclaration } from "@google/genai";
import { copperTools } from "@/lib/copper/assistant/tools";

export type VoiceToolResult =
  { ok: true; output: unknown } | { ok: false; error: string };

// Every tool seen the same way, whatever its own input and output types.
type AnyTool = {
  description: string;
  inputSchema: FlexibleSchema<unknown>;
  execute: (
    input: unknown,
    options: ToolExecutionOptions<unknown>,
  ) => PromiseLike<unknown>;
};
const tools = copperTools as unknown as Record<string, AnyTool>;

/** Every chat tool, described for Gemini Live. */
export async function voiceToolDeclarations(): Promise<FunctionDeclaration[]> {
  return Promise.all(
    Object.entries(tools).map(async ([name, tool]) => {
      const schema = await asSchema(tool.inputSchema).jsonSchema;
      const hasInput = Object.keys(schema.properties ?? {}).length > 0;
      return {
        name,
        description: tool.description,
        // Blocking: Copper waits for the numbers before it says anything.
        behavior: Behavior.BLOCKING,
        ...(hasInput ? { parametersJsonSchema: schema } : {}),
      };
    }),
  );
}

/** Runs one tool for voice mode, the same function the chat runs. */
export async function runCopperTool(
  name: string,
  args: unknown,
): Promise<VoiceToolResult> {
  if (!Object.hasOwn(tools, name))
    return { ok: false, error: `Unknown tool: ${name}` };
  const tool = tools[name];

  // The model's input goes through the tool's contract, exactly as in chat.
  const checked = await asSchema(tool.inputSchema).validate?.(args ?? {});
  if (checked && !checked.success)
    return {
      ok: false,
      error: `That input isn't allowed: ${checked.error.message}`,
    };

  try {
    const output = await tool.execute(checked ? checked.value : args, {
      toolCallId: `voice-${name}`,
      messages: [],
      context: undefined,
    });
    return { ok: true, output };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The tool failed.",
    };
  }
}
