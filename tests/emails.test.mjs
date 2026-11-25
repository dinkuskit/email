import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/plugin.mjs";
import { courier, left, paid, shipped, store } from "./store.mjs";

const door = plugin.routes["courier/inbox"];
const call = (ctx, input) => door.handler(courier(input), ctx);
const deliver = (ctx, topic, items, after = null, next = "1") => call(ctx, { op: "deliver", from: "dinkus-commerce", topic, items, after, next });
const run = ctx => plugin.hooks.cron.handler({ name: "store-emails" }, ctx);
const row = (ctx, id) => ctx.storage.emails.get(id);
const refused = async (promise, code) => assert.rejects(promise, error => error.name === "PluginRouteError" && error.code === code, code);
const MINUTE = 60_000;
/** Moves a waiting email's next try to now, as if its wait were over. */
const due = async (ctx, id) => { const r = await row(ctx, id); await ctx.storage.emails.put(id, { ...r, nextTry: new Date().toISOString() }); };

test("the inbox wants all three of Commerce's topics, each from its own bookmark", async () => {
  const ctx = store();
  const { wants } = await call(ctx, { op: "wants" });
  assert.deepEqual(wants.map(want => [want.from, want.topic, want.after, want.limit]), [
    ["dinkus-commerce", "order.paid", null, 50], ["dinkus-commerce", "order.shipped", null, 50], ["dinkus-commerce", "cart.left", null, 50]]);
  assert.deepEqual(await deliver(ctx, "order.paid", [paid()], null, "b1"), { courier: 1, saved: 1, moved: true });
  const again = await call(ctx, { op: "wants" });
  assert.equal(again.wants[0].after, "b1");
  assert.equal(again.wants[1].after, null);
});

test("the inbox refuses signed-in callers, other senders and unknown topics", async () => {
  const ctx = store();
  await refused(door.handler({ ...courier({ op: "wants" }), user: { id: "u1", role: 50 } }, ctx), "COURIER_ONLY");
  await refused(call(ctx, { op: "since" }), "BAD_COURIER_REQUEST");
  await refused(call(ctx, { op: "deliver", from: "dinkus-reviews", topic: "order.paid", items: [] }), "UNWANTED_TOPIC");
  await refused(call(ctx, { op: "deliver", from: "dinkus-commerce", topic: "order.refunded", items: [] }), "UNWANTED_TOPIC");
  await refused(deliver(ctx, "order.paid", Array.from({ length: 101 }, () => paid())), "BAD_COURIER_REQUEST");
});

test("a repeated delivery never sends a second email, and an older run never moves the bookmark back", async () => {
  const ctx = store();
  const item = paid();
  await deliver(ctx, "order.paid", [item], null, "b1");
  assert.deepEqual(await deliver(ctx, "order.paid", [item], null, "b1"), { courier: 1, saved: 0, moved: false });
  await run(ctx);
  await deliver(ctx, "order.paid", [item], "b1", "b2");
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
});

test("an order confirmation goes to the shopper about a minute after payment, then only its log line stays", async () => {
  const ctx = store();
  const item = paid();
  await deliver(ctx, "order.paid", [item]);
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
  const [email] = ctx.sent;
  assert.equal(email.to, item.data.email);
  assert.equal(email.subject, `Order #${item.data.number} confirmed`);
  for (const part of [email.text, email.html]) {
    assert.match(part, /Thank you for your order!/);
    assert.match(part, /2 × Smoky Mountain Tee \(Size: M · Colour: Black\)/);
    assert.match(part, /\$48\.00/);
    assert.match(part, /\$70\.00 USD/);
    assert.match(part, /12 Pine Street/);
    assert.match(part, /https:\/\/store\.example\.test\/track-order/);
    assert.match(part, /Questions\? Reply to this email\./);
  }
  assert.doesNotMatch(email.html, /<img/, "no logo picked and no tracking pixel");
  const kept = await row(ctx, item.id);
  assert.equal(kept.state, "sent");
  assert.equal(kept.masked, "j••••@example.test");
  assert.equal(kept.news, undefined, "the address and items are dropped once sent");
  assert.equal(JSON.stringify(kept).includes(item.data.email), false);
});

