// Module 2: the tools Ask Copper can use. Products and prices come from
// lib/copper/catalog.ts and stock from lib/copper/inventory.ts, so the
// chatbot never has to make them up.
// The contract for the first four is in specs/module-2/spec.md. The fifth,
// compare_products, is this repo's extension (Module 2 deck, slide 16).
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  getPlans,
  getProducts,
  type Plan,
  type ProductId,
} from "@/lib/copper/catalog";
import { readInventory, type InventoryRow } from "@/lib/copper/inventory";

export type ProductList = {
  products: {
    id: ProductId;
    name: string;
    type: string;
    priceUsd: number;
    colors: string[];
  }[];
};

export type Prices = {
  products: { id: ProductId; name: string; priceUsd: number }[];
  plans: {
    id: Plan["id"];
    name: string;
    monthlyUsd: number;
    annualUsd: number;
  }[];
};

export type CalculateCostInput = {
  products: ProductId[];
  plan: Plan["id"];
  billing: "monthly" | "annual";
  years: number;
};

export type CostBreakdown = {
  lines: { item: string; usd: number }[];
  totalUsd: number;
};

export type CheckAvailabilityInput = { product: ProductId; color?: string };

export type Stock = "in_stock" | "low_stock" | "backordered";

export type ColorStock = {
  color: string;
  stock: Stock;
  restockDate: string | null;
};

export type Availability =
  | { status: "ok"; product: string; colors: ColorStock[] }
  | { status: "not_a_color"; product: string; color: string; colors: string[] }
  | { status: "unavailable"; message: string };

/** get_products: what Copper sells and which colors each one comes in. */
export function listProducts(): ProductList {
  // Called listProducts() because the catalog already exports getProducts().
  // Colors here are what a product comes in (a catalog fact), never stock.
  return {
    products: getProducts().map(({ id, name, type, priceUsd, colors }) => ({
      id,
      name,
      type,
      priceUsd,
      colors,
    })),
  };
}

/** get_prices: every product and plan price, read from the catalog. */
export function getPrices(): Prices {
  return {
    products: getProducts().map(({ id, name, priceUsd }) => ({
      id,
      name,
      priceUsd,
    })),
    plans: getPlans().map(({ id, name, monthlyUsd, annualUsd }) => ({
      id,
      name,
      monthlyUsd,
      annualUsd,
    })),
  };
}

// The ids are the contract the model has to stay inside; prices still come
// from the catalog at run time.
const productId = z.enum(["copper-home", "copper-notes"]);

export const calculateCostInput: z.ZodType<CalculateCostInput> = z.object({
  products: z.array(productId).max(5),
  plan: z.enum(["free", "copper-plus"]),
  billing: z.enum(["monthly", "annual"]),
  years: z.number().int().min(1).max(5),
});

/** Rounds a dollar amount to cents. */
const toCents = (usd: number) => Math.round(usd * 100) / 100;

/** calculate_cost: the total cost of devices plus a plan over some years. */
export function calculateCost(input: CalculateCostInput): CostBreakdown {
  const products = getProducts();
  const lines: CostBreakdown["lines"] = [];

  // Each device is paid for once.
  for (const id of input.products) {
    const product = products.find((p) => p.id === id);
    if (!product) throw new Error(`Unknown product: ${id}`);
    lines.push({ item: product.name, usd: toCents(product.priceUsd) });
  }

  // The plan covers the whole household, so it's counted once. Free adds no line.
  const plan = getPlans().find((p) => p.id === input.plan);
  if (!plan) throw new Error(`Unknown plan: ${input.plan}`);
  const planUsd =
    input.billing === "monthly"
      ? plan.monthlyUsd * 12 * input.years
      : plan.annualUsd * input.years;
  if (planUsd > 0) {
    const years = input.years === 1 ? "1 year" : `${input.years} years`;
    lines.push({
      item: `${plan.name}, ${input.billing}, ${years}`,
      usd: toCents(planUsd),
    });
  }

  const totalUsd = toCents(lines.reduce((sum, line) => sum + line.usd, 0));
  return { lines, totalUsd };
}

export const checkAvailabilityInput: z.ZodType<CheckAvailabilityInput> =
  z.object({
    product: productId,
    color: z.string().optional(),
  });

/** 0 units is back-ordered, 1 to 9 is low stock, 10 or more is in stock. */
function stockOf(units: number): Stock {
  if (units <= 0) return "backordered";
  if (units < 10) return "low_stock";
  return "in_stock";
}

const STOCK_DOWN =
  "Stock can't be checked right now. Please try again shortly, or ask the Copper Crew.";

