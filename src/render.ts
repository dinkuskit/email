import type { Address, CartNews, Line, Money, OrderNews, ShippedNews } from "./news.js";
import type { Styling } from "./settings.js";

/**
 * The three emails, each as simple HTML with its styles written inline and a plain-text copy
 * (store-email-styling-20261122). No tracking pixels and no links but the store's own and the carrier's.
 */
export interface Look extends Styling {
  /** The store's name, or its host when the site has no name. */
  store: string;
  /** The public address of the logo the owner picked, or null to show the store's name instead. */
  logoUrl: string | null;
  /** The store's order lookup page. */
  trackOrder: string;
}
export interface Message { subject: string; text: string; html: string }

const escape = (value: string) => value.replace(/[&<>"']/g, mark => `&#${mark.charCodeAt(0)};`);

/** "$1,234.56" for US dollars; other currencies read "1,234.56 EUR". */
export function price(money: Money): string {
  const negative = money.minor.startsWith("-"), digits = money.minor.replace("-", "").padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ","), amount = `${whole}.${digits.slice(-2)}`;
  return (negative ? "-" : "") + (money.currency === "USD" ? `$${amount}` : `${amount} ${money.currency}`);
}

/** A line's total: its unit price times its quantity, in whole minor units. */
function lineTotal(line: Line): Money | null {
  return line.unitPrice ? { currency: line.unitPrice.currency, minor: (BigInt(line.unitPrice.minor) * BigInt(line.quantity ?? 1)).toString() } : null;
}

const itemText = (line: Line) => `${line.quantity ? `${line.quantity} × ` : ""}${line.name}${line.options ? ` (${line.options})` : ""}`;
const more = (count: number) => (count > 0 ? `and ${count} more item${count === 1 ? "" : "s"}` : "");

/** Carrier tracking pages, for the carriers US stores ship with. Any other carrier shows the number alone. */
const TRACKERS: [RegExp, string][] = [
  [/usps|postal service/i, "https://tools.usps.com/go/TrackConfirmAction?tLabels="],
  [/\bups\b/i, "https://www.ups.com/track?tracknum="],
  [/fedex/i, "https://www.fedex.com/fedextrack/?trknbr="],
  [/dhl/i, "https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id="],
];
export function trackingLink(carrier: string | null, tracking: string | null): string | null {
  if (!carrier || !tracking) return null;
  const found = TRACKERS.find(([name]) => name.test(carrier));
  // Labels print the number in groups ("9400 1000 ..."); the carriers' pages want it without the spaces.
  return found ? found[1] + encodeURIComponent(tracking.replace(/\s+/g, "")) : null;
}

const addressLines = (to: Address) => [to.name, to.line1, to.line2, [to.city, [to.region, to.postalCode].filter(Boolean).join(" ")].join(", "), to.country === "US" ? "" : to.country].filter(Boolean) as string[];

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MUTED = "color:#6b6b6b";

/** The frame every email shares: logo or store name, the body, the footer line and the store's name. */
function frame(look: Look, title: string, body: string): string {
  const head = look.logoUrl
    ? `<img src="${escape(look.logoUrl)}" alt="${escape(look.store)}" style="display:block;max-width:180px;max-height:60px;border:0">`
    : `<div style="font-size:20px;font-weight:700;color:${look.colour}">${escape(look.store)}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f4f4f4;${FONT}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px"><tr><td style="padding:32px;color:#1a1a1a;font-size:15px;line-height:1.5">` +
    `${head}${body}` +
    `<p style="margin:32px 0 0;text-align:center;font-size:13px;${MUTED}">${look.footer ? `${escape(look.footer)}<br>` : ""}${escape(look.store)}</p>` +
    `</td></tr></table></td></tr></table></body></html>`;
}

const heading = (words: string) => `<h1 style="margin:24px 0 8px;font-size:22px;line-height:1.3">${escape(words)}</h1>`;
const paragraph = (words: string) => `<p style="margin:0 0 20px">${escape(words)}</p>`;
const button = (look: Look, label: string, href: string) =>
  `<p style="margin:0 0 24px"><a href="${escape(href)}" style="display:inline-block;background:${look.colour};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:6px">${escape(label)}</a></p>`;
const row = (left: string, right: string, strong = false) =>
  `<tr><td style="padding:8px 0;border-top:1px solid #e6e6e6${strong ? ";font-weight:700;font-size:17px" : ""}">${left}</td>` +
  `<td align="right" style="padding:8px 0;border-top:1px solid #e6e6e6;white-space:nowrap${strong ? ";font-weight:700;font-size:17px" : ""}">${right}</td></tr>`;

function itemsHtml(lines: Line[], moreLines: number, priced: boolean): string {
  const rows = lines.map(line => {
    const total = priced ? lineTotal(line) : null;
    return row(escape(itemText(line)), total ? escape(price(total)) : "");
  });
  if (moreLines > 0) rows.push(row(`<span style="${MUTED}">${escape(more(moreLines))}</span>`, ""));
  return rows.join("");
}

function itemsText(lines: Line[], moreLines: number, priced: boolean): string[] {
  const rows = lines.map(line => {
    const total = priced ? lineTotal(line) : null;
    return total ? `${itemText(line)}  ${price(total)}` : itemText(line);
  });
  if (moreLines > 0) rows.push(more(moreLines));
  return rows;
}

const orderName = (number: number | null) => (number === null ? "your order" : `order #${number}`);
const Title = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** The order confirmation (store-emails-plugin-20261122 item 1), like Shopify's. */
export function orderConfirmation(look: Look, order: OrderNews, test = false): Message {
  const name = orderName(order.number), mark = test ? "[Test] " : "";
  const subject = `${mark}${Title(name)} confirmed`;
  const sums: [string, Money | null][] = [["Subtotal", order.subtotal], ["Discount", order.discount && order.discount.minor !== "0" ? { ...order.discount, minor: order.discount.minor.startsWith("-") ? order.discount.minor : `-${order.discount.minor}` } : null], ["Shipping", order.shipping]];
  const totals = sums.filter((pair): pair is [string, Money] => pair[1] !== null);
  const total = `${price(order.total)}${order.total.currency === "USD" ? " USD" : ""}`;
  const lead = `We've got ${name} and will email you again when it ships.`;
  const html = frame(look, subject,
    (test ? paragraph("This is a TEST order, so this email went to you instead of the shopper.") : "") +
    heading("Thank you for your order!") + paragraph(lead) + button(look, "View your order", look.trackOrder) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 24px">` +
    itemsHtml(order.lines, order.moreLines, true) + totals.map(([label, money]) => row(label, escape(price(money)))).join("") + row("Total", escape(total), true) + `</table>` +
    (order.shipTo ? `<p style="margin:0 0 4px;font-weight:700">Shipping to</p><p style="margin:0">${addressLines(order.shipTo).map(escape).join("<br>")}</p>` : ""));
  const text = [
    ...(test ? ["This is a TEST order, so this email went to you instead of the shopper.", ""] : []),
    "Thank you for your order!", "", lead, "", `View your order: ${look.trackOrder}`, "",
    ...itemsText(order.lines, order.moreLines, true), "",
    ...totals.map(([label, money]) => `${label}: ${price(money)}`), `Total: ${total}`,
    ...(order.shipTo ? ["", "Shipping to", ...addressLines(order.shipTo)] : []),
    "", look.footer, look.store,
  ].join("\n");
  return { subject, text, html };
}

/** The shipping confirmation (item 2), with the carrier and tracking number when the owner gave them. */
export function shippingConfirmation(look: Look, order: ShippedNews, test = false): Message {
  const name = orderName(order.number), mark = test ? "[Test] " : "";
  const subject = `${mark}${Title(name)} is on its way`;
  const link = trackingLink(order.carrier, order.tracking);
  const facts = [order.carrier ? `Carrier: ${order.carrier}` : "", order.tracking ? `Tracking number: ${order.tracking}` : ""].filter(Boolean);
  const lead = `Good news: ${name} has shipped.`;
  const html = frame(look, subject,
    (test ? paragraph("This is a TEST order, so this email went to you instead of the shopper.") : "") +
    heading("Your order is on its way") + paragraph(lead) +
    (facts.length ? `<p style="margin:0 0 20px">${facts.map(escape).join("<br>")}</p>` : "") +
    button(look, link ? "Track your package" : "View your order", link ?? look.trackOrder) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 8px">${itemsHtml(order.lines, order.moreLines, false)}</table>`);
  const text = [
    ...(test ? ["This is a TEST order, so this email went to you instead of the shopper.", ""] : []),
    "Your order is on its way", "", lead, ...(facts.length ? ["", ...facts] : []), "",
    link ? `Track your package: ${link}` : `View your order: ${look.trackOrder}`, "",
    ...itemsText(order.lines, order.moreLines, false), "", look.footer, look.store,
  ].join("\n");
  return { subject, text, html };
}

/**
 * The abandoned-cart email (item 3). Its stop link is in both parts: CAN-SPAM wants a way out of every
 * commercial email, and the template's Cloudflare guard finds the cart email by it (store-email-sender-20261122).
 */
export function cartReminder(look: Look, cart: CartNews): Message {
  const subject = `You left something in your cart at ${look.store}`;
  const lead = `You started checking out at ${look.store} but didn't finish. Your cart is saved.`;
  const stop = "Don't want cart reminder emails?";
  const html = frame(look, subject,
    heading("You left something in your cart") + paragraph(lead) + button(look, "Return to your cart", cart.link) +
    (cart.lines ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 24px">${itemsHtml(cart.lines, cart.moreLines, false)}</table>` : "") +
    `<p style="margin:0;font-size:13px;${MUTED}">${escape(stop)} <a href="${escape(cart.stopLink)}" style="${MUTED}">Stop these emails</a>.</p>`);
  const text = [
    "You left something in your cart", "", lead, "", `Return to your cart: ${cart.link}`, "",
    ...(cart.lines ? [...itemsText(cart.lines, cart.moreLines, false), ""] : []),
    `${stop} Stop these emails: ${cart.stopLink}`, "", look.footer, look.store,
  ].join("\n");
  return { subject, text, html };
}

/** What "Email me a sample order" sends: an order confirmation with made-up items, marked as a sample. */
export function sampleOrder(look: Look): Message {
  const usd = (minor: string): Money => ({ currency: "USD", minor });
  const message = orderConfirmation(look, {
    orderId: "sample", number: 1001, test: false, email: null, name: "Jamie Rivera",
    shipTo: { name: "Jamie Rivera", line1: "12 Pine Street", city: "Asheville", region: "NC", postalCode: "28801", country: "US" },
    lines: [{ name: "Sample T-shirt", options: "Size: M · Colour: Black", quantity: 2, unitPrice: usd("2400") }, { name: "Sample mug", options: "", quantity: 1, unitPrice: usd("1600") }],
    moreLines: 0, subtotal: usd("6400"), discount: null, shipping: usd("600"), total: usd("7000"),
  });
  return { ...message, subject: `[Sample] ${message.subject}` };
}
