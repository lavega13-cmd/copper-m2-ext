// A spoken question and Copper's spoken answer, kept as the same Progress the
// chat draws, so voice answers get the same tool cards as typed ones.
import type { Progress, Step } from "@/lib/copper/assistant/progress";

export type VoiceTurn = {
  id: number;
  question: string;
  progress: Progress;
  /** Dollar figures Copper said that no tool returned, set once the turn is done. */
  ungrounded?: string[];
};

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
    const progress: Progress = { ...turn.progress, status: "done" };
    return { ...turn, progress, ungrounded: ungroundedFigures(progress) };
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

/** "$1,299.50" or "307 dollars" → 1299.5 / 307. */
const MONEY =
  /\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:dollars|bucks)\b/gi;

/** Every number anywhere inside a tool's output. */
function numbersIn(value: unknown, into: Set<number>) {
  if (typeof value === "number") into.add(Math.round(value * 100) / 100);
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, into));
  else if (value && typeof value === "object")
    Object.values(value).forEach((v) => numbersIn(v, into));
}

/**
 * Dollar figures in Copper's reply that no finished tool call returned. Voice
 * models are weaker at tools than chat models, so the panel flags these rather
 * than trusting them. Catches figures written as digits, which is how the
 * transcripts write money.
 */
export function ungroundedFigures(progress: Progress): string[] {
  const known = new Set<number>();
  for (const step of progress.steps)
    if (step.type === "tool" && step.state === "done")
      numbersIn(step.output, known);
  const missing: string[] = [];
  for (const match of progress.reply.matchAll(MONEY)) {
    const value = Number((match[1] ?? match[2]).replace(/,/g, ""));
    if (!known.has(Math.round(value * 100) / 100))
      missing.push(match[0].trim());
  }
  return missing;
}
