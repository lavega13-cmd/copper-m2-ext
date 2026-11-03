import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

// The whole round trip for the fifth tool, with a scripted model: the shopper
// asks, the model picks compare_products, the real tool runs against the stock
// table, and the panel draws the card before Copper's reply. Voice mode sits
// under the chat, with the text box still there when a browser can't do voice.

vi.mock("@/lib/copper/inventory", () => ({
  readInventory: async () => [
    {
      sku: "CH-POL",
      product: "Copper Home",
      color: "Polished Copper",
      units_in_stock: 240,
      next_shipment: "2026-11-20",
    },
    {
      sku: "CH-TEA",
      product: "Copper Home",
      color: "Patina Teal",
      units_in_stock: 6,
      next_shipment: "2026-11-06",
    },
    {
      sku: "CH-NSK",
      product: "Copper Home",
      color: "Night Sky",
      units_in_stock: 185,
      next_shipment: "2026-11-20",
    },
    {
      sku: "CN-BRC",
      product: "Copper Notes",
      color: "Brushed Copper",
      units_in_stock: 310,
      next_shipment: "2026-11-13",
    },
    {
      sku: "CN-DSA",
      product: "Copper Notes",
      color: "Desert Sand",
      units_in_stock: 92,
      next_shipment: "2026-11-13",
    },
    {
      sku: "CN-NSK",
      product: "Copper Notes",
      color: "Night Sky",
      units_in_stock: 0,
      next_shipment: "2026-11-14",
    },
  ],
}));

type Part = LanguageModelV4StreamPart;
const usage = {
  inputTokens: {
    total: 500,
    noCache: 500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};
const finish = (reason: "stop" | "tool-calls"): Part => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const input = { products: ["copper-home", "copper-notes"] };
const steps: Part[][] = [
  [
    { type: "tool-input-start", id: "call-1", toolName: "compare_products" },
    { type: "tool-input-end", id: "call-1" },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "compare_products",
      input: JSON.stringify(input),
    },
    finish("tool-calls"),
  ],
  [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "Copper Notes is $20 cheaper." },
    { type: "text-end", id: "t1" },
    finish("stop"),
  ],
];
let step = 0;
const model = new MockLanguageModelV4({
  doStream: async () => ({
    stream: convertArrayToReadableStream(steps[step++] ?? []),
  }),
});
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("Ask Copper with the fifth tool", () => {
  it("shows the compare_products card, with live stock, before the reply", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    const { default: Home } = await import("@/app/page");
    render(<Home />);
    fireEvent.click(screen.getByTestId("ask-copper-launcher"));
    const chat = within(await screen.findByTestId("ask-copper"));

    // Text stays the way in; voice is offered alongside it.
    const voice = within(chat.getByTestId("voice-chat"));
    expect(voice.getByRole("button", { name: /hey copper/i })).toBeTruthy();
    expect(voice.getByRole("status").textContent).toMatch(/Chrome or Edge/);

    fireEvent.change(chat.getByRole("textbox", { name: "Your question" }), {
      target: {
        value:
          "Which is cheaper, Copper Home or Copper Notes, and can I get them today?",
      },
    });
    fireEvent.click(chat.getByRole("button", { name: "Send" }));

    expect(await chat.findByText("Copper Notes is $20 cheaper.")).toBeTruthy();
    const card = chat.getByTestId("tool-call");
    expect(card.getAttribute("data-tool")).toBe("compare_products");
    const text = card.textContent ?? "";
    expect(text).toContain("Comparing products");
    expect(text).toContain("Copper Home vs Copper Notes");
    expect(text).toContain("Copper Notes is cheaper by");
    expect(text).toContain("$20");
    expect(text).toContain("$149");
    expect(text).toContain("$129");
    expect(text).toContain("Back-ordered until Nov 14, 2026");
    expect(text).toContain("Low stock");
    // The card comes before the reply.
    const reply = chat.getByText("Copper Notes is $20 cheaper.");
    expect(
      card.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
