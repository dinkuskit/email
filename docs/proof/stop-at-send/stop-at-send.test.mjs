// LOCAL PROOF ONLY. Store emails and Commerce, both as built Registry bundles in workerd isolates behind one real EmDash
// 1.5 runtime, with a stand-in email sender (cart-email-stop-at-send-20261123). Run from a Commerce checkout that has
// @emdash-cms/sandbox-workerd: COMMERCE_DIR=<commerce> STORE_EMAILS_DIR=<email> node --test <this file>.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

registerHooks({
  resolve: (s, c, n) => s.startsWith("virtual:emdash/") ? { url: "data:text/javascript,export default undefined;", shortCircuit: true } : n(s, c),
  load(url, c, n) { const l = n(url, c); if (!url.includes("/node_modules/emdash/dist/") || !l.source) return l; return { ...l, source: String(l.source).replaceAll("import.meta.env", "({ DEV: false, PROD: true })") }; },
});
const { EmDashRuntime } = await import("emdash/internal/plugin-test-runtime");
const { createDialect } = await import("emdash/db/sqlite");
const { PluginStorageRepository, OptionsRepository, definePlugin } = await import("emdash");
const { createSandboxRunner } = await import("@emdash-cms/sandbox-workerd/sandbox");
const bundle = async dir => ({ ...(await import(join(dir, "dist/sandbox/index.mjs").replace(/^(?!file:)/, "file://"))).default, code: readFileSync(join(dir, "dist/sandbox/plugin.mjs"), "utf8") });
const plain = async dir => ({ ...(await import("file://" + join(dir, "dist/index.mjs"))).default, code: readFileSync(join(dir, "dist/plugin.mjs"), "utf8") });
const commerce = await bundle(process.env.COMMERCE_DIR), storeEmails = await plain(process.env.STORE_EMAILS_DIR);
const sha256 = async t => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, "0")).join("");

test("a cart email waiting for a retry when its shopper stops cart emails is never sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stop-at-send-"));
  const url = `file:${join(dir, "store.db")}`;
  const delivered = [], tries = [];
  // The store's sender: down for the first try, then working.
  const sender = definePlugin({ id: "test-sender", version: "0.0.0", capabilities: ["hooks.email-transport:register"],
    hooks: { "email:deliver": { exclusive: true, handler: async ({ message }) => { tries.push(message.to); if (tries.length === 1) throw Error("sender timed out"); delivered.push(message); } } } });
  const runtime = await EmDashRuntime.create({
    config: { database: { entrypoint: `stop-at-send-${crypto.randomUUID()}`, type: "sqlite", config: { url } } },
    plugins: [sender], createSandboxRunner, sandboxEnabled: true, sandboxedPluginEntries: [commerce, storeEmails],
    createDialect: () => createDialect({ url }), createStorage: null, createScheduler: null,
    siteInfo: { url: "https://store.example.test", name: "Example Store" },
  });
  try {
    await runtime.ensureStorageIndexesSynced();
    const options = new OptionsRepository(runtime.db);
    await options.set("plugin:dinkus-email:state:cart-mode", "all");
    const emails = new PluginStorageRepository(runtime.db, "dinkus-email", "emails", storeEmails.storage.emails.indexes);
    const stops = new PluginStorageRepository(runtime.db, "dinkus-commerce", "cart_email_stops", []);
    const minute = () => runtime.hooks.invokeCronHook("dinkus-email", { name: "store-emails" });
    // The courier hands Store emails one left cart, as Commerce's outbox gives it.
    const link = "https://store.example.test/cart/c/cap_1?key=k1";
    const item = { id: "cart-1:left", at: new Date().toISOString(), data: { email: "ana@buyer.test", ticked: true, link, stopLink: `${link}&stop=1`, lines: [{ name: "Enamel Mug", quantity: 1, options: "" }] } };
    const door = await runtime.handlePluginApiRoute("dinkus-email", "POST", "courier/inbox", new Request("https://store.example.test/", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courier: 1, op: "deliver", from: "dinkus-commerce", topic: "cart.left", items: [item], after: null, next: "1" }) }));
    assert.equal(door.data?.saved, 1, JSON.stringify(door));

    const first = await minute();
    assert.equal(first.success, true, String(first.error));
    const waiting = await emails.get(item.id);
    assert.deepEqual([waiting.state, waiting.reason, tries.length], ["waiting", "Failed, trying again", 1], "the sender was down: it waits for a retry");

    // Ana presses the stop link before the retry (Commerce's stop route keeps the hash of her address).
    await stops.put(await sha256("ana@buyer.test"), { at: String(Math.floor(Date.now() / 1000)) });
    await emails.put(item.id, { ...waiting, nextTry: new Date().toISOString() });
    const second = await minute();
    assert.equal(second.success, true, String(second.error));
    const settled = await emails.get(item.id);
    assert.deepEqual([settled.state, settled.reason, "news" in settled], ["skipped", "Not sent: the shopper stopped cart emails", false]);
    assert.equal(tries.length, 1, "Commerce refused it before the sender was called");
    await minute();
    assert.deepEqual(delivered, [], "never sent");
    console.log("stop at send proof", JSON.stringify({ afterFirstRun: { state: waiting.state, reason: waiting.reason }, afterStop: { state: settled.state, reason: settled.reason, tries: settled.tries, keepsContent: "news" in settled, masked: settled.masked }, senderCalls: tries.length, delivered: delivered.length }));
  } finally {
    await runtime.getSandboxRunner()?.terminateAll();
    try { await runtime.db.destroy(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
