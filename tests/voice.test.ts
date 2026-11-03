// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceTurn } from "@/lib/copper/voice/turn";

// Voice mode: either provider gets the same five tools, every tool call runs
// the same code as the chat (checked against its contract first), the browser
// only ever sees a short-lived token, and a price Copper says out loud has to
// match what a tool returned.

const rows: Record<string, unknown>[] | null = [
  {
    sku: "CN-NSK",
    product: "Copper Notes",
    color: "Night Sky",
    units_in_stock: 0,
    next_shipment: "2026-11-14",
  },
];
vi.mock("@/lib/copper/inventory", () => ({
  readInventory: async () => structuredClone(rows),
}));

const created: unknown[] = [];
vi.mock("@google/genai", async (original) => {
  const real = await original<typeof import("@google/genai")>();
  class GoogleGenAI {
    constructor(public options: unknown) {}
    authTokens = {
      create: async (params: unknown) => {
        created.push({ options: this.options, params });
        return { name: "auth_tokens/one-use-token" };
      },
    };
  }
  return { ...real, GoogleGenAI };
});

const KEY = "AIza-test-key-not-real";
const XAI_KEY = "xai-test-key-not-real";

beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", KEY);
  vi.stubEnv("COPPER_VOICE_MODEL", "");
  vi.stubEnv("VOICE_PROVIDER", "");
  vi.stubEnv("XAI_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  created.length = 0;
});

const HOME_PLUS_2_YEARS = {
  products: ["copper-home"],
  plan: "copper-plus",
  billing: "annual",
  years: 2,
};

describe("voice tools", () => {
  it("hands the voice model all five chat tools, blocking, with their contracts", async () => {
    const { voiceToolDeclarations } = await import("@/lib/copper/voice/tools");
    const declarations = await voiceToolDeclarations();
    expect(declarations.map((d) => d.name).sort()).toEqual([
      "calculate_cost",
      "check_availability",
      "compare_products",
      "get_prices",
      "get_products",
    ]);
    for (const d of declarations) {
      expect(d.description, d.name).toMatch(/\w{4,}/);
      expect(d.behavior, d.name).toBe("BLOCKING");
    }
    const compare = declarations.find((d) => d.name === "compare_products");
    expect(compare?.parametersJsonSchema).toMatchObject({
      type: "object",
      properties: { products: { type: "array" } },
    });
    // No-input tools send no schema at all.
    expect(
      declarations.find((d) => d.name === "get_prices")?.parametersJsonSchema,
    ).toBeUndefined();
  });

  it("runs the same functions as the chat", async () => {
    const { runCopperTool } = await import("@/lib/copper/voice/tools");
    const { calculateCost, compareProducts } =
      await import("@/lib/copper/assistant/tools");
    expect(await runCopperTool("calculate_cost", HOME_PLUS_2_YEARS)).toEqual({
      ok: true,
      output: calculateCost({
        products: ["copper-home"],
        plan: "copper-plus",
        billing: "annual",
        years: 2,
      }),
    });
    const compare = {
      products: ["copper-home", "copper-notes"] as (
        "copper-home" | "copper-notes"
      )[],
    };
    expect(await runCopperTool("compare_products", compare)).toEqual({
      ok: true,
      output: await compareProducts(compare),
    });
    const stock = await runCopperTool("check_availability", {
      product: "copper-notes",
      color: "night sky",
    });
    expect(stock).toMatchObject({
      ok: true,
      output: { colors: [{ stock: "backordered", restockDate: "2026-11-14" }] },
    });
  });

  it("refuses input outside a tool's contract, and tools that don't exist", async () => {
    const { runCopperTool } = await import("@/lib/copper/voice/tools");
    const tooLong = await runCopperTool("calculate_cost", {
      products: [],
      plan: "free",
      billing: "annual",
      years: 6,
    });
    expect(tooLong.ok).toBe(false);
    const same = await runCopperTool("compare_products", {
      products: ["copper-home", "copper-home"],
    });
    expect(same.ok).toBe(false);
    expect(await runCopperTool("refund_order", {})).toEqual({
      ok: false,
      error: "Unknown tool: refund_order",
    });
    expect((await runCopperTool("toString", {})).ok).toBe(false);
  });
});

