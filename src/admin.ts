import type { Block, BlockResponse } from "@emdash-cms/blocks/server";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { look, recent, senderState, type EmailRecord } from "./emails.js";
import { courierState, type CourierState } from "./inbox.js";
import { LOGO_MAX_BYTES, LOGO_TYPES } from "./logo.js";
import { sampleOrder } from "./render.js";
import { CART_MODES, COLOUR, FOOTER_MAX, cartMode, saveCartMode, saveShipping, saveStyling, shippingOn, styling, type CartMode } from "./settings.js";

/** The Store emails page (store-emails-plugin-20261122 item 5, store-email-styling-20261122), for Administrators. */
const ADMIN = 50;
/** The Guide page on switching the store's sender to SMTP (store-email-sender-20261122 item 3). */
export const SMTP_GUIDE = "https://dinkuskit.com/docs/store-owners/email-sender/";
const LIBRARY_PAGE = 12;

type Toast = BlockResponse["toast"];
interface Action { type: "block_action"; action_id: string; value?: unknown }
interface Submit { type: "form_submit"; action_id: string; values: Record<string, unknown> }
type Interaction = { type: "page_load" } | Action | Submit;

function interaction(input: unknown): Interaction | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Record<string, unknown>;
  if (value.type === "page_load") return { type: "page_load" };
  if (value.type === "block_action" && typeof value.action_id === "string") return { type: "block_action", action_id: value.action_id, value: value.value };
  if (value.type === "form_submit" && typeof value.action_id === "string" && typeof value.values === "object" && value.values !== null) {
    return { type: "form_submit", action_id: value.action_id, values: value.values as Record<string, unknown> };
  }
  return null;
}

const header = (text: string): Block => ({ type: "header", text });
const context = (text: string): Block => ({ type: "context", text });
const section = (text: string): Block => ({ type: "section", text });
const cursorOf = (value: unknown) => {
  const cursor = typeof value === "object" && value !== null ? (value as { cursor?: unknown }).cursor : value;
  return typeof cursor === "string" && cursor.length > 0 && cursor.length <= 2000 ? cursor : undefined;
};

const CART_LABELS: Record<CartMode, string> = { off: "Off", ticked: "Shoppers who ticked the box", all: "All customers" };
/** Store emails' own note under the cart email choice, word for word from store-email-sender-20261122 item 3. */
export const CART_NOTE = "Cart emails are marketing, so they need an SMTP sender. Cloudflare's sender doesn't allow marketing email, so cart emails won't go out while it is picked in Settings > Email.";

const RESULT: Record<EmailRecord["state"], string> = { waiting: "🟡 Waiting", sent: "🟢 Sent", failed: "🔴 Not sent", skipped: "⚪ Not sent", blocked: "⚪ Not sent" };
function result(record: EmailRecord): string {
  if (record.state === "waiting" && record.tries > 0) return "🔴 Failed, trying again";
  if (record.state === "sent") return RESULT.sent;
  return record.reason ? `${RESULT[record.state].slice(0, 2)} ${record.reason}` : RESULT[record.state];
}

/** Says plainly whether Commerce's news is reaching Store emails (plugin-communication-rule-20261122). */
function courierBlock({ state, lastNews }: CourierState): Block {
  const news = lastNews ? "" : " No order news has arrived yet.";
  if (state === "missing") {
    return { type: "banner", variant: "alert", title: "Order news from Commerce does not reach Store emails yet",
      description: "Store emails hears about paid orders, shipped orders and left carts through your store's courier, which has not come by yet. Stores built from the DinkusKit template run it every minute. No email goes out until it does." };
  }
  if (state === "late") {
    return { type: "banner", variant: "alert", title: "Your store's courier is late",
      description: "It should come by about once a minute and has not for more than 5 minutes. Emails go out once it runs again." + news };
  }
  return context(lastNews ? `Order news from Commerce last arrived ${new Date(lastNews).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC.` : "Your store's courier comes by every minute. No order news has arrived yet.");
}

interface View { shipping: boolean; cart: CartMode; courier: CourierState; noSender: boolean; noAddress: boolean; logo: Block; colour: string; footer: string; logoPicked: boolean; items: { id: string; record: EmailRecord }[]; next?: string }

async function view(ctx: PluginContext, cursor?: string): Promise<View> {
  const [shipping, cart, courier, sender, style, page] = await Promise.all([shippingOn(ctx), cartMode(ctx), courierState(ctx), senderState(ctx), styling(ctx), recent(ctx, cursor)]);
  const item = style.logo && ctx.media ? await ctx.media.get(style.logo).catch(() => null) : null;
  const logo: Block = item ? { type: "image", url: item.url, alt: item.alt || item.filename }
    : context(style.logo ? "The logo picked is no longer in Media, so emails show your store's name instead." : "No logo: emails show your store's name.");
  return { shipping, cart, courier, ...sender, logo, colour: style.colour, footer: style.footer, logoPicked: !!item, items: page.items, ...(page.cursor ? { next: page.cursor } : {}) };
}