test("a taxed order's confirmation shows its Sales tax row; an untaxed one shows none", async () => {
  const ctx = store();
  const usd = minor => ({ currency: "USD", minor });
  const taxed = paid({ tax: usd("683"), total: usd("7683") }), untaxed = paid({ tax: null }), older = paid();
  await deliver(ctx, "order.paid", [taxed, untaxed, older]);
  await run(ctx);
  assert.equal(ctx.sent.length, 3);
  for (const part of [ctx.sent[0].text, ctx.sent[0].html]) {
    assert.match(part, /Sales tax/);
    assert.match(part, /\$6\.83/);
    assert.match(part, /\$76\.83 USD/);
  }
  assert.match(ctx.sent[0].text, /Shipping: \$6\.00\nSales tax: \$6\.83\nTotal: \$76\.83 USD/);
  for (const email of ctx.sent.slice(1)) assert.doesNotMatch(email.text + email.html, /Sales tax/);
  // A tax that does not read as money is news out of shape: kept as not sent, never emailed with a wrong total.
  const ctx2 = store();
  const bad = paid({ tax: { currency: "USD", minor: "6.83" } });
  await deliver(ctx2, "order.paid", [bad]);
  await run(ctx2);
  assert.equal(ctx2.sent.length, 0);
});

test("a TEST order's emails go to the store's first Administrator, marked as a test", async () => {
  const ctx = store();
  const order = paid({ test: true }), ship = shipped({ test: true });
  await deliver(ctx, "order.paid", [order]);
  await deliver(ctx, "order.shipped", [ship]);
  await run(ctx);
  assert.deepEqual(ctx.sent.map(email => email.to), ["owner@example.test", "owner@example.test"]);
  assert.ok(ctx.sent.every(email => email.subject.startsWith("[Test] ") && /TEST order/.test(email.text)));
  assert.equal((await row(ctx, order.id)).masked, "You (test order)");
});

test("a TEST order is not sent when the store has no Administrator with an address", async () => {
  const ctx = store();
  ctx.userRows.length = 0;
  const order = paid({ test: true });
  await deliver(ctx, "order.paid", [order]);
  await run(ctx);
  assert.equal(ctx.sent.length, 0);
  assert.equal((await row(ctx, order.id)).reason, "Not sent: no Administrator address for a test order");
});

test("a shipping confirmation carries the carrier, the tracking number and the carrier's tracking link", async () => {
  const ctx = store();
  const item = shipped();
  await deliver(ctx, "order.shipped", [item]);
  await run(ctx);
  const [email] = ctx.sent;
  assert.equal(email.subject, `Order #${item.data.number} is on its way`);
  assert.match(email.text, /Carrier: USPS/);
  assert.match(email.text, /Tracking number: 9400 1000/);
  assert.match(email.text, /tools\.usps\.com\/go\/TrackConfirmAction\?tLabels=9400100000000000000000(\s|$)/m, "the tracking link drops the spaces a label prints");
  assert.match(email.html, /Track your package/);
  assert.match(email.text, /^Smoky Mountain Tee$/m, "a shipped line without a quantity shows none");
});

test("a shipped line that carries its quantity shows it, and dropped lines are counted", async () => {
  const ctx = store();
  await deliver(ctx, "order.shipped", [shipped({ lines: [{ productId: "tee", productName: "Smoky Mountain Tee", quantity: 2 }], moreLines: 1 })]);
  await run(ctx);
  assert.match(ctx.sent[0].text, /^2 × Smoky Mountain Tee$/m);
  assert.match(ctx.sent[0].text, /^and 1 more item$/m, "lines Commerce dropped to stay under 8 KB are counted");
});

test("a shipping confirmation without a known carrier links to the order lookup page", async () => {
  const ctx = store();
  await deliver(ctx, "order.shipped", [shipped({ carrier: "Local courier", tracking: null })]);
  await deliver(ctx, "order.shipped", [shipped({ carrier: null, tracking: null })], "1", "2");
  await run(ctx);
  assert.equal(ctx.sent.length, 2);
  assert.match(ctx.sent[0].text, /Carrier: Local courier/);
  assert.match(ctx.sent[0].text, /View your order: https:\/\/store\.example\.test\/track-order/);
  assert.doesNotMatch(ctx.sent[1].text, /Carrier|Tracking number/);
});

test("shipping confirmations can be turned off; order confirmations cannot", async () => {
  const ctx = store();
  await ctx.kv.set("state:shipping-on", false);
  const ship = shipped(), order = paid();
  await deliver(ctx, "order.shipped", [ship]);
  await deliver(ctx, "order.paid", [order]);
  await run(ctx);
  assert.deepEqual(ctx.sent.map(email => email.to), [order.data.email]);
  assert.equal((await row(ctx, ship.id)).reason, "Not sent: shipping confirmations are off");
});