describe("voice session", () => {
  it("defaults to Gemini Live: a one-use token that locks the model, instructions and tools, never the key", async () => {
    const {
      createVoiceSession,
      COPPER_VOICE_INSTRUCTIONS,
      DEFAULT_VOICE_MODELS,
    } = await import("@/lib/copper/voice/session");
    const session = await createVoiceSession();
    expect(session).toEqual({
      provider: "gemini",
      token: "auth_tokens/one-use-token",
      model: "gemini-3.8-live",
    });
    expect(DEFAULT_VOICE_MODELS.gemini).toBe("gemini-3.8-live");
    expect(JSON.stringify(session)).not.toContain(KEY);

    const [{ options, params }] = created as {
      options: { apiKey: string; httpOptions: { apiVersion: string } };
      params: {
        config: {
          uses: number;
          lockAdditionalFields: string[];
          newSessionExpireTime: string;
          liveConnectConstraints: {
            model: string;
            config: {
              systemInstruction: string;
              tools: { functionDeclarations: unknown[] }[];
              outputAudioTranscription: unknown;
            };
          };
        };
      };
    }[];
    expect(options.apiKey).toBe(KEY);
    expect(options.httpOptions.apiVersion).toBe("v1alpha");
    const { config } = params;
    expect(config.uses).toBe(1);
    expect(config.lockAdditionalFields).toEqual([]);
    expect(
      Date.parse(config.newSessionExpireTime) - Date.now(),
    ).toBeLessThanOrEqual(60_000);
    const live = config.liveConnectConstraints;
    expect(live.model).toBe("gemini-3.8-live");
    expect(live.config.systemInstruction).toBe(COPPER_VOICE_INSTRUCTIONS);
    expect(live.config.tools[0].functionDeclarations).toHaveLength(5);
    expect(live.config.outputAudioTranscription).toEqual({});
  });

  it("switches to Grok Voice with VOICE_PROVIDER=xai, pinned, and only with XAI_API_KEY set", async () => {
    const { createVoiceSession, COPPER_VOICE_INSTRUCTIONS } =
      await import("@/lib/copper/voice/session");
    const fetch = vi.fn(async () =>
      Response.json({ value: "xai-ephemeral", expires_at: 1 }),
    );
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("VOICE_PROVIDER", "xai");

    // No key, no token, and nothing is spent.
    expect(await createVoiceSession()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    vi.stubEnv("XAI_API_KEY", XAI_KEY);
    const session = await createVoiceSession();
    expect(session).toMatchObject({
      provider: "xai",
      token: "xai-ephemeral",
      model: "grok-voice-3.0",
    });
    expect(JSON.stringify(session)).not.toContain(XAI_KEY);
    if (session?.provider !== "xai") throw new Error("expected xai");
    expect(session.instructions).toBe(COPPER_VOICE_INSTRUCTIONS);
    expect(session.tools).toHaveLength(5);
    expect(session.tools.map((t) => t.name)).toContain("compare_products");
    expect(session.tools.every((t) => t.type === "function")).toBe(true);

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.x.ai/v1/realtime/client_secrets");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${XAI_KEY}`,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      expires_after: { seconds: 300 },
    });
    expect(created).toHaveLength(0);
  });

  it("tells Copper to get every number from a tool before saying it", async () => {
    const { COPPER_VOICE_INSTRUCTIONS } =
      await import("@/lib/copper/voice/session");
    const { COPPER_INSTRUCTIONS } =
      await import("@/lib/copper/assistant/instructions");
    expect(COPPER_VOICE_INSTRUCTIONS.startsWith(COPPER_INSTRUCTIONS)).toBe(
      true,
    );
    expect(COPPER_VOICE_INSTRUCTIONS).toMatch(/never say a price/i);
    expect(COPPER_VOICE_INSTRUCTIONS).toMatch(/Hey Copper/);
  });

  it("uses COPPER_VOICE_MODEL when set, and makes no token without a key", async () => {
    const { createVoiceSession } = await import("@/lib/copper/voice/session");
    vi.stubEnv("COPPER_VOICE_MODEL", "gemini-live-next");
    expect((await createVoiceSession())?.model).toBe("gemini-live-next");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    created.length = 0;
    expect(await createVoiceSession()).toBeNull();
    expect(created).toHaveLength(0);
  });
});