/** The whole page, drawn fresh from the store's own records on every click. */
export function page(ctx: PluginContext, v: View, toast?: Toast): BlockResponse {
  const blocks: Block[] = [header("Store emails"), context("The emails your customers get from your store, sent from your store's own address.")];
  if (v.noSender) {
    blocks.push({ type: "banner", variant: "alert", title: "No email sender is set up",
      description: "Set one up in Settings > Email. Emails wait here and go out within a minute of that, for up to 3 days." });
  } else if (v.noAddress) {
    blocks.push({ type: "banner", variant: "alert", title: "Your site does not know its own web address",
      description: "The links in an email would not open, so emails wait here. Set the site's address in your site settings." });
  }

  blocks.push(header("Customer emails"), { type: "table", page_action_id: "none", columns: [
    { key: "email", label: "Email" }, { key: "when", label: "Sent when" }, { key: "status", label: "Status" }], rows: [
    { email: "Order confirmation: items, total, ship-to address, link to the order", when: "An order is paid", status: "🟢 On, always" },
    { email: "Shipping confirmation: carrier and tracking number, with a tracking link", when: "An order is marked Completed", status: v.shipping ? "🟢 On" : "⚪ Off" },
  ] });
  blocks.push({ type: "form", block_id: "shipping", fields: [{ type: "toggle", action_id: "shippingOn", label: "Send shipping confirmations",
    description: "Turn this off only if another app already emails shoppers when an order ships. Order confirmations always go out, as on Shopify.", initial_value: v.shipping }],
  submit: { label: "Save", action_id: "save_shipping" } });

  blocks.push({ type: "divider" }, header("Abandoned cart email"),
    context("10 hours after a shopper gives their email at checkout and leaves without paying. One per cart."),
    { type: "form", block_id: "cart", fields: [{ type: "radio", action_id: "cartMode", label: "Send it to",
      options: CART_MODES.map(mode => ({ label: CART_LABELS[mode], value: mode })), initial_value: v.cart }],
    submit: { label: "Save", action_id: "save_cart" } },
    { type: "banner", variant: "alert", description: CART_NOTE },
    { type: "actions", elements: [{ type: "link", label: "How to switch to SMTP", target: { kind: "external", url: SMTP_GUIDE } }] });

  blocks.push({ type: "divider" }, header("How your emails are sent"),
    section(v.noSender ? "Sender: none set up." : "Sender: the one picked in Settings > Email."),
    { type: "actions", elements: [{ type: "link", label: "Open Settings > Email", target: { kind: "external", url: ctx.url("/_emdash/admin/settings/email") } }] },
    courierBlock(v.courier));

  blocks.push({ type: "divider" }, header("Email styling"), context("Used on every email this page sends."),
    section("Logo"), v.logo,
    { type: "actions", elements: [
      { type: "button", label: v.logoPicked ? "Choose another from Media" : "Choose from Media", action_id: "logo.pick" },
      ...(v.logoPicked ? [{ type: "button" as const, label: "Remove logo", action_id: "logo.remove" }] : []),
    ] },
    { type: "form", block_id: "styling", fields: [
      { type: "text_input", action_id: "colour", label: "Button colour", initial_value: v.colour, placeholder: "#2f5d3a" },
      { type: "text_input", action_id: "footer", label: "Footer text", initial_value: v.footer },
    ], submit: { label: "Save", action_id: "save_styling" } },
    { type: "actions", elements: [{ type: "button", label: "Email me a sample order", action_id: "sample" }] });

  blocks.push({ type: "divider" }, header("Recent emails"), { type: "table", page_action_id: "more",
    empty_text: "No emails yet. They appear here as orders come in.",
    columns: [{ key: "sent", label: "Sent", format: "relative_time" }, { key: "to", label: "To" }, { key: "email", label: "Email" }, { key: "result", label: "Result" }],
    ...(v.next ? { next_cursor: v.next } : {}),
    rows: v.items.map(({ record }) => ({ sent: record.sentAt ?? record.updatedAt, to: record.masked || "Nobody", email: record.label, result: result(record) })) });
  return { blocks, ...(toast ? { toast } : {}) };
}

