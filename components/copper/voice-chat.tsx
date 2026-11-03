"use client";

// Talk to Copper: speech in, speech out, through Gemini Live. The browser gets
// a one-use token from startVoice() (the Google key never leaves the server),
// streams the microphone up and plays Copper's voice back. When Copper needs a
// fact it calls one of the same five tools as the chat, run on the server by
// runVoiceTool(), and each call shows up as the usual tool card.
import { MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { LiveServerMessage, Session } from "@google/genai";
import { Button } from "@/components/ui/button";
import { runVoiceTool, startVoice } from "@/lib/copper/voice/actions";
import {
  decodePcm16,
  downsample,
  encodePcm16,
  INPUT_RATE,
  OUTPUT_RATE,
} from "@/lib/copper/voice/pcm";
import {
  nextVoiceTurn,
  type VoiceEvent,
  type VoiceTurn,
} from "@/lib/copper/voice/turn";

type Phase = "idle" | "connecting" | "live";

/** Sends about 100 ms of audio per message. */
const CHUNK_SAMPLES = INPUT_RATE / 10;
/** Voice stops on its own after 5 minutes, to keep the free tier free. */
const MAX_SESSION_MS = 5 * 60_000;

// Copies each microphone frame out of the audio thread.
const MIC_WORKLET = `class CopperMic extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("copper-mic", CopperMic);`;

function voiceSupported() {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.AudioWorkletNode === "function"
  );
}

