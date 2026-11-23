import type { PluginContext } from "emdash/plugin";
import { cartNews, orderNews, shippedNews, type CartNews, type Kind, type OrderNews, type ShippedNews } from "./news.js";
import { cartReminder, orderConfirmation, shippingConfirmation, type Look, type Message } from "./render.js";
import { cartMode, shippingOn, styling } from "./settings.js";

/**
 * Every email Store emails sends or decides not to send, one record per item of courier news, kept by
 * the news id so a repeated delivery never sends a second email. While an email waits its record holds
 * what the email needs; once it is settled only the log line stays (who, masked, what, and the result).
 */
export type State = "waiting" | "sent" | "failed" | "skipped" | "blocked";
export interface EmailRecord {
  kind: Kind;
  state: State;
  /** When it happened in Commerce, and when the news arrived here. */
  at: string;
  receivedAt: string;
  /** Last change; the Recent emails list is ordered by it, and records older than 90 days are pruned by it. */
  updatedAt: string;
  /** What the owner sees in Recent emails, such as "Order #1043 confirmed". */
  label: string;
  /** "j••••@gmail.com", or "You (test order)". */
  masked: string;
  test?: boolean;
  tries: number;
  /** When a waiting email is next due. */
  nextTry?: string;
  sentAt?: string;
  /** Why it was not sent, or why it is being tried again. */
  reason?: string;
  /** What the email needs, only while it waits. */
  news?: OrderNews | ShippedNews | CartNews;
}

interface Collection {
  getVersioned(id: string): Promise<{ value: unknown; revision: string } | null>;
  compareAndSet(id: string, expectedRevision: string | null, data: unknown): Promise<{ applied: true; revision: string } | { applied: false }>;
  query(options?: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number; cursor?: string }):
    Promise<{ items: { id: string; data: unknown }[]; cursor?: string; hasMore?: boolean }>;
  delete(id: string): Promise<boolean>;
}
export const emails = (ctx: PluginContext) => (ctx.storage as unknown as { emails: Collection }).emails;

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
/** News that reaches Store emails more than a day after it happened is not emailed: a confirmation that late helps nobody. */
export const LATE_MS = DAY;
/** An email that could not go out for 3 days (no sender, or failures) is given up on. */
export const GIVE_UP_MS = 3 * DAY;
/** Waits between tries after a failed hand-over: 1, 5, 15 and 60 minutes, then it is given up on. */
export const RETRY_MINUTES = [1, 5, 15, 60];
/** Emails handed to the sender in one run; a run is due every minute. */
export const RUN_MAX = 10;
/** Log lines are kept 90 days. */
export const KEEP_MS = 90 * DAY;
const PRUNE_MAX = 20;
/** The template's Cloudflare guard refuses a cart email with this code (store-email-sender-20261122). */
const BLOCKED = /MARKETING_BLOCKED/;
/**
 * Commerce refuses a cart email at send time with this code once its shopper has stopped cart emails, even one that
 * waited or was being retried (cart-email-stop-at-send-20261123). EmDash puts the plugin and hook in front of it.
 */
const STOPPED = /CART_EMAIL_STOPPED/;

/** "j••••@gmail.com": enough for the owner to tell emails apart, and never a whole address on the page. */
export function mask(address: string): string {
  const at = address.lastIndexOf("@");
  return `${address.slice(0, 1)}••••${address.slice(at)}`;
}

const numbered = (number: number | null, words: string) => (number === null ? `Order ${words}` : `Order #${number} ${words}`);

/** A courier item as a record, ready to keep; a news item out of shape is kept as not sent. */
export function received(kind: Kind, item: { id: string; at: string; data: unknown }, origin: string, now: number): EmailRecord {
  const iso = new Date(now).toISOString();
  const base = { kind, at: item.at, receivedAt: iso, updatedAt: iso, tries: 0 };
  const news = kind === "order" ? orderNews(item.data) : kind === "shipped" ? shippedNews(item.data) : cartNews(item.data, origin);
  const what = { order: "confirmation", shipped: "shipping confirmation", cart: "cart email" }[kind];
  if (!news) return { ...base, state: "skipped", label: `An ${what} Commerce sent could not be read`, masked: "", reason: "Not sent: the order news was out of shape" };
  const label = "orderId" in news ? numbered(news.number, kind === "order" ? "confirmed" : "shipped") : "Cart reminder";
  const test = "test" in news && news.test;
  const to = test ? null : news.email;
  const masked = test ? "You (test order)" : to ? mask(to) : "";
  if (!test && !to) return { ...base, state: "skipped", label, masked, reason: "Not sent: the order has no email address" };
  if (now - Date.parse(item.at) > LATE_MS) return { ...base, state: "skipped", label, masked, ...(test ? { test } : {}), reason: "Not sent: the news arrived more than a day late" };
  return { ...base, state: "waiting", label, masked, ...(test ? { test } : {}), nextTry: iso, news };
}