test("cart emails start Off, then follow the owner's choice of ticked or all", async () => {
  const ctx = store();
  const first = left();
  await deliver(ctx, "cart.left", [first]);
  await run(ctx);
  assert.equal(ctx.sent.length, 0);
  assert.equal((await row(ctx, first.id)).reason, "Not sent: cart emails are off");

  await ctx.kv.set("state:cart-mode", "ticked");
  const ticked = left(), unticked = left({ ticked: false });
  await deliver(ctx, "cart.left", [ticked, unticked], "1", "2");
  await run(ctx);
  assert.deepEqual(ctx.sent.map(email => email.to), [ticked.data.email]);
  assert.equal((await row(ctx, unticked.id)).reason, "Not sent: the shopper did not tick the box");

  await ctx.kv.set("state:cart-mode", "all");
  const anyone = left({ ticked: false });
  await deliver(ctx, "cart.left", [anyone], "2", "3");
  await run(ctx);
  assert.equal(ctx.sent.at(-1).to, anyone.data.email);
});

test("a cart email carries the cart link and the stop link in both parts, and keeps neither once sent", async () => {
  const ctx = store();
  await ctx.kv.set("state:cart-mode", "all");
  const item = left({ lines: [{ name: "Enamel Mug", quantity: 1, options: "" }], moreLines: 3 });
  await deliver(ctx, "cart.left", [item]);
  await run(ctx);
  const [email] = ctx.sent;
  assert.equal(email.subject, "You left something in your cart at Camp Store");
  for (const part of [email.text, email.html.replaceAll("&#38;", "&")]) {
    assert.ok(part.includes(item.data.link));
    assert.ok(part.includes(item.data.stopLink), "the template's guard finds /cart/c/ with stop=1");
    assert.match(part, /and 3 more items/);
  }
  const kept = JSON.stringify(await row(ctx, item.id));
  assert.equal(kept.includes("/cart/c/"), false);
  assert.equal(kept.includes(item.data.email), false);
});

test("a cart link that is not the store's own cart link is never emailed", async () => {
  const ctx = store();
  await ctx.kv.set("state:cart-mode", "all");
  const link = "https://elsewhere.example.test/cart/c/x?key=y";
  const item = left({ link, stopLink: `${link}&stop=1` });
  await deliver(ctx, "cart.left", [item]);
  await run(ctx);
  assert.equal(ctx.sent.length, 0);
  assert.equal((await row(ctx, item.id)).reason, "Not sent: the order news was out of shape");
});

test("a cart email the template's Cloudflare guard refuses is marked and not tried again", async () => {
  const ctx = store();
  await ctx.kv.set("state:cart-mode", "all");
  const item = left();
  await deliver(ctx, "cart.left", [item]);
  ctx.fail.push("MARKETING_BLOCKED: Cloudflare's sender does not allow marketing email");
  await run(ctx);
  const kept = await row(ctx, item.id);
  assert.equal(kept.state, "blocked");
  assert.equal(kept.reason, "Not sent: cart emails need an SMTP sender");
  await due(ctx, item.id).catch(() => {});
  await run(ctx);
  assert.equal(ctx.sent.length, 0);
});

test("a failed hand-over is tried again after 1, 5, 15 and 60 minutes, then given up on", async () => {
  const ctx = store();
  const item = paid();
  await deliver(ctx, "order.paid", [item]);
  ctx.fail.push("smtp down", "smtp down", "smtp down", "smtp down", "smtp down");
  const waits = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const before = Date.now();
    await run(ctx);
    const kept = await row(ctx, item.id);
    if (attempt < 5) {
      assert.equal(kept.state, "waiting");
      assert.equal(kept.reason, "Failed, trying again");
      assert.equal(kept.tries, attempt);
      assert.ok(kept.news, "it keeps what it needs to try again");
      waits.push(Math.round((Date.parse(kept.nextTry) - before) / MINUTE));
      await run(ctx);
      assert.equal((await row(ctx, item.id)).tries, attempt, "not tried before its wait is over");
      await due(ctx, item.id);
    } else {
      assert.equal(kept.state, "failed");
      assert.equal(kept.news, undefined);
    }
  }
  assert.deepEqual(waits, [1, 5, 15, 60]);
  assert.equal(ctx.sent.length, 0);
});

test("news that arrives more than a day late is not emailed", async () => {
  const ctx = store();
  const item = paid({}, new Date(Date.now() - 25 * 60 * MINUTE).toISOString());
  await deliver(ctx, "order.paid", [item]);
  await run(ctx);
  assert.equal(ctx.sent.length, 0);
  assert.equal((await row(ctx, item.id)).reason, "Not sent: the news arrived more than a day late");
});

