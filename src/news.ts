/**
 * The news Commerce passes to Store emails through the store's courier (store-emails-plugin-20261122),
 * read and checked here. Nothing from the courier is trusted as it comes: an item that does not read
 * as the topic's shape is kept as "not sent" with a reason and never emailed.
 */

export interface Money { currency: string; minor: string }
export interface Address { name: string; line1: string; line2?: string; city: string; region?: string; postalCode: string; country: string }
/** A line as the shopper sees it. A shipped order's lines carry no quantity, so none is shown for them. */
export interface Line { name: string; options: string; quantity?: number; unitPrice?: Money }

/** An order was paid: the order confirmation. */
export interface OrderNews {
  orderId: string; number: number | null; test: boolean; email: string | null; name: string | null;
  shipTo: Address | null; lines: Line[]; moreLines: number;
  subtotal: Money | null; discount: Money | null; shipping: Money | null;
  /** Sales tax, when the Tax plugin priced the order (dinkuskit/commerce#309); null or absent when untaxed. */
  tax: Money | null;
  total: Money;
}
/** An order was marked Completed: the shipping confirmation. */
export interface ShippedNews {
  orderId: string; number: number | null; test: boolean; email: string | null; name: string | null;
  carrier: string | null; tracking: string | null; lines: Line[]; moreLines: number;
}
/** A cart was left: the abandoned-cart email, when the owner's choice allows it. */
export interface CartNews { email: string; ticked: boolean; link: string; stopLink: string; lines: Line[] | null; moreLines: number }

export type Kind = "order" | "shipped" | "cart";
export const SENDER = "dinkus-commerce";
export const TOPICS: Record<string, Kind> = { "order.paid": "order", "order.shipped": "shipped", "cart.left": "cart" };
/** Commerce keeps each item under the courier's 8 KB by dropping lines and says how many it left out (moreLines). */
const LINES_MAX = 100;

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** One line of text: no control characters, at most `max` characters. */
export const text = (value: unknown, max = 200) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value.trim() : null;
const maybe = (value: unknown, max = 200) => (value === null || value === undefined ? null : text(value, max));
export const emailAddress = (value: unknown) => {
  const address = text(value, 254);
  return address && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(address) ? address : null;
};
const count = (value: unknown, min: number, max: number) => (Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : null);
const money = (value: unknown): Money | null =>
  record(value) && typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency) && typeof value.minor === "string" && /^-?\d{1,15}$/.test(value.minor)
    ? { currency: value.currency, minor: value.minor } : null;
const moneyOrNull = (value: unknown) => (value === null || value === undefined ? null : money(value) ?? undefined);

function address(value: unknown): Address | null | undefined {
  if (value === null || value === undefined) return null;
  if (!record(value)) return undefined;
  const name = text(value.name), line1 = text(value.line1), city = text(value.city), postalCode = text(value.postalCode, 20), country = text(value.country, 2);
  if (!name || !line1 || !city || !postalCode || !country) return undefined;
  const line2 = maybe(value.line2), region = maybe(value.region, 100);
  return { name, line1, ...(line2 ? { line2 } : {}), city, ...(region ? { region } : {}), postalCode, country };
}

/** Lines that need a name and a quantity; a price where the topic has one. Null when any line is out of shape. */
function lines(value: unknown, priced: boolean): Line[] | null {
  if (!Array.isArray(value) || value.length > LINES_MAX) return null;
  const out: Line[] = [];
  for (const line of value) {
    if (!record(line)) return null;
    const name = text(line.name ?? line.productName, 300), quantity = line.quantity === undefined && !priced ? undefined : count(line.quantity, 1, 100_000);
    const options = line.options === undefined || line.options === null || line.options === "" ? "" : text(line.options, 300);
    const unitPrice = priced ? money(line.unitPrice) : undefined;
    if (!name || quantity === null || options === null || (priced && !unitPrice)) return null;
    out.push({ name, options, ...(quantity ? { quantity } : {}), ...(unitPrice ? { unitPrice } : {}) });
  }
  return out;
}

/** The order id and number every order topic carries. */
function orderParts(data: Record<string, unknown>) {
  const orderId = text(data.orderId), number = data.number === null || data.number === undefined ? null : count(data.number, 1, Number.MAX_SAFE_INTEGER);
  const email = data.email === null ? null : emailAddress(data.email), name = maybe(data.name);
  if (!orderId || (data.number !== null && data.number !== undefined && number === null) || typeof data.test !== "boolean") return null;
  if (email === null && data.email !== null && !data.test) return null;
  return { orderId, number, test: data.test, email, name };
}

export function orderNews(data: unknown): OrderNews | null {
  if (!record(data)) return null;
  const parts = orderParts(data), shipTo = address(data.shipTo), items = lines(data.lines, true), total = money(data.total);
  const subtotal = moneyOrNull(data.subtotal), discount = moneyOrNull(data.discount), shipping = moneyOrNull(data.shipping), tax = moneyOrNull(data.tax);
  const moreLines = data.moreLines === undefined ? 0 : count(data.moreLines, 0, 100_000);
  if (!parts || shipTo === undefined || !items || !total || items.length + (moreLines ?? 0) === 0 || subtotal === undefined || discount === undefined || shipping === undefined || tax === undefined || moreLines === null) return null;
  return { ...parts, shipTo, lines: items, moreLines, subtotal, discount, shipping, tax, total };
}

export function shippedNews(data: unknown): ShippedNews | null {
  if (!record(data)) return null;
  const parts = orderParts(data), items = lines(data.lines, false);
  const carrier = maybe(data.carrier, 100), tracking = maybe(data.tracking, 100);
  const moreLines = data.moreLines === undefined ? 0 : count(data.moreLines, 0, 100_000);
  if (!parts || !items || (data.carrier && !carrier) || (data.tracking && !tracking) || moreLines === null || items.length + moreLines === 0) return null;
  return { ...parts, carrier, tracking, lines: items, moreLines };
}

/**
 * A left cart. Its links must be the store's own cart links (`<site>/cart/c/<id>?key=<secret>`), and the stop
 * link that same link with `&stop=1`, which the template's Cloudflare guard looks for (store-email-sender-20261122).
 */
export function cartNews(data: unknown, origin: string): CartNews | null {
  if (!record(data) || typeof data.ticked !== "boolean") return null;
  const email = emailAddress(data.email), link = text(data.link, 1000), stopLink = text(data.stopLink, 1010);
  const items = data.lines === null ? null : lines(data.lines, false);
  const moreLines = data.moreLines === undefined ? 0 : count(data.moreLines, 0, 100_000);
  if (!email || !link || stopLink !== `${link}&stop=1` || (data.lines !== null && !items) || moreLines === null) return null;
  let url: URL;
  try { url = new URL(link); } catch { return null; }
  if (url.origin !== origin || !url.pathname.startsWith("/cart/c/") || !url.searchParams.get("key")) return null;
  return { email, ticked: data.ticked, link, stopLink, lines: items, moreLines };
}
