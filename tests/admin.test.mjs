import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/plugin.mjs";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { PNG, courier, paid, staff, store } from "./store.mjs";

const admin = (ctx, input, role, email) => plugin.routes.admin.handler(staff(input, role, email), ctx);
const load = ctx => admin(ctx, { type: "page_load" });
const click = (ctx, action_id, value) => admin(ctx, { type: "block_action", action_id, ...(value === undefined ? {} : { value }) });
const submit = (ctx, action_id, values) => admin(ctx, { type: "form_submit", action_id, values });
const texts = response => JSON.stringify(response.blocks);
const valid = response => {
  const result = validateBlockResponse(response);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  return response;
};
const deliver = (ctx, items) => plugin.routes["courier/inbox"].handler(courier({ op: "deliver", from: "dinkus-commerce", topic: "order.paid", items, after: null, next: "1" }), ctx);

test("the Store emails page lists every customer email, the cart choice and its note, the sender, styling and recent emails", async () => {
  const ctx = store();
  const page = valid(await load(ctx));
  const words = texts(page);
  for (const expected of ["Store emails", "Order confirmation", "On, always", "Shipping confirmation", "Abandoned cart email",
    "Shoppers who ticked the box", "All customers", "Cart emails are marketing, so they need an SMTP sender.", "How to switch to SMTP",
    "https://dinkuskit.com/docs/store-owners/email-sender/", "How your emails are sent", "Settings > Email", "Email styling",
    "Button colour", "#2f5d3a", "Questions? Reply to this email.", "Email me a sample order", "Recent emails"]) {
    assert.ok(words.includes(expected), expected);
  }
  const cart = page.blocks.find(block => block.block_id === "cart");
  assert.equal(cart.fields[0].initial_value, "off", "cart emails start Off");
  assert.match(words, /Order news from Commerce does not reach Store emails yet/);
  assert.equal(ctx.tasks.get("store-emails"), "* * * * *", "opening the page puts the minute run back when it is missing");
});

test("only Administrators can open it", async () => {
  const ctx = store();
  const page = await admin(ctx, { type: "page_load" }, 40);
  assert.match(texts(page), /Store emails is for Administrators/);
});

test("the page says when no email sender is set up", async () => {
  const ctx = store();
  ctx.email = undefined;
  assert.match(texts(valid(await load(ctx))), /No email sender is set up/);
});

test("the page says when Commerce's news last arrived, and shows recent emails with masked addresses", async () => {
  const ctx = store();
  await plugin.routes["courier/inbox"].handler(courier({ op: "wants" }), ctx);
  const item = paid();
  await deliver(ctx, [item]);
  await plugin.hooks.cron.handler({ name: "store-emails" }, ctx);
  const words = texts(valid(await load(ctx)));
  assert.match(words, /Order news from Commerce last arrived/);
  assert.match(words, new RegExp(`Order #${item.data.number} confirmed`));
  assert.match(words, /j••••@example\.test/);
  assert.match(words, /🟢 Sent/);
  assert.equal(words.includes(item.data.email), false, "never a whole address on the page");
});

test("the owner saves the shipping switch, the cart choice and the styling", async () => {
  const ctx = store();
  valid(await submit(ctx, "save_shipping", { shippingOn: false }));
  assert.equal(await ctx.kv.get("state:shipping-on"), false);
  valid(await submit(ctx, "save_cart", { cartMode: "ticked" }));
  assert.equal(await ctx.kv.get("state:cart-mode"), "ticked");
  const refused = valid(await submit(ctx, "save_cart", { cartMode: "everyone" }));
  assert.equal(refused.toast.type, "error");
  assert.equal(await ctx.kv.get("state:cart-mode"), "ticked");

  valid(await submit(ctx, "save_styling", { colour: "#AA3300", footer: "Thanks for shopping local." }));
  assert.deepEqual(await ctx.kv.get("state:styling"), { logo: null, colour: "#aa3300", footer: "Thanks for shopping local." });
  for (const colour of ["red", "#abc", "#12345g"]) {
    const answer = valid(await submit(ctx, "save_styling", { colour, footer: "x" }));
    assert.equal(answer.toast.type, "error", colour);
  }
  const long = valid(await submit(ctx, "save_styling", { colour: "#000000", footer: "x".repeat(201) }));
  assert.equal(long.toast.type, "error");
  assert.equal((await ctx.kv.get("state:styling")).colour, "#aa3300");
});

test("the logo is picked from the store's Media library, and only a PNG, JPEG, GIF or WebP up to 1 MB can be picked", async () => {
  const ctx = store();
  const library = valid(await click(ctx, "logo.pick"));
  const words = texts(library);
  assert.match(words, /Use logo\.png/);
  assert.match(words, /hero\.jpg cannot be an email logo/);
  assert.match(words, /mark\.svg cannot be an email logo/);
  valid(await click(ctx, "logo.use", "m-logo"));
  assert.equal((await ctx.kv.get("state:styling")).logo, "m-logo");
  assert.match(texts(await load(ctx)), /\/_emdash\/api\/media\/asset\/m-logo\/logo\.png/, "the page previews it from Media");
  const svg = valid(await click(ctx, "logo.use", "m-svg"));
  assert.equal(svg.toast.type, "error");
  assert.equal((await ctx.kv.get("state:styling")).logo, "m-logo");
  valid(await click(ctx, "logo.remove"));
  assert.equal((await ctx.kv.get("state:styling")).logo, null);
});

test("the public logo route serves only the image picked, and emails load it from there", async () => {
  const ctx = store();
  const none = await plugin.routes.logo.handler({ input: undefined, request: { url: "", method: "GET", headers: {} } }, ctx);
  assert.equal(none.status, 404);
  await click(ctx, "logo.use", "m-logo");
  const served = await plugin.routes.logo.handler({ input: undefined, request: { url: "", method: "GET", headers: {} } }, ctx);
  assert.equal(served.status, 200);
  assert.deepEqual(served.body.value, PNG);
  assert.equal(new Headers(served.headers).get("content-type"), "image/png");
  // Deleted from Media: no logo is served, and the page says emails show the store's name.
  ctx.mediaRows.delete("m-logo");
  assert.equal((await plugin.routes.logo.handler({ input: undefined, request: { url: "", method: "GET", headers: {} } }, ctx)).status, 404);
  assert.match(texts(await load(ctx)), /no longer in Media/);
});

test("emails show the picked logo, the button colour and the footer line", async () => {
  const ctx = store();
  await click(ctx, "logo.use", "m-logo");
  await submit(ctx, "save_styling", { colour: "#aa3300", footer: "Thanks for shopping local." });
  await deliver(ctx, [paid()]);
  await plugin.hooks.cron.handler({ name: "store-emails" }, ctx);
  const [email] = ctx.sent;
  assert.match(email.html, /<img src="https:\/\/store\.example\.test\/_emdash\/api\/plugins\/dinkus-email\/logo\?v=m-logo"/);
  assert.match(email.html, /background:#aa3300/);
  assert.match(email.html, /Thanks for shopping local\./);
  assert.match(email.text, /Thanks for shopping local\./);
});

test("'Email me a sample order' sends a sample order confirmation to the signed-in Administrator", async () => {
  const ctx = store();
  const answer = valid(await click(ctx, "sample"));
  assert.equal(answer.toast.type, "success");
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].to, "owner@example.test");
  assert.match(ctx.sent[0].subject, /^\[Sample\] Order #1001 confirmed$/);
  assert.match(ctx.sent[0].text, /2 × Sample T-shirt/);
  ctx.email = undefined;
  assert.equal(valid(await click(ctx, "sample")).toast.type, "error");
});
