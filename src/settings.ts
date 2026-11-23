import type { PluginContext } from "emdash/plugin";

/** The owner's choices on the Store emails page, kept in the plugin's own key-value store. */
export type CartMode = "off" | "ticked" | "all";
export const CART_MODES: CartMode[] = ["off", "ticked", "all"];
export interface Styling { logo: string | null; colour: string; footer: string }

const SHIPPING = "state:shipping-on";
const CART = "state:cart-mode";
const STYLING = "state:styling";

/** WooCommerce's footer default reads the same way; the owner can change it. */
export const FOOTER_DEFAULT = "Questions? Reply to this email.";
export const COLOUR_DEFAULT = "#2f5d3a";
export const FOOTER_MAX = 200;
export const COLOUR = /^#[0-9a-fA-F]{6}$/;

/** Shipping confirmations are on unless the owner turned them off. */
export async function shippingOn(ctx: PluginContext): Promise<boolean> {
  return (await ctx.kv.get<unknown>(SHIPPING)) !== false;
}

/** Cart emails start Off: they are marketing, and the store's first sender is Cloudflare's (store-email-sender-20261122). */
export async function cartMode(ctx: PluginContext): Promise<CartMode> {
  const mode = await ctx.kv.get<unknown>(CART);
  return CART_MODES.includes(mode as CartMode) ? mode as CartMode : "off";
}

export async function styling(ctx: PluginContext): Promise<Styling> {
  const saved = await ctx.kv.get<unknown>(STYLING);
  const value = typeof saved === "object" && saved !== null ? saved as Partial<Styling> : {};
  return {
    logo: typeof value.logo === "string" && value.logo ? value.logo : null,
    colour: typeof value.colour === "string" && COLOUR.test(value.colour) ? value.colour.toLowerCase() : COLOUR_DEFAULT,
    footer: typeof value.footer === "string" && value.footer.length <= FOOTER_MAX ? value.footer : FOOTER_DEFAULT,
  };
}

export const saveShipping = (ctx: PluginContext, on: boolean) => ctx.kv.set(SHIPPING, on);
export const saveCartMode = (ctx: PluginContext, mode: CartMode) => ctx.kv.set(CART, mode);
export const saveStyling = (ctx: PluginContext, value: Styling) => ctx.kv.set(STYLING, value);
