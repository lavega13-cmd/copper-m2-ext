"use server";

// The two Server Actions voice mode calls from the browser. A Server Action,
// not an API route, so the site stays a single page (AC-1.4).
import {
  createVoiceSession,
  type VoiceSession,
} from "@/lib/copper/voice/session";
import { runCopperTool, type VoiceToolResult } from "@/lib/copper/voice/tools";

/**
 * A one-use voice token, or a short reason when voice can't start (no key, or
 * the provider said no). The reason never contains the key.
 */
export async function startVoice(): Promise<
  { session: VoiceSession } | { reason: string }
> {
  try {
    const session = await createVoiceSession();
    return session ? { session } : { reason: "no voice key is set" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[voice] token", reason);
    return { reason: reason.slice(0, 300) };
  }
}

/** Runs one of Copper's five tools for voice mode. */
export async function runVoiceTool(
  name: string,
  args: unknown,
): Promise<VoiceToolResult> {
  return runCopperTool(name, args);
}