describe("provider messages", () => {
  it("reads Gemini Live messages as words, audio, tool calls and turn ends", async () => {
    const { geminiActions } = await import("@/lib/copper/voice/link");
    expect(
      geminiActions({
        serverContent: {
          inputTranscription: { text: "Hey Copper" },
          modelTurn: {
            parts: [
              {
                inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" },
              },
            ],
          },
          outputTranscription: { text: "Sure." },
          turnComplete: true,
        },
      } as never),
    ).toEqual([
      { type: "event", event: { type: "heard", text: "Hey Copper" } },
      { type: "audio", data: "AAAA" },
      { type: "event", event: { type: "said", text: "Sure." } },
      { type: "event", event: { type: "done" } },
    ]);
    expect(
      geminiActions({
        toolCall: {
          functionCalls: [
            { id: "c1", name: "calculate_cost", args: HOME_PLUS_2_YEARS },
          ],
        },
      } as never),
    ).toEqual([
      {
        type: "tool-calls",
        calls: [{ id: "c1", name: "calculate_cost", args: HOME_PLUS_2_YEARS }],
      },
    ]);
    expect(
      geminiActions({ serverContent: { interrupted: true } } as never),
    ).toEqual([{ type: "interrupted" }]);
  });

  it("reads xAI events the same way, holding tool calls until the response is done", async () => {
    const { newXaiState, xaiActions } = await import("@/lib/copper/voice/link");
    const state = newXaiState();
    const run = (event: Record<string, unknown>) => xaiActions(event, state);
    // xAI sends the whole transcript so far; only the new words come out.
    expect(
      run({
        type: "conversation.item.input_audio_transcription.updated",
        item_id: "i1",
        transcript: "Hey",
      }),
    ).toEqual([{ type: "event", event: { type: "heard", text: "Hey" } }]);
    expect(
      run({
        type: "conversation.item.input_audio_transcription.updated",
        item_id: "i1",
        transcript: "Hey Copper",
      }),
    ).toEqual([{ type: "event", event: { type: "heard", text: " Copper" } }]);
    expect(run({ type: "response.output_audio.delta", delta: "BBBB" })).toEqual(
      [{ type: "audio", data: "BBBB" }],
    );
    expect(run({ type: "input_audio_buffer.speech_started" })).toEqual([
      { type: "interrupted" },
    ]);
    expect(
      run({
        type: "response.function_call_arguments.done",
        call_id: "call_1",
        name: "calculate_cost",
        arguments: JSON.stringify(HOME_PLUS_2_YEARS),
      }),
    ).toEqual([]);
    expect(run({ type: "response.done" })).toEqual([
      {
        type: "tool-calls",
        calls: [
          { id: "call_1", name: "calculate_cost", args: HOME_PLUS_2_YEARS },
        ],
      },
    ]);
    expect(
      run({
        type: "response.output_audio_transcript.delta",
        delta: "That's $307.",
      }),
    ).toEqual([
      { type: "event", event: { type: "said", text: "That's $307." } },
    ]);
    expect(run({ type: "response.done" })).toEqual([
      { type: "event", event: { type: "done" } },
    ]);
  });
});

