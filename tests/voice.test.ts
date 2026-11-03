// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Voice mode: Gemini Live gets the same five tools, every tool call runs the
// same code as the chat (checked against its contract first), and the browser
// only ever sees a one-use token, never the Google key.

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

beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", KEY);
  vi.stubEnv("COPPER_VOICE_MODEL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  created.length = 0;
});

describe("voice tools", () => {
  it("hands Gemini Live all five chat tools, blocking, with their contracts", async () => {
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
    const input = {
      products: ["copper-home"],
      plan: "copper-plus",
      billing: "annual",
      years: 2,
    } as const;
    expect(await runCopperTool("calculate_cost", input)).toEqual({
      ok: true,
      output: calculateCost({ ...input, products: ["copper-home"] }),
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
  it("gives the browser a one-use token that locks the model, instructions and tools, never the key", async () => {
    const {
      createVoiceSession,
      COPPER_VOICE_INSTRUCTIONS,
      DEFAULT_VOICE_MODEL,
    } = await import("@/lib/copper/voice/session");
    const session = await createVoiceSession();
    expect(session).toEqual({
      token: "auth_tokens/one-use-token",
      model: DEFAULT_VOICE_MODEL,
    });
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
    expect(live.model).toBe(DEFAULT_VOICE_MODEL);
    expect(live.config.systemInstruction).toBe(COPPER_VOICE_INSTRUCTIONS);
    expect(live.config.tools[0].functionDeclarations).toHaveLength(5);
    expect(live.config.outputAudioTranscription).toEqual({});
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
        output: { cheaper: "Copper Notes" },
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
            output: { cheaper: "Copper Notes" },
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
  it("round-trips 16-bit PCM and resamples the microphone to 16 kHz", async () => {
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
    expect(downsample(new Float32Array(10), 16_000)).toHaveLength(10);
  });
});
