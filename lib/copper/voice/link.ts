// The browser's line to a voice provider. Each provider's messages become the
// same few actions (audio to play, a barge-in, words heard or said, tool calls,
// end of turn), so the conversation above it never knows which one it's using.
import type { LiveServerMessage } from "@google/genai";
import { encodePcm16, INPUT_RATE, OUTPUT_RATE } from "@/lib/copper/voice/pcm";
import type { VoiceSession } from "@/lib/copper/voice/session";
import type { VoiceEvent } from "@/lib/copper/voice/turn";

export type ToolCall = { id: string; name: string; args: unknown };
export type ToolReply = { id: string; name: string; result: unknown };

export type LinkAction =
  | { type: "audio"; data: string }
  | { type: "interrupted" }
  | { type: "event"; event: VoiceEvent }
  | { type: "tool-calls"; calls: ToolCall[] };

export type VoiceLink = {
  /** The sample rate sendAudio expects. */
  inputRate: number;
  sendAudio(samples: Float32Array): void;
  sendToolReplies(replies: ToolReply[]): void;
  close(): void;
};

type Handlers = {
  onAction: (action: LinkAction) => void;
  onClose: (reason: "error" | "closed") => void;
};

// ---------------------------------------------------------------------------
// Gemini Live
// ---------------------------------------------------------------------------

/** One Gemini Live message as actions, in the order they should happen. */
export function geminiActions(message: LiveServerMessage): LinkAction[] {
  const actions: LinkAction[] = [];
  const content = message.serverContent;
  if (content?.interrupted) actions.push({ type: "interrupted" });
  if (content?.inputTranscription?.text)
    actions.push({
      type: "event",
      event: { type: "heard", text: content.inputTranscription.text },
    });
  for (const part of content?.modelTurn?.parts ?? []) {
    const data = part.inlineData?.data;
    if (data && part.inlineData?.mimeType?.startsWith("audio/"))
      actions.push({ type: "audio", data });
  }
  if (content?.outputTranscription?.text)
    actions.push({
      type: "event",
      event: { type: "said", text: content.outputTranscription.text },
    });
  const calls = message.toolCall?.functionCalls ?? [];
  if (calls.length)
    actions.push({
      type: "tool-calls",
      calls: calls.map((call, i) => ({
        id: call.id ?? `${call.name}-${i}`,
        name: call.name ?? "",
        args: call.args ?? {},
      })),
    });
  if (content?.turnComplete)
    actions.push({ type: "event", event: { type: "done" } });
  return actions;
}

async function connectGemini(
  session: Extract<VoiceSession, { provider: "gemini" }>,
  { onAction, onClose }: Handlers,
): Promise<VoiceLink> {
  const { GoogleGenAI, Modality } = await import("@google/genai");
  const ai = new GoogleGenAI({
    apiKey: session.token,
    httpOptions: { apiVersion: "v1alpha" },
  });
  const live = await ai.live.connect({
    model: session.model,
    // The token locks the real settings on the server; this is only the shape.
    config: { responseModalities: [Modality.AUDIO] },
    callbacks: {
      onmessage: (message) => geminiActions(message).forEach(onAction),
      onerror: () => onClose("error"),
      onclose: () => onClose("closed"),
    },
  });
  return {
    inputRate: INPUT_RATE,
    sendAudio: (samples) =>
      live.sendRealtimeInput({
        audio: {
          data: encodePcm16(samples),
          mimeType: `audio/pcm;rate=${INPUT_RATE}`,
        },
      }),
    sendToolReplies: (replies) =>
      live.sendToolResponse({
        functionResponses: replies.map(({ id, name, result }) => ({
          id,
          name,
          response: { result },
        })),
      }),
    close: () => live.close(),
  };
}

// ---------------------------------------------------------------------------
// xAI Grok Voice (OpenAI Realtime-style events)
// ---------------------------------------------------------------------------

