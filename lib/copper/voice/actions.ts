"use server";

// The two Server Actions voice mode calls from the browser. A Server Action,
// not an API route, so the site stays a single page (AC-1.4).
import {
  createVoiceSession,
  type VoiceSession,
} from "@/lib/copper/voice/session";
import { runCopperTool, type VoiceToolResult } from "@/lib/copper/voice/tools";

/** A one-use Gemini Live token, or null when no AI key is set or Gemini says no. */
export async function startVoice(): Promise<VoiceSession | null> {
  try {
    return await createVoiceSession();
  } catch (error) {
    console.error(
      "[voice] token",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Runs one of Copper's five tools for voice mode. */
export async function runVoiceTool(
  name: string,
  args: unknown,
): Promise<VoiceToolResult> {
  return runCopperTool(name, args);
}
