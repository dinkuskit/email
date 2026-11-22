import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { emails, received } from "./emails.js";
import { SENDER, TOPICS } from "./news.js";

/**
 * Store emails' courier inbox (dinkuskit/courier docs/doors.md). EmDash plugins cannot call each other,
 * so the store's courier carries Commerce's news here about once a minute: an order paid, an order
 * shipped, a cart left. Everything stays in the store's own database; no address leaves it except
 * to the store's own email sender.
 */
/** A refusal in the shape of EmDash's own route error; the sandbox passes only its words on, so the code leads them. */
class PluginRouteError extends Error {
  override name = "PluginRouteError";
  constructor(readonly code: string, message: string, readonly status: number) { super(`${code}: ${message}`); }
}

export const COURIER = 1;
const BATCH = 50;
const MAX_ITEMS = 100;
const LAST_VISIT = "courier:last-visit";
const LAST_NEWS = "courier:last-news";
const bookmark = (topic: string) => `courier:after:${encodeURIComponent(SENDER)}:${encodeURIComponent(topic)}`;
/** A run is due every minute; five quiet minutes means the courier is late. */
const LATE_AFTER_MS = 5 * 60_000;

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const when = (value: unknown) => (typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

function request(route: SandboxedRouteContext): Record<string, unknown> {
  // Over HTTP a private route always carries a signed-in person; the courier calls from the store's own code with none.
  if (route.user) throw new PluginRouteError("COURIER_ONLY", "Only the store's courier may use this door.", 403);
  const input = route.input;
  if (!record(input) || input.courier !== COURIER || typeof input.op !== "string") throw new PluginRouteError("BAD_COURIER_REQUEST", "This is not a courier request.", 400);
  return input;
}

/** `POST courier/inbox`: says what Store emails listens to, then keeps each batch of news as emails to send. */
export async function courierInbox(route: SandboxedRouteContext, ctx: PluginContext): Promise<unknown> {
  const input = request(route);
  if (input.op === "wants") {
    await ctx.kv.set(LAST_VISIT, new Date().toISOString());
    const wants = [];
    for (const topic of Object.keys(TOPICS)) {
      const after = await ctx.kv.get<unknown>(bookmark(topic));
      wants.push({ from: SENDER, topic, after: typeof after === "string" ? after : null, limit: BATCH });
    }
    return { courier: COURIER, wants };
  }
  if (input.op !== "deliver") throw new PluginRouteError("BAD_COURIER_REQUEST", "An inbox answers \"wants\" and \"deliver\".", 400);
  const { from, topic, items } = input;
  const kind = typeof topic === "string" && Object.hasOwn(TOPICS, topic) ? TOPICS[topic] : undefined;
  if (from !== SENDER || !kind) throw new PluginRouteError("UNWANTED_TOPIC", "Store emails takes order.paid, order.shipped and cart.left from Commerce.", 400);
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new PluginRouteError("BAD_COURIER_REQUEST", "A delivery needs at most 100 items.", 400);
  const after = typeof input.after === "string" ? input.after : null, next = typeof input.next === "string" ? input.next : null;
  const key = bookmark(topic as string);
  const before = await ctx.kv.getVersioned<unknown>(key);
  const now = Date.now();
  let origin = "";
  try { origin = new URL(ctx.url("/")).origin; } catch { /* no site address: cart links cannot be checked, so cart news is kept as unreadable */ }
  let saved = 0;
  for (const item of items) {
    const id = record(item) && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 200 ? item.id : null;
    const at = record(item) ? when(item.at) : null;
    if (!id || !at) continue;
    // Created only when absent, so a repeated delivery changes nothing and never sends a second email.
    if ((await emails(ctx).compareAndSet(id, null, received(kind, { id, at, data: (item as Record<string, unknown>).data }, origin, now))).applied) saved++;
  }
  if (items.length > 0) await ctx.kv.set(LAST_NEWS, new Date(now).toISOString());
  // The bookmark moves only after the news is kept, and only from the bookmark this batch was asked from,
  // so a slower, older run never moves it back.
  const current = typeof before?.value === "string" ? before.value : null;
  let moved = false;
  if (current === after && next !== null && next !== after) moved = (await ctx.kv.compareAndSet(key, before?.revision ?? null, next)).applied;
  return { courier: COURIER, saved, moved };
}

export interface CourierState { state: "visiting" | "late" | "missing"; lastVisit: string | null; lastNews: string | null }

/** Whether the store's courier is coming by, and when Commerce's news last arrived, for the owner's page. */
export async function courierState(ctx: PluginContext, now = Date.now()): Promise<CourierState> {
  const [lastVisit, lastNews] = await Promise.all([ctx.kv.get<unknown>(LAST_VISIT), ctx.kv.get<unknown>(LAST_NEWS)]);
  const news = typeof lastNews === "string" ? lastNews : null;
  if (typeof lastVisit !== "string" || Number.isNaN(Date.parse(lastVisit))) return { state: "missing", lastVisit: null, lastNews: news };
  return { state: now - Date.parse(lastVisit) > LATE_AFTER_MS ? "late" : "visiting", lastVisit, lastNews: news };
}
