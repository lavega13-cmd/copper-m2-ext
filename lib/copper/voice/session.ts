// Voice mode: mints a short-lived Gemini Live token so the browser can talk to
// Gemini directly. The real Google key stays on the server; the token is good
// for one session, must be used within a minute, and locks the model, Copper's
// instructions and the tool list, so a browser can't change any of them.
import { GoogleGenAI, Modality, type LiveConnectConfig } from "@google/genai";
import { COPPER_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import { voiceToolDeclarations } from "@/lib/copper/voice/tools";

/** Gemini Live model; COPPER_VOICE_MODEL overrides it without a deploy. */
export const DEFAULT_VOICE_MODEL = "gemini-3.8-live";

export const COPPER_VOICE_INSTRUCTIONS = `${COPPER_INSTRUCTIONS}

You are talking out loud with a shopper. Shoppers may start with "Hey Copper". Keep each answer to one or two short sentences.
Never say a price, a total, a price difference or a stock level unless a tool gave it to you in this conversation. If you don't have it yet, call the tool first and wait for the result.`;

export type VoiceSession = { token: string; model: string };

const SESSION_MS = 15 * 60_000;
const START_WITHIN_MS = 60_000;

export async function createVoiceSession(): Promise<VoiceSession | null> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!apiKey) return null;

  const model = process.env.COPPER_VOICE_MODEL?.trim() || DEFAULT_VOICE_MODEL;
  const config: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: COPPER_VOICE_INSTRUCTIONS,
    tools: [{ functionDeclarations: await voiceToolDeclarations() }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };

  // Ephemeral tokens are a v1alpha feature of the Gemini Developer API.
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "v1alpha" },
  });
  const now = Date.now();
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(now + SESSION_MS).toISOString(),
      newSessionExpireTime: new Date(now + START_WITHIN_MS).toISOString(),
      liveConnectConstraints: { model, config },
      lockAdditionalFields: [],
    },
  });
  if (!token.name) throw new Error("Gemini returned no voice token");
  return { token: token.name, model };
}
