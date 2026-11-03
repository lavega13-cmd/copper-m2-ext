// A spoken question and Copper's spoken answer, kept as the same Progress the
// chat draws, so voice answers get the same tool cards as typed ones.
import type { Progress, Step } from "@/lib/copper/assistant/progress";

export type VoiceTurn = { id: number; question: string; progress: Progress };

export type VoiceEvent =
  | { type: "heard"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; output: unknown; ok: boolean }
  | { type: "said"; text: string }
  | { type: "done" };

/**
 * The turn after `event`. Anything but "done" arriving after a finished turn
 * starts a new one, numbered `nextId`. Always a fresh copy, never a mutation.
 */
export function nextVoiceTurn(
  turn: VoiceTurn | null,
  event: VoiceEvent,
  nextId: number,
): VoiceTurn | null {
  if (event.type === "done") {
    if (!turn || turn.progress.status !== "working") return turn;
    return { ...turn, progress: { ...turn.progress, status: "done" } };
  }

  const current: VoiceTurn =
    turn && turn.progress.status === "working"
      ? turn
      : {
          id: nextId,
          question: "",
          progress: { steps: [], reply: "", status: "working" },
        };
  const steps: Step[] = current.progress.steps.map((step) => ({ ...step }));

  switch (event.type) {
    case "heard":
      return {
        ...current,
        question: current.question + event.text,
        progress: { ...current.progress, steps },
      };
    case "said":
      return {
        ...current,
        progress: {
          ...current.progress,
          steps,
          reply: current.progress.reply + event.text,
        },
      };
    case "tool-call":
      steps.push({
        type: "tool",
        id: event.id,
        name: event.name,
        state: "calling",
        input: event.input,
      });
      return { ...current, progress: { ...current.progress, steps } };
    case "tool-result":
      return {
        ...current,
        progress: {
          ...current.progress,
          steps: steps.map((step) =>
            step.type === "tool" && step.id === event.id
              ? {
                  ...step,
                  output: event.output,
                  state: event.ok ? "done" : "error",
                }
              : step,
          ),
        },
      };
  }
}