describe("a spoken price comes from a tool", () => {
  it("runs the tool on the server, sends its result to the model, and the price Copper says matches it", async () => {
    const { createConversation } =
      await import("@/lib/copper/voice/conversation");
    const { runCopperTool } = await import("@/lib/copper/voice/tools");
    const { getPlans, getProducts } = await import("@/lib/copper/catalog");
    const runTool = vi.fn(runCopperTool);
    const sent: unknown[] = [];
    const turns: VoiceTurn[] = [];
    const chat = createConversation({
      runTool,
      reply: (r) => sent.push(r),
      onTurn: (t) => turns.push(t),
    });

    await chat.handle({
      type: "event",
      event: {
        type: "heard",
        text: "How much is Copper Home with Copper Plus, yearly, for 2 years?",
      },
    });
    await chat.handle({
      type: "tool-calls",
      calls: [{ id: "c1", name: "calculate_cost", args: HOME_PLUS_2_YEARS }],
    });
    await chat.handle({
      type: "event",
      event: { type: "said", text: "That comes to $307 over two years." },
    });
    await chat.handle({ type: "event", event: { type: "done" } });

    // The figure is the catalog's, worked out by the tool, not the model.
    const home = getProducts().find((p) => p.id === "copper-home")!.priceUsd;
    const plus = getPlans().find((p) => p.id === "copper-plus")!.annualUsd;
    expect(home + 2 * plus).toBe(307);
    expect(runTool).toHaveBeenCalledWith("calculate_cost", HOME_PLUS_2_YEARS);
    expect(sent).toEqual([
      [
        {
          id: "c1",
          name: "calculate_cost",
          result: expect.objectContaining({ totalUsd: 307 }),
        },
      ],
    ]);

    const last = turns.at(-1)!;
    expect(last.progress.status).toBe("done");
    expect(last.progress.steps).toEqual([
      expect.objectContaining({
        name: "calculate_cost",
        state: "done",
        output: expect.objectContaining({ totalUsd: 307 }),
      }),
    ]);
    expect(last.ungrounded).toEqual([]);
  });

  it("flags a price Copper says that no tool returned", async () => {
    const { createConversation } =
      await import("@/lib/copper/voice/conversation");
    const { runCopperTool } = await import("@/lib/copper/voice/tools");
    const turns: VoiceTurn[] = [];
    const chat = createConversation({
      runTool: runCopperTool,
      reply: () => {},
      onTurn: (t) => turns.push(t),
    });

    // No tool at all: a guessed price.
    await chat.handle({
      type: "event",
      event: { type: "said", text: "Copper Home is about $299." },
    });
    await chat.handle({ type: "event", event: { type: "done" } });
    expect(turns.at(-1)?.ungrounded).toEqual(["$299"]);

    // A tool ran, but Copper said a different number than it returned.
    await chat.handle({
      type: "tool-calls",
      calls: [{ id: "c2", name: "get_prices", args: {} }],
    });
    await chat.handle({
      type: "event",
      event: {
        type: "said",
        text: "Copper Notes is $129 and Plus is 80 dollars a year.",
      },
    });
    await chat.handle({ type: "event", event: { type: "done" } });
    expect(turns.at(-1)?.ungrounded).toEqual(["80 dollars"]);
  });

  it("returns a refused tool call to the model as an error, not a number", async () => {
    const { createConversation } =
      await import("@/lib/copper/voice/conversation");
    const { runCopperTool } = await import("@/lib/copper/voice/tools");
    const sent: unknown[] = [];
    const chat = createConversation({
      runTool: runCopperTool,
      reply: (r) => sent.push(r),
      onTurn: () => {},
    });
    await chat.handle({
      type: "tool-calls",
      calls: [
        {
          id: "c3",
          name: "calculate_cost",
          args: { ...HOME_PLUS_2_YEARS, years: 9 },
        },
      ],
    });
    expect(sent).toEqual([
      [
        {
          id: "c3",
          name: "calculate_cost",
          result: { error: expect.stringMatching(/isn't allowed/) },
        },
      ],
    ]);
  });
});

describe("voice turns", () => {
  it("builds a spoken answer into the same steps the chat draws", async () => {
    const { nextVoiceTurn } = await import("@/lib/copper/voice/turn");
    let turn = nextVoiceTurn(
      null,
      { type: "heard", text: "Hey Copper, which is cheaper?" },
      1,
    );
    const first = turn;
    turn = nextVoiceTurn(
      turn,
      {
        type: "tool-call",
        id: "a",
        name: "compare_products",
        input: { products: ["copper-home", "copper-notes"] },
      },
      2,
    );
    turn = nextVoiceTurn(
      turn,
      {
        type: "tool-result",
        id: "a",
        ok: true,
        output: { cheaper: "Copper Notes", priceDifferenceUsd: 20 },
      },
      2,
    );
    turn = nextVoiceTurn(
      turn,
      { type: "said", text: "Copper Notes, by $20." },
      2,
    );
    turn = nextVoiceTurn(turn, { type: "done" }, 2);

    expect(turn).toEqual({
      id: 1,
      question: "Hey Copper, which is cheaper?",
      ungrounded: [],
      progress: {
        status: "done",
        reply: "Copper Notes, by $20.",
        steps: [
          {
            type: "tool",
            id: "a",
            name: "compare_products",
            state: "done",
            input: { products: ["copper-home", "copper-notes"] },
            output: { cheaper: "Copper Notes", priceDifferenceUsd: 20 },
          },
        ],
      },
    });
    // Earlier updates are never changed underneath the panel.
    expect(first?.progress.steps).toEqual([]);

    const next = nextVoiceTurn(turn, { type: "heard", text: "And stock?" }, 2);
    expect(next?.id).toBe(2);
    expect(next?.progress).toEqual({ steps: [], reply: "", status: "working" });
  });

  it("marks a failed tool call as an error", async () => {
    const { nextVoiceTurn } = await import("@/lib/copper/voice/turn");
    let turn = nextVoiceTurn(
      null,
      {
        type: "tool-call",
        id: "x",
        name: "calculate_cost",
        input: { years: 9 },
      },
      1,
    );
    turn = nextVoiceTurn(
      turn,
      {
        type: "tool-result",
        id: "x",
        ok: false,
        output: "That input isn't allowed",
      },
      1,
    );
    expect(turn?.progress.steps[0]).toMatchObject({
      state: "error",
      output: "That input isn't allowed",
    });
  });
});

describe("voice audio", () => {
  it("round-trips 16-bit PCM and resamples the microphone for each provider", async () => {
    const { decodePcm16, downsample, encodePcm16 } =
      await import("@/lib/copper/voice/pcm");
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 2]);
    const back = decodePcm16(encodePcm16(samples));
    expect(back).toHaveLength(6);
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[2]).toBeCloseTo(-0.5, 3);
    expect(back[5]).toBeCloseTo(1, 3); // clamped
    expect(downsample(new Float32Array(4800).fill(0.25), 48_000)).toHaveLength(
      1600,
    );
    expect(
      downsample(new Float32Array(4800).fill(0.25), 48_000)[0],
    ).toBeCloseTo(0.25);
    expect(downsample(new Float32Array(4800), 48_000, 24_000)).toHaveLength(
      2400,
    );
    expect(downsample(new Float32Array(10), 16_000)).toHaveLength(10);
  });
});
