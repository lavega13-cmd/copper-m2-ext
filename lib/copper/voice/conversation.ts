// One voice conversation, whichever provider carries it: keeps the current
// spoken turn, runs every tool call through the server (the same five tool
// functions as the chat) and sends the results back to the model.
import type { LinkAction, ToolReply } from "@/lib/copper/voice/link";
import type { VoiceToolResult } from "@/lib/copper/voice/tools";
import {
  nextVoiceTurn,
  type VoiceEvent,
  type VoiceTurn,
} from "@/lib/copper/voice/turn";

type Options = {
  /** Runs one tool on the server. */
  runTool: (name: string, args: unknown) => Promise<VoiceToolResult>;
  /** Hands tool results back to the model. */
  reply: (replies: ToolReply[]) => void;
  onTurn: (turn: VoiceTurn) => void;
};

export function createConversation({ runTool, reply, onTurn }: Options) {
  let turn: VoiceTurn | null = null;
  let nextId = 1;

  function apply(event: VoiceEvent) {
    const next = nextVoiceTurn(turn, event, nextId);
    if (!next || next === turn) return;
    if (next.id === nextId) nextId += 1;
    turn = next;
    onTurn(next);
  }

  async function handle(action: LinkAction): Promise<void> {
    if (action.type === "event") return apply(action.event);
    if (action.type !== "tool-calls") return;

    const replies = await Promise.all(
      action.calls.map(async ({ id, name, args }): Promise<ToolReply> => {
        apply({ type: "tool-call", id, name, input: args });
        const result = await runTool(name, args).catch((): VoiceToolResult => ({
          ok: false,
          error: "The tool couldn't run just now.",
        }));
        apply({
          type: "tool-result",
          id,
          ok: result.ok,
          output: result.ok ? result.output : result.error,
        });
        return {
          id,
          name,
          result: result.ok ? result.output : { error: result.error },
        };
      }),
    );
    reply(replies);
  }

  return {
    handle,
    /** Closes off a turn left open when the line drops. */
    finish: () => apply({ type: "done" }),
  };
}