/** What xAI's stream needs remembered between events. */
export type XaiState = { heard: Map<string, string>; calls: ToolCall[] };

export const newXaiState = (): XaiState => ({ heard: new Map(), calls: [] });

/**
 * One xAI server event as actions. Tool calls are held until the response is
 * done, because every result has to go back before asking for the next one.
 * Event names follow xAI's docs, plus the OpenAI Realtime names it mirrors.
 */
export function xaiActions(
  event: Record<string, unknown>,
  state: XaiState,
): LinkAction[] {
  const text = (key: string) =>
    typeof event[key] === "string" ? (event[key] as string) : "";
  switch (event.type) {
    case "response.output_audio.delta":
    case "response.audio.delta":
      return text("delta") ? [{ type: "audio", data: text("delta") }] : [];
    case "input_audio_buffer.speech_started":
      return [{ type: "interrupted" }];
    case "conversation.item.input_audio_transcription.updated":
    case "conversation.item.input_audio_transcription.delta":
    case "conversation.item.input_audio_transcription.completed": {
      // xAI sends the whole transcript so far; pass on only what's new.
      const id = text("item_id") || "item";
      const sofar = state.heard.get(id) ?? "";
      const full =
        text("transcript") ||
        (event.type.endsWith(".delta") ? sofar + text("delta") : sofar);
      state.heard.set(id, full);
      const added = full.startsWith(sofar) ? full.slice(sofar.length) : "";
      return added
        ? [{ type: "event", event: { type: "heard", text: added } }]
        : [];
    }
    case "response.output_audio_transcript.delta":
    case "response.audio_transcript.delta":
      return text("delta")
        ? [{ type: "event", event: { type: "said", text: text("delta") } }]
        : [];
    case "response.function_call_arguments.done": {
      let args: unknown = {};
      try {
        args = JSON.parse(text("arguments") || "{}");
      } catch {
        args = { unreadable: text("arguments") };
      }
      state.calls.push({ id: text("call_id"), name: text("name"), args });
      return [];
    }
    case "response.done": {
      if (state.calls.length === 0)
        return [{ type: "event", event: { type: "done" } }];
      const calls = state.calls;
      state.calls = [];
      return [{ type: "tool-calls", calls }];
    }
    default:
      return [];
  }
}

async function connectXai(
  session: Extract<VoiceSession, { provider: "xai" }>,
  { onAction, onClose }: Handlers,
): Promise<VoiceLink> {
  const socket = new WebSocket(
    `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(session.model)}`,
    [`xai-client-secret.${session.token}`],
  );
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  const state = newXaiState();

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("xAI voice didn't connect"));
  });
  socket.onerror = () => onClose("error");
  socket.onclose = () => onClose("closed");
  socket.onmessage = (message) => {
    try {
      xaiActions(JSON.parse(String(message.data)), state).forEach(onAction);
    } catch {
      /* not JSON: ignore */
    }
  };

  send({
    type: "session.update",
    session: {
      instructions: session.instructions,
      tools: session.tools,
      turn_detection: { type: "server_vad" },
      audio: {
        input: {
          format: { type: "audio/pcm", rate: OUTPUT_RATE },
          transcription: { model: "grok-transcribe" },
        },
        output: { format: { type: "audio/pcm", rate: OUTPUT_RATE } },
      },
    },
  });

  return {
    inputRate: OUTPUT_RATE,
    sendAudio: (samples) =>
      send({ type: "input_audio_buffer.append", audio: encodePcm16(samples) }),
    sendToolReplies: (replies) => {
      for (const { id, result } of replies)
        send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: id,
            output: JSON.stringify(result),
          },
        });
      send({ type: "response.create" });
    },
    close: () => socket.close(),
  };
}

/** Opens the provider the server picked. */
export function connectVoice(
  session: VoiceSession,
  handlers: Handlers,
): Promise<VoiceLink> {
  return session.provider === "xai"
    ? connectXai(session, handlers)
    : connectGemini(session, handlers);
}
