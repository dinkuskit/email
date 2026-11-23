// LOCAL PROOF ONLY (not committed to the template). Store emails' built plugin, sending through EmDash 1.5's own email
// pipeline with the template's Cloudflare sender and guard from main (52f34ef). Only Cloudflare's send_email binding
// is stood in, as in the template's tests/workflows/store-email-pipeline.test.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const delivered = [];
globalThis.__storeEmailEnv = { EMAIL: { async send(message) { delivered.push(message); return { messageId: "m-" + delivered.length }; } } };
registerHooks({
  resolve: (specifier, context, next) => {
    if (specifier.startsWith("virtual:emdash/")) return { url: "data:text/javascript,export default undefined;", shortCircuit: true };
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__storeEmailEnv;", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    const loaded = next(url, context);
    if (!url.includes("/node_modules/emdash/dist/") || !loaded.source) return loaded;
    return { ...loaded, source: String(loaded.source).replaceAll("import.meta.env", "({ DEV: false, PROD: true })") };
  },
});
const { EmDashRuntime } = await import("emdash/internal/plugin-test-runtime");
const { createDialect } = await import("emdash/db/sqlite");
const { createPlugin } = await import("./cloudflare-email.ts");
const { default: storeEmails } = await import(process.env.STORE_EMAILS_DIST);
const { courier, store, paid, left } = await import(process.env.STORE_EMAILS_STUB);

test("Store emails through the template's Cloudflare sender: order email delivered, cart email refused and recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "store-emails-cf-"));
  const url = `file:${join(dir, "store.db")}`;
  try {
    const runtime = await EmDashRuntime.create({
      config: { database: { entrypoint: `store-emails-cf-${crypto.randomUUID()}`, type: "sqlite", config: { url } } },
      plugins: [createPlugin({ from: "orders@store.example.test" })],
      createDialect: () => createDialect({ url }), createStorage: null, createScheduler: null, sandboxEnabled: false, sandboxedPluginEntries: [],
    });
    assert.equal(runtime.email.pipeline.getExclusiveSelection("email:deliver"), "cloudflare-email");
    // The plugin's ctx.email is EmDash's real send for plugin dinkus-email; storage and kv are the plugin's test stand-ins.
    const ctx = store();
    ctx.email = { send: message => runtime.email.send(message, "dinkus-email") };
    await ctx.kv.set("state:cart-mode", "all");
    const door = (topic, items) => storeEmails.routes["courier/inbox"].handler(courier({ op: "deliver", from: "dinkus-commerce", topic, items, after: null, next: "1" }), ctx);
    const order = paid(), cart = left();
    await door("order.paid", [order]);
    await door("cart.left", [cart]);
    await storeEmails.hooks.cron.handler({ name: "store-emails" }, ctx);
    await storeEmails.hooks.cron.handler({ name: "store-emails" }, ctx);
    const orderRow = await ctx.storage.emails.get(order.id), cartRow = await ctx.storage.emails.get(cart.id);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].subject, `Order #${order.data.number} confirmed`);
    assert.equal(orderRow.state, "sent");
    assert.equal(cartRow.state, "blocked");
    assert.equal(cartRow.reason, "Not sent: cart emails need an SMTP sender");
    assert.equal(cartRow.tries, 1, "refused once, never tried again");
    assert.equal(cartRow.news, undefined);
    console.log("store emails cloudflare proof", JSON.stringify({
      picked: runtime.email.pipeline.getExclusiveSelection("email:deliver"),
      delivered: delivered.map(m => ({ from: m.from.email, subject: m.subject })),
      rows: [orderRow, cartRow].map(r => ({ label: r.label, masked: r.masked, state: r.state, tries: r.tries, reason: r.reason ?? null, keepsContent: "news" in r })),
    }));
    try { await runtime.db.destroy(); } catch {}
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
