"use client";

// Talk to Copper: speech in, speech out. The browser gets a short-lived token
// from startVoice() (the API key never leaves the server), opens the voice
// provider the server picked (Gemini Live by default, Grok Voice with
// VOICE_PROVIDER=xai), streams the microphone up and plays Copper's voice
// back. When Copper needs a fact it calls one of the same five tools as the
// chat, run on the server by runVoiceTool(), and each call shows as a tool card.
import { MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { runVoiceTool, startVoice } from "@/lib/copper/voice/actions";
import { createConversation } from "@/lib/copper/voice/conversation";
import { connectVoice, type VoiceLink } from "@/lib/copper/voice/link";
import { decodePcm16, downsample, OUTPUT_RATE } from "@/lib/copper/voice/pcm";
import type { VoiceTurn } from "@/lib/copper/voice/turn";

type Phase = "idle" | "connecting" | "live";

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

  const link = useRef<VoiceLink | null>(null);
  const finish = useRef<(() => void) | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const micContext = useRef<AudioContext | null>(null);
  const playContext = useRef<AudioContext | null>(null);
  const playing = useRef(new Set<AudioBufferSourceNode>());
  const playAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTurnRef = useRef(onTurn);
  useEffect(() => {
    onTurnRef.current = onTurn;
  }, [onTurn]);

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

  function stop(message = "") {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const open = link.current;
    link.current = null;
    try {
      open?.close();
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
    finish.current?.();
    finish.current = null;
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

      const started = await startVoice();
      if ("reason" in started) {
        console.warn("[voice] unavailable:", started.reason);
        stop("Voice isn't available right now. Type your question instead.");
        return;
      }
      const session = started.session;

      const conversation = createConversation({
        runTool: runVoiceTool,
        reply: (replies) => link.current?.sendToolReplies(replies),
        onTurn: (turn) => onTurnRef.current(turn),
      });
      finish.current = conversation.finish;
      link.current = await connectVoice(session, {
        onAction: (action) => {
          if (action.type === "audio") play(action.data);
          else if (action.type === "interrupted") stopPlayback();
          else void conversation.handle(action);
        },
        onClose: (reason) => {
          if (!link.current) return;
          stop(
            reason === "error"
              ? "Voice dropped. Tap to talk again, or type below."
              : "Voice ended. Tap to talk again.",
          );
        },
      });

      const mic = micContext.current;
      const rate = link.current.inputRate;
      const chunk = rate / 10; // about 100 ms per message
      const url = URL.createObjectURL(
        new Blob([MIC_WORKLET], { type: "application/javascript" }),
      );
      await mic.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(mic, "copper-mic");
      let pending: number[] = [];
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        for (const s of downsample(event.data, mic.sampleRate, rate))
          pending.push(s);
        if (pending.length < chunk) return;
        const samples = Float32Array.from(pending);
        pending = [];
        link.current?.sendAudio(samples);
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
      if (link.current || stream.current) stop();
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
