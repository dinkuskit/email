import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import { storeEmailsAdmin } from "./admin.js";
import { sendDue } from "./emails.js";
import { courierInbox } from "./inbox.js";
import { logo } from "./logo.js";

/** Every minute: about a minute after Commerce's news arrives, the email goes out. */
export const SEND_TASK = "store-emails";
export const SEND_SCHEDULE = "* * * * *";

/**
 * Makes sure the minute run is on the site's scheduler. Switching the plugin on always writes it; opening
 * the Store emails page writes it only when it is missing. Never throws: the page must open if the scheduler is down.
 */
export async function ensureSendTask(ctx: PluginContext, activate = false): Promise<void> {
  const cron = ctx.cron;
  if (!cron) return;
  try {
    if (!activate && (await cron.list()).some(task => task.name === SEND_TASK && task.schedule === SEND_SCHEDULE)) return;
    await cron.schedule(SEND_TASK, { schedule: SEND_SCHEDULE });
  } catch {
    ctx.log.warn("The Store emails run is not scheduled yet; opening Store emails tries again");
  }
}

/**
 * DinkusKit Store emails: the order confirmation, the shipping confirmation and the abandoned-cart email,
 * sent from the store's own sender (store-emails-plugin-20261122). Commerce's news reaches it through the
 * store's courier; the owner sees and steers every email on one page.
 */
const plugin: SandboxedPlugin = {
  hooks: {
    "plugin:activate": async (_event, ctx) => {
      await ensureSendTask(ctx, true);
    },
    // Up to 10 emails handed to the store's sender in one run, which outlasts EmDash's default 5 seconds.
    cron: { timeout: 25_000, handler: async (event, ctx) => {
      if (event.name === SEND_TASK) await sendDue(ctx);
    } },
  },
  routes: {
    // Administrators only, like Shopify's notification settings.
    admin: { public: false, permission: "settings:manage", methods: ["POST"], handler: async (route, ctx) => {
      if ((route.input as { type?: unknown } | null)?.type === "page_load") await ensureSendTask(ctx);
      return storeEmailsAdmin(route, ctx);
    } },
    // The store's courier only (plugin-communication-rule-20261122): private, and it refuses any signed-in caller.
    "courier/inbox": { public: false, permission: "plugins:manage", methods: ["POST"], handler: courierInbox },
    // The email logo, for shoppers' mail apps (store-email-styling-20261122). Serves only the image the owner picked.
    logo: { public: true, methods: ["GET"], response: "raw", request: { body: "none" }, handler: logo },
  },
};

export default plugin;