/** The store's first Administrator, who gets the emails of TEST orders; null when the store has none with an address. */
export async function ownerAddress(ctx: PluginContext): Promise<string | null> {
  if (!ctx.users) return null;
  const { items } = await ctx.users.list({ role: 50, limit: 100 });
  const owner = items.filter(user => user.role >= 50 && user.email).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return owner?.email ?? null;
}

/** How every email looks today, from the owner's styling and the store's own addresses. */
export async function look(ctx: PluginContext): Promise<Look> {
  const style = await styling(ctx);
  const home = ctx.url("/");
  let host = "";
  try { host = new URL(home).host; } catch { /* a site that does not know its address: the run refuses to send */ }
  return {
    ...style, store: ctx.site.name || host || "Our store", trackOrder: ctx.url("/track-order"),
    logoUrl: style.logo ? ctx.url(`/_emdash/api/plugins/${encodeURIComponent(ctx.plugin.id)}/logo?v=${encodeURIComponent(style.logo)}`) : null,
  };
}

function message(record: EmailRecord, looks: Look): Message {
  const news = record.news!;
  if (record.kind === "order") return orderConfirmation(looks, news as OrderNews, !!record.test);
  if (record.kind === "shipped") return shippingConfirmation(looks, news as ShippedNews, !!record.test);
  return cartReminder(looks, news as CartNews);
}

/** Why a waiting email will not go out after all, under the owner's choices now; null when it should go. */
async function stopped(ctx: PluginContext, record: EmailRecord, now: number): Promise<string | null> {
  if (now - Date.parse(record.receivedAt) > GIVE_UP_MS) return "Not sent: it could not go out for 3 days";
  if (record.kind === "shipped" && !(await shippingOn(ctx))) return "Not sent: shipping confirmations are off";
  if (record.kind === "cart") {
    const mode = await cartMode(ctx);
    if (mode === "off") return "Not sent: cart emails are off";
    if (mode === "ticked" && !(record.news as CartNews).ticked) return "Not sent: the shopper did not tick the box";
  }
  return null;
}

const NO_SENDER = "state:no-sender";
const NO_ADDRESS = "state:no-address";
const settle = ({ news: _news, nextTry: _next, ...rest }: EmailRecord, change: Partial<EmailRecord>): EmailRecord => ({ ...rest, ...change });

export interface RunResult { sent: number; failed: number; skipped: number; reason?: "no-sender" | "no-address" }

/**
 * One run, every minute on the site's scheduler: hands each email that is due to the store's sender,
 * oldest first. An email is marked sent before it is handed over, by a write that lands only while it
 * still waits, so two runs at once never send it twice. That write already drops the email's content
 * (address, ship-to, cart links): the content goes to the sender from memory, and is written back only
 * when the sender refuses it and it waits for another try. So an email the sender took is never sent
 * again, and a run stopped mid-send leaves only the log line. A failed hand-over waits and is tried
 * again; the fifth failure gives it up. A cart email the template's Cloudflare guard refuses is not
 * tried again. Without a sender or the site's address nothing is sent, but emails still give up after
 * 3 days, or when the owner's choices no longer want them, and their content is dropped.
 */