/** The store's Media images, 12 at a time, each with "Use this" (Commerce picks its images the same way). */
async function library(ctx: PluginContext, cursor?: string): Promise<BlockResponse> {
  const blocks: Block[] = [header("Choose a logo from Media"), context("PNG, JPEG, GIF or WebP, up to 1 MB. Upload new images on the Media page.")];
  blocks.push({ type: "actions", elements: [{ type: "button", label: "Cancel", action_id: "back" }] });
  if (!ctx.media) return { blocks: [...blocks, { type: "banner", variant: "error", description: "Store emails cannot read your Media library. It needs the media:read permission." }] };
  const found = await ctx.media.list({ limit: LIBRARY_PAGE, mimeType: "image/", ...(cursor ? { cursor } : {}) });
  for (const item of found.items) {
    const usable = LOGO_TYPES.has(item.mimeType) && (item.size === null || item.size <= LOGO_MAX_BYTES);
    blocks.push({ type: "image", url: item.url, alt: item.alt || item.filename },
      usable ? { type: "actions", elements: [{ type: "button", label: `Use ${item.filename}`, action_id: "logo.use", value: item.id, style: "primary" }] }
        : context(`${item.filename} cannot be an email logo: it must be PNG, JPEG, GIF or WebP, up to 1 MB.`));
  }
  if (!found.items.length) blocks.push({ type: "empty", title: "No images yet", description: "Upload images on the Media page." });
  if (found.hasMore && found.cursor) blocks.push({ type: "actions", elements: [{ type: "button", label: "Next", action_id: "logo.pick", value: found.cursor }] });
  return { blocks };
}

const saved: Toast = { message: "Saved.", type: "success" };

/** The page's one private route. EmDash lets only Administrators in (settings:manage); the check here is the belt to that permission's braces. */
export async function storeEmailsAdmin(route: SandboxedRouteContext, ctx: PluginContext): Promise<BlockResponse> {
  const user = route.user;
  if (route.ui?.surface !== "admin-page" || typeof user?.role !== "number" || user.role < ADMIN) {
    return { blocks: [{ type: "banner", variant: "error", title: "Store emails is for Administrators", description: "Ask an Administrator of this site to change the store's emails." }] };
  }
  const input = interaction(route.input);
  if (!input) return { blocks: [] };
  const draw = async (toast?: Toast, cursor?: string) => page(ctx, await view(ctx, cursor), toast);
  if (input.type === "page_load") return draw();

  if (input.type === "form_submit") {
    const values = input.values;
    if (input.action_id === "save_shipping") {
      await saveShipping(ctx, values.shippingOn === true);
      return draw(saved);
    }
    if (input.action_id === "save_cart") {
      if (!CART_MODES.includes(values.cartMode as CartMode)) return draw({ message: "Not saved. Pick one of the three choices.", type: "error" });
      await saveCartMode(ctx, values.cartMode as CartMode);
      return draw(saved);
    }
    if (input.action_id === "save_styling") {
      const colour = typeof values.colour === "string" ? values.colour.trim() : "", footer = typeof values.footer === "string" ? values.footer.trim() : "";
      if (!COLOUR.test(colour)) return draw({ message: "Not saved. The button colour is a # and six letters or digits, such as #2f5d3a.", type: "error" });
      if (footer.length > FOOTER_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(footer)) return draw({ message: `Not saved. The footer text is one line of up to ${FOOTER_MAX} characters.`, type: "error" });
      await saveStyling(ctx, { ...(await styling(ctx)), colour: colour.toLowerCase(), footer });
      return draw(saved);
    }
    return { blocks: [] };
  }

  switch (input.action_id) {
    case "back": return draw();
    case "more": return draw(undefined, cursorOf(input.value));
    case "logo.pick": return library(ctx, cursorOf(input.value));
    case "logo.remove":
      await saveStyling(ctx, { ...(await styling(ctx)), logo: null });
      return draw({ message: "Logo removed. Emails show your store's name.", type: "success" });
    case "logo.use": {
      const id = typeof input.value === "string" && input.value.length <= 200 ? input.value : "";
      const item = id && ctx.media ? await ctx.media.get(id).catch(() => null) : null;
      if (!item || !LOGO_TYPES.has(item.mimeType) || (item.size !== null && item.size > LOGO_MAX_BYTES)) {
        return draw({ message: "That image cannot be the logo. Pick a PNG, JPEG, GIF or WebP of up to 1 MB.", type: "error" });
      }
      await saveStyling(ctx, { ...(await styling(ctx)), logo: item.id });
      return draw({ message: "Logo saved. Every email uses it from now on.", type: "success" });
    }
    case "sample": {
      if (!ctx.email) return draw({ message: "No email sender is set up. Set one up in Settings > Email first.", type: "error" });
      try {
        await ctx.email.send({ to: user.email, ...sampleOrder(await look(ctx)) });
      } catch {
        return draw({ message: "Your email sender did not take the sample. Check Settings > Email.", type: "error" });
      }
      return draw({ message: `A sample order confirmation is on its way to ${user.email}.`, type: "success" });
    }
    default: return { blocks: [] };
  }
}