test("an order without an email address, or news out of shape, is kept as not sent", async () => {
  const ctx = store();
  const none = paid({ email: null }), broken = paid({ total: { currency: "USD", minor: "70.00" } }), noLines = shipped({ lines: [] });
  await deliver(ctx, "order.paid", [none, broken]);
  await deliver(ctx, "order.shipped", [noLines]);
  await run(ctx);
  assert.equal(ctx.sent.length, 0);
  assert.equal((await row(ctx, none.id)).reason, "Not sent: the order has no email address");
  assert.equal((await row(ctx, broken.id)).reason, "Not sent: the order news was out of shape");
  assert.equal((await row(ctx, noLines.id)).reason, "Not sent: the order news was out of shape");
});

test("with no email sender nothing is sent and nothing is lost", async () => {
  const ctx = store();
  const sender = ctx.email;
  ctx.email = undefined;
  const item = paid();
  await deliver(ctx, "order.paid", [item]);
  await run(ctx);
  assert.equal((await row(ctx, item.id)).state, "waiting");
  assert.equal(await ctx.kv.get("state:no-sender"), true);
  ctx.email = sender;
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
  assert.equal(await ctx.kv.get("state:no-sender"), false);
});

test("an email that waited 3 days is given up on, and its content dropped, with or without a sender", async () => {
  for (const sender of [true, false]) {
    for (const site of [true, false]) {
      const ctx = store();
      const item = paid();
      await deliver(ctx, "order.paid", [item]);
      const kept = await row(ctx, item.id);
      await ctx.storage.emails.put(item.id, { ...kept, receivedAt: new Date(Date.now() - 4 * 24 * 60 * MINUTE).toISOString() });
      if (!sender) ctx.email = undefined;
      if (!site) ctx.url = path => path;
      await run(ctx);
      const label = `sender ${sender}, site address ${site}`;
      assert.equal(ctx.sent.length, 0, label);
      const after = await row(ctx, item.id);
      assert.equal(after.reason, "Not sent: it could not go out for 3 days", label);
      assert.equal(after.news, undefined, label);
    }
  }
});

test("without a sender, an email the owner's choices no longer want is settled and its content dropped", async () => {
  const ctx = store();
  ctx.email = undefined;
  const item = left();
  await deliver(ctx, "cart.left", [item]);
  await run(ctx);
  const after = await row(ctx, item.id);
  assert.equal(after.reason, "Not sent: cart emails are off");
  assert.equal(after.news, undefined);
});

test("an email is marked sent with its content already dropped before the sender gets it", async () => {
  const ctx = store();
  const item = left();
  await ctx.kv.set("state:cart-mode", "ticked");
  await deliver(ctx, "cart.left", [item]);
  let during;
  const send = ctx.email.send;
  ctx.email.send = async message => { during = await row(ctx, item.id); return send(message); };
  await run(ctx);
  // A run stopped here, mid-send, leaves only the log line: no address, no cart link, and it is never sent again.
  assert.equal(during.state, "sent");
  assert.equal(during.news, undefined);
  assert.doesNotMatch(JSON.stringify(during), /example\.test\/cart|taylor/);
  assert.match(ctx.sent[0].text, /cart\/c\/cap/, "the email itself still carries the link");
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
});

test("a refused hand-over gets its content back for the next try, and the retry sends the same email", async () => {
  const ctx = store();
  const item = paid();
  await deliver(ctx, "order.paid", [item]);
  ctx.fail.push("timeout");
  await run(ctx);
  const waiting = await row(ctx, item.id);
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.news.email, item.data.email);
  await due(ctx, item.id);
  await run(ctx);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].to, item.data.email);
  assert.match(ctx.sent[0].text, /Smoky Mountain Tee/);
  assert.equal((await row(ctx, item.id)).news, undefined);
});

test("one run hands over at most 10 emails, oldest first; the next run sends the rest", async () => {
  const ctx = store();
  const items = Array.from({ length: 12 }, () => paid());
  await deliver(ctx, "order.paid", items);
  await run(ctx);
  assert.equal(ctx.sent.length, 10);
  await run(ctx);
  assert.equal(ctx.sent.length, 12);
});

