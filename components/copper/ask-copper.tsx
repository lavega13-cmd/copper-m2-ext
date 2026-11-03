"use client";

// Module 2: Ask Copper, the floating chat panel. It asks askCopper() (a Server
// Action) and draws each answer as a line of stations on a rail: the tools on
// offer, Copper's thinking, each tool call with what went in and what came
// back, and then the reply. The layout is described in specs/module-2/spec.md,
// section 5.
import Image from "next/image";
import {
  ArrowUpIcon,
  BrainIcon,
  MessageCircleIcon,
  ToolboxIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { SetupRequired } from "@/components/setup-required";
import { VoiceChat } from "@/components/copper/voice-chat";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { readLive } from "@/lib/ai/live";
import { askCopper, type ChatMessage } from "@/lib/copper/assistant/ask";
import {
  TOOL_LABELS,
  type Progress,
  type ToolStep,
} from "@/lib/copper/assistant/progress";
import { formatUsd } from "@/lib/copper/catalog";
import type { VoiceTurn } from "@/lib/copper/voice/turn";
import { cn } from "@/lib/utils";

export const STARTER_QUESTIONS = [
  "How much is Copper Home with Copper Plus, paid yearly, for 2 years?",
  "Is Copper Notes in Night Sky in stock?",
  "Is Copper Plus cheaper monthly or yearly?",
];

/** A typed question, or a spoken one (voiceId set) from voice mode. */
type Turn = {
  question: string;
  progress: Progress | null;
  voiceId?: number;
  /** Dollar figures a spoken answer gave that no tool returned. */
  ungrounded?: string[];
};
type ChatKey = "tools" | "noTools";

const WORKING: Progress = { steps: [], reply: "", status: "working" };

/** The conversation so far, as the model sees it: questions and finished replies. */
function historyOf(turns: Turn[]): ChatMessage[] {
  return turns.flatMap((turn): ChatMessage[] => {
    const reply = turn.progress?.reply.trim();
    return reply && turn.progress?.status !== "working"
      ? [
          { role: "user", content: turn.question },
          { role: "assistant", content: reply },
        ]
      : [{ role: "user", content: turn.question }];
  });
}

export function AskCopper({ aiConfigured }: { aiConfigured: boolean }) {
  const [open, setOpen] = useState(false);
  const [useTools, setUseTools] = useState(true);
  const [chats, setChats] = useState<Record<ChatKey, Turn[]>>({
    tools: [],
    noTools: [],
  });
  const [draft, setDraft] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  // The panel opens from the launcher, the header's #ask link, or /#ask. The
  // link is listened for as a click too: once the address already ends in
  // #ask, clicking it again fires no hashchange.
  useEffect(() => {
    const openIfAsked = () => {
      if (window.location.hash === "#ask") setOpen(true);
    };
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a");
      if (link?.getAttribute("href")?.endsWith("#ask")) setOpen(true);
    };
    const first = window.setTimeout(openIfAsked, 0);
    window.addEventListener("hashchange", openIfAsked);
    document.addEventListener("click", onClick);
    return () => {
      window.clearTimeout(first);
      window.removeEventListener("hashchange", openIfAsked);
      document.removeEventListener("click", onClick);
    };
  }, []);

  const key: ChatKey = useTools ? "tools" : "noTools";
  const turns = chats[key];
  const busy = turns.some(
    (turn) =>
      turn.progress?.status !== "done" && turn.progress?.status !== "error",
  );

  // Keep the newest step in view as it streams in.
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [turns]);

  // Spoken turns join the tools-on chat, updated in place as they stream in.
  function onVoiceTurn({ id, question, progress, ungrounded }: VoiceTurn) {
    const turn: Turn = {
      question: question.trim() || "(spoken question)",
      progress,
      voiceId: id,
      ungrounded,
    };
    setChats((all) => {
      const at = all.tools.findIndex((t) => t.voiceId === id);
      return {
        ...all,
        tools:
          at === -1
            ? [...all.tools, turn]
            : all.tools.map((t, i) => (i === at ? turn : t)),
      };
    });
  }

  async function send(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    const chat = key;
    const tools = useTools;
    const index = chats[chat].length;
    const messages = [
      ...historyOf(chats[chat]),
      { role: "user" as const, content: text },
    ];
    const setProgress = (progress: Progress) =>
      setChats((all) => ({
        ...all,
        [chat]: all[chat].map((turn, i) =>
          i === index ? { ...turn, progress } : turn,
        ),
      }));

    setDraft("");
    setChats((all) => ({
      ...all,
      [chat]: [...all[chat], { question: text, progress: WORKING }],
    }));
    try {
      const { progress } = await askCopper({ messages, useTools: tools });
      for await (const update of readLive(progress)) setProgress(update);
    } catch {
      setProgress({
        steps: [],
        reply: "Sorry, I couldn't reach Copper just now. Please try again.",
        status: "error",
      });
    }
  }

  return (
    <>
      <Button
        data-testid="ask-copper-launcher"
        onClick={() => setOpen(true)}
        className="bg-primary text-primary-foreground fixed right-4 bottom-4 z-40 h-12 gap-2 rounded-full px-5 shadow-lg sm:right-6 sm:bottom-6"
      >
        <MessageCircleIcon className="size-5" />
        Ask Copper
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          data-testid="ask-copper"
          side="right"
          showCloseButton={false}
          className="w-full! gap-0 p-0 sm:max-w-md!"
        >
          <header className="bg-chart-5 text-secondary dark:bg-card dark:text-foreground">
            <div className="flex items-center gap-3 px-4 pt-4 pb-3">
              <span className="bg-primary flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full">
                <Image
                  src="/assets/brand/copper-mascot.png"
                  alt="Copper, the Copper State Labs mascot"
                  width={40}
                  height={40}
                  className="size-9 object-contain"
                />
              </span>
              <div className="min-w-0 flex-1">
                <SheetTitle className="font-heading text-lg font-bold text-inherit">
                  Ask Copper
                </SheetTitle>
                <SheetDescription className="text-xs text-inherit opacity-80">
                  Prices, totals and stock, checked with tools.
                </SheetDescription>
              </div>
              <SheetClose asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  className="text-inherit hover:bg-white/10 hover:text-inherit"
                >
                  <XIcon />
                </Button>
              </SheetClose>
            </div>
            {aiConfigured && (
              <div className="flex items-center gap-3 bg-white/10 px-4 py-2">
                <div className="flex-1">
                  <p className="text-sm font-semibold">Use tools</p>
                  <p className="text-xs opacity-80">
                    {useTools ? "Checks every answer" : "Model guesses alone"}
                  </p>
                </div>
                <Switch
                  aria-label="Use tools"
                  checked={useTools}
                  onCheckedChange={setUseTools}
                  disabled={busy}
                />
              </div>
            )}
          </header>

          {aiConfigured ? (
            <>
              <div
                ref={bodyRef}
                className="bg-secondary flex-1 space-y-6 overflow-y-auto px-4 py-5"
              >
                {turns.map((turn, i) => (
                  <Fragment key={i}>
                    <div className="flex justify-end">
                      <p className="bg-background max-w-[85%] rounded-2xl rounded-br-sm px-3 py-2 text-sm shadow-sm">
                        {turn.question}
                      </p>
                    </div>
                    <Answer
                      progress={turn.progress ?? WORKING}
                      useTools={useTools}
                    />
                    {turn.ungrounded?.length ? (
                      <p
                        data-testid="ungrounded"
                        role="alert"
                        className="border-chart-3 bg-chart-3/15 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
                      >
                        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                        Copper said {listOf(turn.ungrounded)}, which no tool
                        returned. Trust the tool cards, not that figure.
                      </p>
                    ) : null}
                  </Fragment>
                ))}
                {!busy && (
                  <StarterQuestions
                    compact={turns.length > 0}
                    onAsk={(question) => void send(question)}
                  />
                )}
              </div>
              {useTools && <VoiceChat onTurn={onVoiceTurn} disabled={busy} />}
              <form
                className="bg-background flex items-end gap-2 border-t p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send(draft);
                }}
              >
                <textarea
                  aria-label="Your question"
                  placeholder="Ask about prices, totals or stock…"
                  value={draft}
                  rows={1}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send(draft);
                    }
                  }}
                  className="border-input bg-background focus-visible:ring-ring/50 max-h-32 min-h-10 flex-1 resize-none rounded-2xl border px-4 py-2 text-sm outline-none focus-visible:ring-3"
                />
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Send"
                  disabled={busy || !draft.trim()}
                  className="bg-primary text-primary-foreground size-10 shrink-0 rounded-full"
                >
                  <ArrowUpIcon className="size-5" />
                </Button>
              </form>
            </>
          ) : (
            <div className="bg-secondary flex-1 overflow-y-auto px-4">
              <SetupRequired service="ai" />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function StarterQuestions({
  compact,
  onAsk,
}: {
  compact: boolean;
  onAsk: (question: string) => void;
}) {
  return (
    <div className="space-y-2">
      {compact ? (
        <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          Ask another
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
          Ask Copper what things cost and what&apos;s in stock. Try one of
          these:
        </p>
      )}
      <div className="flex flex-col items-start gap-2">
        {STARTER_QUESTIONS.map((question) => (
          <button
            key={question}
            type="button"
            onClick={() => onAsk(question)}
            className={cn(
              "border-primary/40 bg-background hover:border-primary hover:bg-primary/10 rounded-2xl border text-left transition-colors",
              compact ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
            )}
          >
            {question}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One answer: the stations on the rail, then the reply
// ---------------------------------------------------------------------------

function Answer({
  progress,
  useTools,
}: {
  progress: Progress;
  useTools: boolean;
}) {
  const working = progress.status === "working";
  const used = new Set(
    progress.steps.flatMap((step) => (step.type === "tool" ? [step.name] : [])),
  );
  const toolNumbers = new Map(
    progress.steps
      .filter((step): step is ToolStep => step.type === "tool")
      .map((step, i) => [step.id, i + 1]),
  );

  return (
    <div className="space-y-3">
      <div className="relative space-y-4">
        <span
          aria-hidden
          className={cn(
            "absolute top-3 bottom-3 left-[13px] w-0.5 rounded-full",
            useTools
              ? "from-primary via-accent to-accent bg-linear-to-b"
              : "bg-chart-3",
          )}
        />
        <Station
          node={<ToolboxIcon className="size-3.5" />}
          nodeClass={
            useTools
              ? "bg-accent text-accent-foreground"
              : "bg-chart-3 text-foreground"
          }
          label={
            useTools ? "Tools Copper can use" : "Tools given to Copper: none"
          }
        >
          <div className="flex flex-wrap gap-1.5">
            {Object.keys(TOOL_LABELS).map((name) => (
              <span
                key={name}
                className={cn(
                  "rounded-md px-2 py-0.5 font-mono text-xs",
                  !useTools
                    ? "text-muted-foreground line-through"
                    : used.has(name)
                      ? "bg-accent text-accent-foreground font-bold"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {name}
              </span>
            ))}
          </div>
          {!useTools && (
            <p className="text-muted-foreground mt-1.5 text-xs">
              Copper has to answer from memory alone.
            </p>
          )}
        </Station>

        {progress.steps.map((step, i) =>
          step.type === "thinking" ? (
            <Station
              key={i}
              node={<BrainIcon className="size-3.5" />}
              nodeClass={
                useTools
                  ? "bg-primary text-primary-foreground"
                  : "bg-chart-3 text-foreground"
              }
              label="Copper is thinking"
            >
              <div
                data-testid="thinking"
                className="text-muted-foreground border-border border-l-2 pl-3 text-sm whitespace-pre-wrap italic"
              >
                <Markdown text={step.text.trim()} />
              </div>
            </Station>
          ) : (
            <Station
              key={step.id}
              node={<WrenchIcon className="size-3.5" />}
              nodeClass="bg-accent text-accent-foreground"
              label={
                step.state === "calling"
                  ? "Copper is calling a tool"
                  : "Copper called a tool"
              }
            >
              <ToolCard step={step} number={toolNumbers.get(step.id) ?? 1} />
            </Station>
          ),
        )}

        {working && (
          <Station node={<Dots />} nodeClass="bg-background animate-pulse">
            <p className="text-muted-foreground pt-1 text-sm">
              {nowText(progress, useTools)}
            </p>
          </Station>
        )}
      </div>

      {(progress.reply || progress.status !== "working") && (
        <Reply progress={progress} useTools={useTools} />
      )}
    </div>
  );
}

function nowText(progress: Progress, useTools: boolean) {
  if (progress.reply) return "Writing the answer…";
  if (!useTools) return "Answering from memory…";
  if (progress.steps.length > 0) return "Deciding what to do next…";
  return "Reading your question…";
}

function Station({
  node,
  nodeClass,
  label,
  children,
}: {
  node: ReactNode;
  nodeClass: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="relative pl-10">
      <span
        className={cn(
          "ring-secondary absolute top-0 left-0 flex size-7 items-center justify-center rounded-full ring-4",
          nodeClass,
        )}
      >
        {node}
      </span>
      {label && (
        <p className="text-muted-foreground mb-1.5 pt-1.5 text-[11px] font-semibold tracking-widest uppercase">
          {label}
        </p>
      )}
      {children}
    </div>
  );
}

function Dots() {
  return (
    <span className="flex gap-0.5" aria-hidden>
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="bg-primary size-1 animate-bounce rounded-full"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

function Reply({
  progress,
  useTools,
}: {
  progress: Progress;
  useTools: boolean;
}) {
  return (
    <div className="bg-card ml-10 rounded-2xl rounded-tl-sm p-3 shadow-sm">
      <p className="text-primary mb-1 text-xs font-bold">Copper</p>
      {!useTools && (
        <div className="border-chart-3 bg-chart-3/10 mb-2 rounded-lg border p-2 text-xs">
          <p className="flex items-center gap-1.5 font-bold">
            <TriangleAlertIcon className="text-chart-3 size-4 shrink-0" />
            Answered without tools: may be made up
          </p>
          <p className="text-muted-foreground mt-1">
            With tools off, Copper can&apos;t see today&apos;s prices or stock.
            The AI only has what it learned in training, so it fills the gaps
            with guesses that sound right. That&apos;s a hallucination.
          </p>
        </div>
      )}
      <div className="text-sm whitespace-pre-wrap">
        <Markdown text={progress.reply} />
        {progress.status === "working" && (
          <span
            aria-hidden
            className="bg-primary ml-0.5 inline-block h-4 w-0.5 animate-pulse align-text-bottom"
          />
        )}
      </div>
    </div>
  );
}

/** Just enough markdown for the model's output: **bold** and `code`. */
function Markdown({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
          return (
            <strong key={i} className="text-foreground not-italic">
              {part.slice(2, -2)}
            </strong>
          );
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
          return (
            <code
              key={i}
              className="bg-muted rounded px-1 font-mono text-xs not-italic"
            >
              {part.slice(1, -1)}
            </code>
          );
        return part ? <Fragment key={i}>{part}</Fragment> : null;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// The tool card: what Copper sent, and what came back
// ---------------------------------------------------------------------------

type Row = [label: string, value: string];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** "copper-home" → "Copper Home". */
function titleCase(id: string) {
  return id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2026-11-14" → "Nov 14, 2026", without time-zone surprises. */
function formatDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

function sentRows(name: string, input: unknown): Row[] | string {
  if (name === "get_prices") return "Nothing, it just asked for the price list";
  if (name === "get_products")
    return "Nothing, it just asked what Copper sells";
  if (!isRecord(input)) return [];
  if (name === "calculate_cost") {
    const products = Array.isArray(input.products) ? input.products : [];
    return [
      [
        "Products",
        products.length
          ? products.map((p) => titleCase(String(p))).join(", ")
          : "None",
      ],
      ["Plan", titleCase(String(input.plan ?? ""))],
      ["Billing", String(input.billing ?? "")],
      ["Years", String(input.years ?? "")],
    ];
  }
  if (name === "check_availability") {
    return [
      ["Product", titleCase(String(input.product ?? ""))],
      ["Color", input.color ? String(input.color) : "Every color"],
    ];
  }
  if (name === "compare_products") {
    const products = Array.isArray(input.products) ? input.products : [];
    return [
      ["Products", products.map((p) => titleCase(String(p))).join(" vs ")],
    ];
  }
  return Object.entries(input).map(([label, value]) => [
    titleCase(label),
    String(value),
  ]);
}

function ToolCard({ step, number }: { step: ToolStep; number: number }) {
  const sent =
    step.input === undefined && step.state === "calling"
      ? null
      : sentRows(step.name, step.input);
  return (
    <div
      data-testid="tool-call"
      data-tool={step.name}
      className="bg-card overflow-hidden rounded-xl border text-sm shadow-sm"
    >
      <div className="bg-accent text-accent-foreground flex items-center gap-2 px-3 py-2">
        <span className="font-mono font-bold">{step.name}()</span>
        <span className="rounded-full bg-white/30 px-1.5 text-[10px] font-semibold">
          tool {number}
        </span>
        <span className="ml-auto text-xs">
          {TOOL_LABELS[step.name] ?? "Using a tool"}
        </span>
      </div>

      <div className="px-3 py-2">
        <p className="text-muted-foreground mb-1 text-[11px] font-semibold tracking-widest uppercase">
          → What Copper sent
        </p>
        {sent === null ? (
          <p className="text-muted-foreground text-xs italic">
            filling in the details…
          </p>
        ) : typeof sent === "string" ? (
          <p className="text-muted-foreground text-xs">{sent}</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
            {sent.map(([label, value]) => (
              <Fragment key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd>{value}</dd>
              </Fragment>
            ))}
          </dl>
        )}
      </div>

      <div className="bg-accent/10 border-t px-3 py-2">
        <p className="text-muted-foreground mb-1 text-[11px] font-semibold tracking-widest uppercase">
          ← What came back
        </p>
        {step.state === "calling" ? (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Spinner className="size-3" />
            the app is running the code…
          </p>
        ) : step.state === "error" ? (
          <p className="text-xs">{String(step.output)}</p>
        ) : (
          <CameBack name={step.name} output={step.output} />
        )}
      </div>
    </div>
  );
}

function CameBack({ name, output }: { name: string; output: unknown }) {
  if (!isRecord(output)) return <p className="text-xs">{String(output)}</p>;

  if (name === "calculate_cost" && Array.isArray(output.lines)) {
    return (
      <div className="text-xs">
        {output.lines.filter(isRecord).map((line, i) => (
          <div key={i} className="flex justify-between gap-4 py-0.5">
            <span>{String(line.item)}</span>
            <span className="tabular-nums">{formatUsd(Number(line.usd))}</span>
          </div>
        ))}
        <div className="mt-1 flex items-baseline justify-between border-t pt-1">
          <span className="font-semibold">Total</span>
          <span className="text-primary text-xl font-bold tabular-nums">
            {formatUsd(Number(output.totalUsd))}
          </span>
        </div>
      </div>
    );
  }

  if (name === "get_products" && Array.isArray(output.products)) {
    return (
      <div className="space-y-2 text-xs">
        {output.products.filter(isRecord).map((product) => (
          <div key={String(product.id)}>
            <div className="flex justify-between gap-4 font-semibold">
              <span>{String(product.name)}</span>
              <span className="tabular-nums">
                {formatUsd(Number(product.priceUsd))}
              </span>
            </div>
            <p className="text-muted-foreground">{String(product.type)}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {(Array.isArray(product.colors) ? product.colors : []).map(
                (color) => (
                  <span
                    key={String(color)}
                    className="bg-accent/20 rounded-full px-2 py-0.5 text-[11px]"
                  >
                    {String(color)}
                  </span>
                ),
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (
    name === "get_prices" &&
    Array.isArray(output.products) &&
    Array.isArray(output.plans)
  ) {
    return (
      <div className="text-xs">
        {output.products.filter(isRecord).map((product) => (
          <div
            key={String(product.id)}
            className="flex justify-between gap-4 py-0.5"
          >
            <span>{String(product.name)}</span>
            <span className="tabular-nums">
              {formatUsd(Number(product.priceUsd))}
            </span>
          </div>
        ))}
        {output.plans
          .filter(isRecord)
          .filter(
            (plan) => Number(plan.monthlyUsd) > 0 || Number(plan.annualUsd) > 0,
          )
          .map((plan) => (
            <div
              key={String(plan.id)}
              className="flex justify-between gap-4 py-0.5"
            >
              <span>{String(plan.name)}</span>
              <span className="tabular-nums">
                {formatUsd(Number(plan.monthlyUsd))}/mo ·{" "}
                {formatUsd(Number(plan.annualUsd))}/yr
              </span>
            </div>
          ))}
      </div>
    );
  }

  if (name === "check_availability") {
    if (output.status === "ok" && Array.isArray(output.colors)) {
      const rows = output.colors.filter(isRecord);
      if (rows.length === 0)
        return (
          <p className="text-xs">
            No stock rows were found for {String(output.product)}.
          </p>
        );
      return (
        <div className="text-xs">
          {rows.map((row) => (
            <div
              key={String(row.color)}
              className="flex items-center justify-between gap-4 py-0.5"
            >
              <span>{String(row.color)}</span>
              <StockPill
                stock={String(row.stock)}
                restockDate={row.restockDate}
              />
            </div>
          ))}
        </div>
      );
    }
    if (output.status === "not_a_color" && Array.isArray(output.colors)) {
      return (
        <p className="text-xs">
          {String(output.product)} doesn&apos;t come in {String(output.color)}.
          It comes in {listOf(output.colors.map(String))}.
        </p>
      );
    }
    if (output.status === "unavailable") {
      return <p className="text-xs">{String(output.message)}</p>;
    }
  }

  if (name === "compare_products" && Array.isArray(output.products)) {
    const products = output.products.filter(isRecord);
    return (
      <div className="text-xs">
        <div className="grid grid-cols-2 gap-3">
          {products.map((product) => (
            <div key={String(product.id)} className="min-w-0">
              <div className="flex justify-between gap-2 font-semibold">
                <span>{String(product.name)}</span>
                <span className="tabular-nums">
                  {formatUsd(Number(product.priceUsd))}
                </span>
              </div>
              <p className="text-muted-foreground">{String(product.type)}</p>
              <p className="text-muted-foreground mt-1">
                {listOf(
                  (Array.isArray(product.features) ? product.features : []).map(
                    String,
                  ),
                )}
              </p>
              {Array.isArray(product.stock) && (
                <div className="mt-1 space-y-0.5">
                  {product.stock.filter(isRecord).map((row) => (
                    <div
                      key={String(row.color)}
                      className="flex flex-wrap items-center justify-between gap-1"
                    >
                      <span>{String(row.color)}</span>
                      <StockPill
                        stock={String(row.stock)}
                        restockDate={row.restockDate}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        {typeof output.stockMessage === "string" && (
          <p className="mt-1">{output.stockMessage}</p>
        )}
        <div className="mt-2 flex items-baseline justify-between border-t pt-1">
          <span className="font-semibold">
            {typeof output.cheaper === "string"
              ? `${output.cheaper} is cheaper by`
              : "Same price"}
          </span>
          <span className="text-primary text-xl font-bold tabular-nums">
            {formatUsd(Number(output.priceDifferenceUsd))}
          </span>
        </div>
      </div>
    );
  }

  return (
    <pre className="overflow-x-auto font-mono text-[11px] whitespace-pre-wrap">
      {JSON.stringify(output, null, 2)}
    </pre>
  );
}

function StockPill({
  stock,
  restockDate,
}: {
  stock: string;
  restockDate: unknown;
}) {
  const [text, color] =
    stock === "in_stock"
      ? ["In stock", "bg-accent text-accent-foreground"]
      : stock === "low_stock"
        ? ["Low stock", "bg-chart-4 text-foreground"]
        : [
            typeof restockDate === "string"
              ? `Back-ordered until ${formatDate(restockDate)}`
              : "Back-ordered",
            "bg-chart-3 text-foreground",
          ];
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-semibold",
        color,
      )}
    >
      {text}
    </span>
  );
}

/** "A, B and C". */
function listOf(items: string[]) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