export async function sendDue(ctx: PluginContext, now = Date.now()): Promise<RunResult> {
  const result: RunResult = { sent: 0, failed: 0, skipped: 0 };
  await prune(ctx, now);
  const sender = ctx.email;
  await ctx.kv.set(NO_SENDER, !sender);
  // Links in an email must be whole web addresses; a site that does not know its own would send dead ones.
  const addressed = /^https?:\/\/[^/]/.test(ctx.url("/"));
  await ctx.kv.set(NO_ADDRESS, !addressed);
  const blocked: RunResult["reason"] = !sender ? "no-sender" : !addressed ? "no-address" : undefined;
  if (blocked) result.reason = blocked;
  const iso = new Date(now).toISOString();
  const page = await emails(ctx).query({ where: { state: "waiting", nextTry: { lte: iso } }, orderBy: { nextTry: "asc" }, limit: RUN_MAX });
  if (page.items.length === 0) return result;
  const looks = blocked ? null : await look(ctx);
  let owner: string | null | undefined;
  for (const { id } of page.items) {
    const stored = await emails(ctx).getVersioned(id);
    const record = stored?.value as EmailRecord | undefined;
    if (!stored || !record || record.state !== "waiting" || !record.news || !(record.nextTry! <= iso)) continue;
    let reason = await stopped(ctx, record, now);
    if (!reason && (blocked || !sender || !looks)) continue; // waits for a sender
    let to = record.test ? null : (record.news as { email: string | null }).email;
    if (!reason && record.test) {
      owner ??= await ownerAddress(ctx);
      to = owner;
      if (!to) reason = "Not sent: no Administrator address for a test order";
    }
    if (reason) {
      if ((await emails(ctx).compareAndSet(id, stored.revision, settle(record, { state: "skipped", reason, updatedAt: iso }))).applied) result.skipped++;
      continue;
    }
    const tries = record.tries + 1;
    const claimed = settle(record, { state: "sent", sentAt: iso, updatedAt: iso, tries });
    delete claimed.reason;
    const claim = await emails(ctx).compareAndSet(id, stored.revision, claimed);
    if (!claim.applied) continue;
    let refusal: unknown = null;
    try {
      await sender!.send({ to: to!, ...message(record, looks!) });
    } catch (error) {
      refusal = error ?? new Error("refused");
    }
    if (!refusal) { result.sent++; continue; }
    const words = refusal instanceof Error ? refusal.message : String(refusal);
    // The refusal may hold the shopper's address, so only the email's kind is kept and logged.
    const { sentAt: _sentAt, ...unsent } = claimed;
    let change: EmailRecord;
    if (record.kind === "cart" && STOPPED.test(words)) {
      result.skipped++;
      await emails(ctx).compareAndSet(id, claim.revision, { ...unsent, state: "skipped", reason: "Not sent: the shopper stopped cart emails" });
      continue;
    }
    result.failed++;
    if (BLOCKED.test(words)) change = { ...unsent, state: "blocked", reason: "Not sent: cart emails need an SMTP sender" };
    else if (tries > RETRY_MINUTES.length) {
      ctx.log.warn("An email could not be handed to the store's email sender and was given up on", { kind: record.kind, tries });
      change = { ...unsent, state: "failed", reason: "Failed 5 times; not sent" };
    } else {
      ctx.log.warn("An email could not be handed to the store's email sender; it will be tried again", { kind: record.kind, tries });
      change = { ...unsent, news: record.news, state: "waiting", nextTry: new Date(now + RETRY_MINUTES[tries - 1]! * MINUTE).toISOString(), reason: "Failed, trying again" };
    }
    // Only this run's own claim is turned back; a write that loses a race leaves the content dropped.
    await emails(ctx).compareAndSet(id, claim.revision, change);
  }
  return result;
}

/** Drops log lines older than 90 days, a few each run, so the store keeps no shopper's address for longer. */
async function prune(ctx: PluginContext, now: number): Promise<void> {
  const cutoff = new Date(now - KEEP_MS).toISOString();
  const { items } = await emails(ctx).query({ where: { updatedAt: { lt: cutoff } }, orderBy: { updatedAt: "asc" }, limit: PRUNE_MAX });
  for (const { id } of items) await emails(ctx).delete(id);
}

export interface SenderState { noSender: boolean; noAddress: boolean }
export async function senderState(ctx: PluginContext): Promise<SenderState> {
  const [noSender, noAddress] = await Promise.all([ctx.kv.get<unknown>(NO_SENDER), ctx.kv.get<unknown>(NO_ADDRESS)]);
  // Before the first run, the page reads the sender from the page's own context.
  return { noSender: noSender === null ? !ctx.email : noSender === true, noAddress: noAddress === true };
}

/** The newest emails, for the Recent emails list. */
export async function recent(ctx: PluginContext, cursor?: string) {
  const page = await emails(ctx).query({ orderBy: { updatedAt: "desc" }, limit: 20, ...(cursor ? { cursor } : {}) });
  return { items: page.items.map(({ id, data }) => ({ id, record: data as EmailRecord })), cursor: page.hasMore ? page.cursor : undefined };
}