/** check_availability: stock for one product (or one of its colors), read fresh each time. */
export async function checkAvailability(
  input: CheckAvailabilityInput,
): Promise<Availability> {
  const product = getProducts().find((p) => p.id === input.product);
  if (!product) return { status: "unavailable", message: STOCK_DOWN };

  // Check the color against the catalog first: a color the product doesn't
  // come in is "not a color", never "out of stock", even if stock is down.
  let colors = product.colors;
  if (input.color !== undefined) {
    const asked = input.color.trim().toLowerCase();
    const match = product.colors.find((c) => c.toLowerCase() === asked);
    if (!match) {
      return {
        status: "not_a_color",
        product: product.name,
        color: input.color,
        colors: product.colors,
      };
    }
    colors = [match];
  }

  // Read the stock list every time: stock changes, so never keep a copy.
  const rows = await readInventory();
  if (!rows) return { status: "unavailable", message: STOCK_DOWN };
  return {
    status: "ok",
    product: product.name,
    colors: stockFor(product.name, colors, rows),
  };
}

/** Stock for some of a product's colors. A color with no stock row is left out. */
function stockFor(
  productName: string,
  colors: string[],
  rows: InventoryRow[],
): ColorStock[] {
  // Stock rows hold the product's display name, not its id.
  const mine = rows.filter((row) => row.product === productName);
  const found: ColorStock[] = [];
  for (const color of colors) {
    const row = mine.find((r) => r.color.toLowerCase() === color.toLowerCase());
    if (!row) continue;
    const stock = stockOf(row.units_in_stock);
    found.push({
      color,
      stock,
      restockDate: stock === "backordered" ? row.next_shipment : null,
    });
  }
  return found;
}

export type CompareProductsInput = { products: ProductId[] };

export type ProductComparison = {
  products: {
    id: ProductId;
    name: string;
    type: string;
    priceUsd: number;
    features: string[];
    /** null when stock can't be read right now. */
    stock: ColorStock[] | null;
  }[];
  /** The cheaper product's name, or null when they cost the same. */
  cheaper: string | null;
  priceDifferenceUsd: number;
  /** Set when stock can't be read, so the reply says so instead of guessing. */
  stockMessage: string | null;
};

export const compareProductsInput: z.ZodType<CompareProductsInput> = z.object({
  products: z
    .array(productId)
    .length(2)
    .refine(([a, b]) => a !== b, "Pick two different products"),
});

/** compare_products: two products side by side, with today's stock for each color. */
export async function compareProducts(
  input: CompareProductsInput,
): Promise<ProductComparison> {
  const catalog = getProducts();
  const picked = input.products.map((id) => {
    const product = catalog.find((p) => p.id === id);
    if (!product) throw new Error(`Unknown product: ${id}`);
    return product;
  });

  // One fresh read of the stock list covers both products.
  const rows = await readInventory();
  const products = picked.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    priceUsd: p.priceUsd,
    features: p.features.map((f) => f.name),
    stock: rows ? stockFor(p.name, p.colors, rows) : null,
  }));

  // The model never does the arithmetic: the gap and the cheaper one come from here.
  const [a, b] = products;
  return {
    products,
    cheaper:
      a.priceUsd === b.priceUsd
        ? null
        : a.priceUsd < b.priceUsd
          ? a.name
          : b.name,
    priceDifferenceUsd: toCents(Math.abs(a.priceUsd - b.priceUsd)),
    stockMessage: rows ? null : STOCK_DOWN,
  };
}

export const copperTools = {
  get_products: tool({
    description:
      "Lists every Copper product with its type, price and the colors it comes in (not whether a color is in stock).",
    inputSchema: z.object({}),
    execute: async () => listProducts(),
  }),
  get_prices: tool({
    description:
      "Gets the current price of every Copper product and every plan, monthly and annual.",
    inputSchema: z.object({}),
    execute: async () => getPrices(),
  }),
  calculate_cost: tool({
    description:
      "Works out the total cost of some devices plus a plan, paid monthly or annually, over 1 to 5 years.",
    inputSchema: calculateCostInput,
    execute: async (input) => calculateCost(input),
  }),
  check_availability: tool({
    description:
      "Checks today's stock for a Copper product, for every color or just one, with restock dates for back-ordered colors.",
    inputSchema: checkAvailabilityInput,
    execute: async (input) => checkAvailability(input),
  }),
  compare_products: tool({
    description:
      "Compares two Copper products side by side: price, which is cheaper and by how much, type, features, and today's stock for every color.",
    inputSchema: compareProductsInput,
    execute: async (input) => compareProducts(input),
  }),
} satisfies ToolSet;