export function VoiceChat({
  onTurn,
  disabled = false,
}: {
  onTurn: (turn: VoiceTurn) => void;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState("");
  // Support is only known in the browser: the server snapshot is null.
  const supported = useSyncExternalStore(
    () => () => {},
    voiceSupported,
    () => null,
  );

  const session = useRef<Session | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const micContext = useRef<AudioContext | null>(null);
  const playContext = useRef<AudioContext | null>(null);
  const playing = useRef(new Set<AudioBufferSourceNode>());
  const playAt = useRef(0);
  const turn = useRef<VoiceTurn | null>(null);
  const nextId = useRef(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTurnRef = useRef(onTurn);
  useEffect(() => {
    onTurnRef.current = onTurn;
  }, [onTurn]);

  function apply(event: VoiceEvent) {
    const next = nextVoiceTurn(turn.current, event, nextId.current);
    if (!next || next === turn.current) return;
    if (next.id === nextId.current) nextId.current += 1;
    turn.current = next;
    onTurnRef.current(next);
  }

  function stopPlayback() {
    playing.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        /* already finished */
      }
    });
    playing.current.clear();
    playAt.current = 0;
  }

  function play(base64: string) {
    const context = playContext.current;
    if (!context) return;
    const samples = decodePcm16(base64);
    if (samples.length === 0) return;
    const buffer = context.createBuffer(1, samples.length, OUTPUT_RATE);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    // Queue each chunk right after the last, so the voice plays smoothly.
    const at = Math.max(context.currentTime, playAt.current);
    source.start(at);
    playAt.current = at + buffer.duration;
    playing.current.add(source);
    source.onended = () => playing.current.delete(source);
  }

  async function runTools(message: LiveServerMessage) {
    const calls = message.toolCall?.functionCalls ?? [];
    const responses = await Promise.all(
      calls.map(async (call) => {
        const id = call.id ?? `${call.name}-${Date.now()}`;
        const name = call.name ?? "";
        apply({ type: "tool-call", id, name, input: call.args ?? {} });
        const result = await runVoiceTool(name, call.args ?? {}).catch(() => ({
          ok: false as const,
          error: "The tool couldn't run just now.",
        }));
        apply({
          type: "tool-result",
          id,
          ok: result.ok,
          output: result.ok ? result.output : result.error,
        });
        return {
          id: call.id,
          name,
          response: result.ok
            ? { output: result.output }
            : { error: result.error },
        };
      }),
    );
    if (responses.length)
      session.current?.sendToolResponse({ functionResponses: responses });
  }

  function onMessage(message: LiveServerMessage) {
    const content = message.serverContent;
    if (content?.interrupted) stopPlayback();
    if (content?.inputTranscription?.text)
      apply({ type: "heard", text: content.inputTranscription.text });
    for (const part of content?.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data && part.inlineData?.mimeType?.startsWith("audio/")) play(data);
    }
    if (content?.outputTranscription?.text)
      apply({ type: "said", text: content.outputTranscription.text });
    if (message.toolCall) void runTools(message);
    if (content?.turnComplete) apply({ type: "done" });
  }

  function stop(message = "") {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const live = session.current;
    session.current = null;
    try {
      live?.close();
    } catch {
      /* already closed */
    }
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    stopPlayback();
    void micContext.current?.close().catch(() => {});
    void playContext.current?.close().catch(() => {});
    micContext.current = null;
    playContext.current = null;
    apply({ type: "done" });
    setNote(message);
    setPhase("idle");
  }

  async function start() {
    if (!voiceSupported()) return;
    setNote("");
    setPhase("connecting");
    try {
      // Ask for the microphone first, while the click still counts as a gesture.
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      playContext.current = new AudioContext();
      micContext.current = new AudioContext();

      const voice = await startVoice();
      if (!voice) {
        stop("Voice isn't available right now. Type your question instead.");
        return;
      }
      const { GoogleGenAI, Modality } = await import("@google/genai");
      const ai = new GoogleGenAI({
        apiKey: voice.token,
        httpOptions: { apiVersion: "v1alpha" },
      });
      session.current = await ai.live.connect({
        model: voice.model,
        // The token locks the real settings on the server; this is only the shape.
        config: { responseModalities: [Modality.AUDIO] },
        callbacks: {
          onmessage: onMessage,
          onerror: () =>
            stop("Voice dropped. Tap to talk again, or type below."),
          onclose: () => {
            if (session.current) stop("Voice ended. Tap to talk again.");
          },
        },
      });

      const mic = micContext.current;
      const url = URL.createObjectURL(
        new Blob([MIC_WORKLET], { type: "application/javascript" }),
      );
      await mic.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(mic, "copper-mic");
      let pending: number[] = [];
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const samples = downsample(event.data, mic.sampleRate);
        for (const s of samples) pending.push(s);
        if (pending.length < CHUNK_SAMPLES) return;
        const chunk = Float32Array.from(pending);
        pending = [];
        session.current?.sendRealtimeInput({
          audio: {
            data: encodePcm16(chunk),
            mimeType: `audio/pcm;rate=${INPUT_RATE}`,
          },
        });
      };
      // A silent output keeps the worklet running without echoing the mic.
      const mute = mic.createGain();
      mute.gain.value = 0;
      mic.createMediaStreamSource(stream.current).connect(node);
      node.connect(mute).connect(mic.destination);
      await Promise.all([mic.resume(), playContext.current.resume()]);

      timer.current = setTimeout(
        () => stop("Voice paused after 5 minutes. Tap to talk again."),
        MAX_SESSION_MS,
      );
      setPhase("live");
    } catch (error) {
      const denied =
        error instanceof DOMException && error.name === "NotAllowedError";
      stop(
        denied
          ? "Copper needs your microphone for voice. You can type instead."
          : "Voice couldn't start. Type your question instead.",
      );
    }
  }

  // Hang up if the panel goes away mid-conversation.
  useEffect(
    () => () => {
      if (session.current || stream.current) stop();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const status =
    phase === "connecting"
      ? "Connecting…"
      : phase === "live"
        ? "Listening. Ask about prices, totals, stock or a comparison."
        : note ||
          (supported === false
            ? "Voice needs Chrome or Edge. Type your question below."
            : "Talk with Copper out loud. Headphones work best.");

  return (
    <div
      data-testid="voice-chat"
      data-phase={phase}
      className="bg-background flex items-center gap-3 border-t px-3 py-2"
    >
      <Button
        type="button"
        size="sm"
        variant={phase === "live" ? "default" : "outline"}
        onClick={() => (phase === "live" ? stop() : void start())}
        disabled={
          supported !== true ||
          phase === "connecting" ||
          (disabled && phase === "idle")
        }
        className="h-10 shrink-0 gap-2 rounded-full px-4"
      >
        {phase === "live" ? (
          <SquareIcon aria-hidden="true" className="size-4" />
        ) : (
          <MicIcon aria-hidden="true" className="size-4" />
        )}
        {phase === "live" ? "Stop talking" : "Say “Hey Copper”"}
      </Button>
      {phase === "live" && (
        <span aria-hidden="true" className="flex h-6 items-center gap-0.5">
          {[0.5, 0.8, 1, 0.8, 0.5].map((height, i) => (
            <span
              key={i}
              style={{
                height: `${height * 100}%`,
                animationDelay: `${i * 120}ms`,
              }}
              className={`w-1 animate-pulse rounded-full ${i === 2 ? "bg-accent" : "bg-primary"}`}
            />
          ))}
        </span>
      )}
      <p
        role="status"
        aria-live="polite"
        className="text-muted-foreground min-w-0 flex-1 text-xs"
      >
        {status}
      </p>
    </div>
  );
}
