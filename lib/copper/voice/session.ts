// Voice mode: mints a short-lived token so the browser can talk to the voice
// model directly. The real API key stays on the server. VOICE_PROVIDER picks
// the provider: "gemini" (default, free tier, uses the Google key already set)
// or "xai" (Grok Voice, paid, needs XAI_API_KEY).
import { GoogleGenAI, Modality, type LiveConnectConfig } from "@google/genai";
import { COPPER_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import { voiceToolDeclarations } from "@/lib/copper/voice/tools";

export type VoiceProvider = "gemini" | "xai";

/** Default model per provider; COPPER_VOICE_MODEL overrides it without a deploy. */
export const DEFAULT_VOICE_MODELS: Record<VoiceProvider, string> = {
  gemini: "gemini-3.8-live",
  // Pinned: xAI moves the -latest alias without notice.
  xai: "grok-voice-3.0",
};

export const COPPER_VOICE_INSTRUCTIONS = `${COPPER_INSTRUCTIONS}

You are talking out loud with a shopper. Shoppers may start with "Hey Copper". Keep each answer to one or two short sentences.
Never say a price, a total, a price difference or a stock level unless a tool gave it to you in this conversation. If you don't have it yet, call the tool first and wait for the result.`;

/** A function tool in the OpenAI Realtime shape xAI speaks. */
export type RealtimeTool = {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
};

export type VoiceSession =
  | { provider: "gemini"; token: string; model: string }
  | {
      provider: "xai";
      token: string;
      model: string;
      // xAI tokens can't carry a session, so the browser sends these itself.
      // Neither is secret: the tools still run on the server either way.
      instructions: string;
      tools: RealtimeTool[];
    };

const SESSION_MS = 15 * 60_000;
const START_WITHIN_MS = 60_000;

export function voiceProvider(): VoiceProvider {
  return process.env.VOICE_PROVIDER?.trim().toLowerCase() === "xai"
    ? "xai"
    : "gemini";
}

export async function createVoiceSession(): Promise<VoiceSession | null> {
  const provider = voiceProvider();
  const model =
    process.env.COPPER_VOICE_MODEL?.trim() || DEFAULT_VOICE_MODELS[provider];
  return provider === "xai" ? xaiSession(model) : geminiSession(model);
}

async function geminiSession(model: string): Promise<VoiceSession | null> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!apiKey) return null;

  // The token locks the model, instructions and tools: a browser can't change them.
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
  return { provider: "gemini", token: token.name, model };
}

async function xaiSession(model: string): Promise<VoiceSession | null> {
  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey) return null;

  const response = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
  });
  if (!response.ok) throw new Error(`xAI token: HTTP ${response.status}`);
  const body = (await response.json()) as {
    value?: string;
    client_secret?: { value?: string };
  };
  // OpenAI-style responses put it in `value`; older ones nest it.
  const token = body.value ?? body.client_secret?.value;
  if (!token) throw new Error("xAI returned no voice token");

  const tools = (await voiceToolDeclarations()).map((d): RealtimeTool => ({
    type: "function",
    name: d.name ?? "",
    description: d.description ?? "",
    parameters: d.parametersJsonSchema ?? { type: "object", properties: {} },
  }));
  return {
    provider: "xai",
    token,
    model,
    instructions: COPPER_VOICE_INSTRUCTIONS,
    tools,
  };
}