test("log lines older than 90 days are deleted", async () => {
  const ctx = store();
  await ctx.storage.emails.put("old:paid", { kind: "order", state: "sent", at: "2026-01-01T00:00:00Z", receivedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", label: "Order #1 confirmed", masked: "a••••@x.test", tries: 1 });
  const item = paid();
  await deliver(ctx, "order.paid", [item]);
  await run(ctx);
  assert.equal(await row(ctx, "old:paid"), null);
  assert.ok(await row(ctx, item.id));
});

test("switching the plugin on schedules the minute run", async () => {
  const ctx = store();
  await plugin.hooks["plugin:activate"]({}, ctx);
  assert.equal(ctx.tasks.get("store-emails"), "* * * * *");
});

test("the items Commerce's outbox gives on main are taken and emailed as they are", async () => {
  // Copied from dinkuskit/commerce proof/store-emails-news-20261122/outbox-proof.log (main 37c9336), times made current
  // and the redacted cart link filled in with this store's.
  const ctx = store(), at = new Date().toISOString(), link = "https://store.example.test/cart/c/cap9?key=secret9";
  await ctx.kv.set("state:cart-mode", "ticked");
  await deliver(ctx, "order.paid", [{ id: "order-5:paid", at, data: { orderId: "order-5", number: 1005, test: false, email: "ana@buyer.test", name: "Ana Buyer",
    shipTo: { name: "Ana Buyer", line1: "1 Example Way", city: "Testville", postalCode: "00000", country: "US" },
    lines: [{ name: "Smoky Mountain Tee", options: "Size: M", quantity: 2, unitPrice: { currency: "USD", minor: "2400" } }],
    subtotal: { currency: "USD", minor: "4800" }, discount: null, shipping: { currency: "USD", minor: "600" }, total: { currency: "USD", minor: "5400" } } }]);
  await deliver(ctx, "order.shipped", [{ id: "order-1:shipped", at, data: { orderId: "order-1", number: 1001, test: false, shippedAt: at, email: "ana@buyer.test", name: "Ana Buyer",
    carrier: null, tracking: null, lines: [{ productId: "mug", productName: "Mug", quantity: 1 }, { productId: "hat", productName: "Hat", quantity: 1 }] } }]);
  await deliver(ctx, "cart.left", [{ id: "cap9:left", at, data: { email: "Cart-Shopper@Example.test", ticked: true, link, stopLink: `${link}&stop=1`,
    lines: [{ name: "hat", quantity: 1, options: "" }] } }]);
  await run(ctx);
  assert.deepEqual(ctx.sent.map(email => [email.to, email.subject]), [
    ["ana@buyer.test", "Order #1005 confirmed"], ["ana@buyer.test", "Order #1001 is on its way"],
    ["Cart-Shopper@Example.test", "You left something in your cart at Camp Store"]]);
  assert.match(ctx.sent[0].text, /2 × Smoky Mountain Tee \(Size: M\)  \$48\.00/);
  assert.match(ctx.sent[0].text, /Total: \$54\.00 USD/);
  assert.match(ctx.sent[1].text, /^1 × Mug$/m);
  assert.match(ctx.sent[1].text, /View your order: https:\/\/store\.example\.test\/track-order/, "no carrier given: no tracking link");
});

test("a cart email Commerce refuses because the shopper stopped cart emails is not sent and never tried again", async () => {
  // Stopped after the news arrived, then once more while its retry waited: Commerce's send-time check refuses both times.
  const ctx = store();
  await ctx.kv.set("state:cart-mode", "all");
  const first = left(), second = left({ email: "bo@buyer.test" });
  await deliver(ctx, "cart.left", [first, second]);
  ctx.fail.push("Plugin dinkus-commerce:0.9.0 hook email:beforeSend failed: CART_EMAIL_STOPPED: This shopper stopped cart emails.", "timeout");
  await run(ctx);
  const stopped = await row(ctx, first.id);
  assert.deepEqual([stopped.state, stopped.reason, stopped.tries, "news" in stopped], ["skipped", "Not sent: the shopper stopped cart emails", 1, false]);
  assert.equal((await row(ctx, second.id)).state, "waiting");
  await due(ctx, second.id);
  ctx.fail.push("Plugin dinkus-commerce:0.9.0 hook email:beforeSend failed: CART_EMAIL_STOPPED: This shopper stopped cart emails.");
  await run(ctx);
  const retried = await row(ctx, second.id);
  assert.deepEqual([retried.state, retried.reason, retried.tries, "news" in retried], ["skipped", "Not sent: the shopper stopped cart emails", 2, false]);
  await due(ctx, first.id).catch(() => {});
  await run(ctx);
  assert.equal(ctx.sent.length, 0, "neither was ever sent");
  assert.equal((await row(ctx, first.id)).state, "skipped");
});
