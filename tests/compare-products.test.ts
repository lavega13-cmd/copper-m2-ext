// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

// compare_products, the fifth tool (Module 2 deck, slide 16): two products
// side by side, with prices from the catalog, the price gap worked out in
// code, and today's stock read fresh from the inventory for every color.

const TODAY = [
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
];

let rows: Record<string, unknown>[] | null = TODAY;
const reads = vi.fn();
vi.mock("@/lib/copper/inventory", () => ({
  readInventory: async () => {
    reads();
    return structuredClone(rows);
  },
}));

afterEach(() => {
  rows = TODAY;
  reads.mockClear();
  vi.doUnmock("@/lib/copper/catalog");
  vi.resetModules();
});

async function tools() {
  return import("@/lib/copper/assistant/tools");
}

describe("compare_products", () => {
  it("puts both products side by side with catalog prices and works out the gap", async () => {
    const { compareProducts } = await tools();
    const { getProducts } = await import("@/lib/copper/catalog");
    const home = getProducts().find((p) => p.id === "copper-home")!;
    const notes = getProducts().find((p) => p.id === "copper-notes")!;

    const result = await compareProducts({
      products: ["copper-home", "copper-notes"],
    });

    expect(result.products.map((p) => [p.name, p.priceUsd])).toEqual([
      ["Copper Home", home.priceUsd],
      ["Copper Notes", notes.priceUsd],
    ]);
    expect(result.products[0].type).toBe(home.type);
    expect(result.products[1].features).toEqual(
      notes.features.map((f) => f.name),
    );
    expect(result.cheaper).toBe("Copper Notes");
    expect(result.priceDifferenceUsd).toBe(20);
    expect(result.stockMessage).toBeNull();
  });

  it("follows the catalog when a price changes", async () => {
    vi.resetModules();
    vi.doMock("@/lib/copper/catalog", async (original) => {
      const real = await original<typeof import("@/lib/copper/catalog")>();
      return {
        ...real,
        getProducts: () =>
          real
            .getProducts()
            .map((p) =>
              p.id === "copper-home" ? { ...p, priceUsd: 99.5 } : p,
            ),
      };
    });
    const { compareProducts } = await tools();
    const result = await compareProducts({
      products: ["copper-notes", "copper-home"],
    });
    expect(result.cheaper).toBe("Copper Home");
    expect(result.priceDifferenceUsd).toBe(29.5);
  });

  it("reads stock fresh and reports every color: in stock, low stock, or back-ordered with its date", async () => {
    const { compareProducts } = await tools();
    const first = await compareProducts({
      products: ["copper-home", "copper-notes"],
    });
    expect(first.products[0].stock).toEqual([
      { color: "Polished Copper", stock: "in_stock", restockDate: null },
      { color: "Patina Teal", stock: "low_stock", restockDate: null },
      { color: "Night Sky", stock: "in_stock", restockDate: null },
    ]);
    expect(first.products[1].stock).toContainEqual({
      color: "Night Sky",
      stock: "backordered",
      restockDate: "2026-11-14",
    });

    // Stock changes between questions, so nothing is remembered.
    rows = TODAY.map((r) =>
      r.sku === "CN-NSK" ? { ...r, units_in_stock: 40 } : r,
    );
    const second = await compareProducts({
      products: ["copper-home", "copper-notes"],
    });
    expect(second.products[1].stock).toContainEqual({
      color: "Night Sky",
      stock: "in_stock",
      restockDate: null,
    });
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("still compares prices when stock can't be read, and says so instead of guessing", async () => {
    rows = null;
    const { compareProducts } = await tools();
    const result = await compareProducts({
      products: ["copper-home", "copper-notes"],
    });
    expect(result.products.every((p) => p.stock === null)).toBe(true);
    expect(result.stockMessage).toMatch(/can't be checked/);
    expect(result.priceDifferenceUsd).toBe(20);
    expect(JSON.stringify(result)).not.toMatch(
      /in_stock|low_stock|backordered/,
    );
  });

  it("only takes two different products from the catalog", async () => {
    const { compareProductsInput } = await tools();
    expect(
      compareProductsInput.safeParse({
        products: ["copper-home", "copper-notes"],
      }).success,
    ).toBe(true);
    const bad = [
      { products: ["copper-home", "copper-home"] },
      { products: ["copper-home"] },
      { products: ["copper-home", "copper-notes", "copper-home"] },
      { products: ["copper-home", "copper-phone"] },
      {},
    ];
    for (const input of bad)
      expect(
        compareProductsInput.safeParse(input).success,
        JSON.stringify(input),
      ).toBe(false);
  });

  it("is offered to the model as a fifth tool, with a description and a label for the panel", async () => {
    const { copperTools } = await tools();
    const { TOOL_LABELS } = await import("@/lib/copper/assistant/progress");
    const { COPPER_INSTRUCTIONS } =
      await import("@/lib/copper/assistant/instructions");
    expect(Object.keys(copperTools)).toHaveLength(5);
    expect(copperTools.compare_products.description).toMatch(/compare/i);
    expect(typeof copperTools.compare_products.execute).toBe("function");
    expect(TOOL_LABELS.compare_products).toBe("Comparing products");
    expect(COPPER_INSTRUCTIONS).toContain("compare_products");
  });
});
