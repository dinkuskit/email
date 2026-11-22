import { pluginResponse, type PluginContext } from "emdash/plugin";
import { styling } from "./settings.js";

/**
 * The email logo (store-email-styling-20261122). The logo lives in the store's Media library and the owner
 * picks it on the Store emails page; Store emails keeps only its id. Media's own links need a sign-in, which
 * a shopper's mail app does not have, so this public route serves the one image picked, read from Media each
 * time. It serves nothing else: no id is taken from the request.
 */
export const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** An email logo is shown at most 180 pixels wide, so 1 MB is plenty; a bigger file is not served. */
export const LOGO_MAX_BYTES = 1024 * 1024;

const missing = () => pluginResponse({ status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: { kind: "text", value: "No logo" } });

export async function logo(_route: unknown, ctx: PluginContext) {
  const { logo: id } = await styling(ctx);
  if (!id || !ctx.media?.readBytes) return missing();
  const file = await ctx.media.readBytes(id, { maxBytes: LOGO_MAX_BYTES }).catch(() => null);
  if (!file || !LOGO_TYPES.has(file.mimeType)) return missing();
  // EmDash sets the caching headers itself. The address in each email carries the image's id, so a new logo is a new address.
  return pluginResponse({ status: 200, headers: { "Content-Type": file.mimeType }, body: { kind: "bytes", value: file.bytes } });
}
