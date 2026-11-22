// A stand-in for the store with the same promises EmDash's plugin context makes: filtered, ordered, paged
// storage queries with range filters, a write that only lands when nobody wrote in between, key-value state,
// the site's users and Media library, and an email sender that records what it is handed.
const inRange = (value, range) =>
  (range.gt === undefined || value > range.gt) && (range.gte === undefined || value >= range.gte) &&
  (range.lt === undefined || value < range.lt) && (range.lte === undefined || value <= range.lte);
const matches = (data, where = {}) => Object.entries(where).every(([key, value]) =>
  value === undefined || (typeof value === "object" && value !== null ? data[key] !== undefined && inRange(data[key], value) : data[key] === value));

function collection() {
  const rows = new Map();
  let clock = 0;
  return {
    rows,
    async get(id) { return rows.get(id)?.data ?? null; },
    async put(id, data) { rows.set(id, { data: structuredClone(data), revision: String(++clock) }); },
    async delete(id) { return rows.delete(id); },
    async count(where) { return [...rows.values()].filter(row => matches(row.data, where)).length; },
    async query({ where, orderBy, limit = 50, cursor } = {}) {
      const all = [...rows.entries()].filter(([, row]) => matches(row.data, where));
      const [[field, direction] = []] = Object.entries(orderBy ?? {});
      if (field) all.sort(([, a], [, b]) => String(a.data[field]).localeCompare(String(b.data[field])) * (direction === "desc" ? -1 : 1));
      const start = cursor ? Number(cursor) : 0;
      const items = all.slice(start, start + limit).map(([id, row]) => ({ id, data: structuredClone(row.data) }));
      const hasMore = start + limit < all.length;
      return { items, hasMore, ...(hasMore ? { cursor: String(start + limit) } : {}) };
    },
    async getVersioned(id) { const row = rows.get(id); return row ? { value: structuredClone(row.data), revision: row.revision } : null; },
    async compareAndSet(id, expected, data) {
      if ((rows.get(id)?.revision ?? null) !== expected) return { applied: false };
      rows.set(id, { data: structuredClone(data), revision: String(++clock) });
      return { applied: true };
    },
  };
}

export const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export function store() {
  const kv = new Map();
  let turn = 0;
  const sent = [], tasks = new Map();
  const media = new Map([
    ["m-logo", { id: "m-logo", filename: "logo.png", mimeType: "image/png", size: 2048, url: "/_emdash/api/media/asset/m-logo/logo.png", createdAt: "2026-11-01T00:00:00Z", alt: "Camp Store" }],
    ["m-big", { id: "m-big", filename: "hero.jpg", mimeType: "image/jpeg", size: 5_000_000, url: "/_emdash/api/media/asset/m-big/hero.jpg", createdAt: "2026-11-02T00:00:00Z" }],
    ["m-svg", { id: "m-svg", filename: "mark.svg", mimeType: "image/svg+xml", size: 900, url: "/_emdash/api/media/asset/m-svg/mark.svg", createdAt: "2026-11-03T00:00:00Z" }],
  ]);
  const users = [
    { id: "u2", email: "helper@example.test", name: "Helper", role: 50, createdAt: "2026-10-02T00:00:00Z" },
    { id: "u1", email: "owner@example.test", name: "Owner", role: 50, createdAt: "2026-10-01T00:00:00Z" },
    { id: "u3", email: "editor@example.test", name: "Editor", role: 40, createdAt: "2026-09-01T00:00:00Z" },
  ];
  const ctx = {
    /** Emails handed to the store's sender, in order. `fail` makes the next sends throw with that message. */
    sent,
    fail: [],
    plugin: { id: "dinkus-email", version: "0.0.0" },
    email: { async send(message) { const failure = ctx.fail.shift(); if (failure) throw new Error(failure); sent.push(message); } },
    site: { name: "Camp Store", url: "https://store.example.test", locale: "en" },
    url: path => `https://store.example.test${path}`,
    log: { warn() {}, info() {}, error() {}, debug() {} },
    tasks,
    cron: {
      async schedule(name, opts) { tasks.set(name, opts.schedule); },
      async cancel(name) { tasks.delete(name); },
      async list() { return [...tasks].map(([name, schedule]) => ({ name, schedule, nextRunAt: "", lastRunAt: null })); },
    },
    users: {
      list: async ({ role } = {}) => ({ items: users.filter(user => role === undefined || user.role >= role) }),
      get: async id => users.find(user => user.id === id) ?? null,
      getByEmail: async email => users.find(user => user.email === email) ?? null,
    },
    userRows: users,
    mediaRows: media,
    media: {
      get: async id => media.get(id) ?? null,
      list: async ({ limit = 50, cursor } = {}) => {
        const all = [...media.values()], start = cursor ? Number(cursor) : 0;
        return { items: all.slice(start, start + limit), hasMore: start + limit < all.length, ...(start + limit < all.length ? { cursor: String(start + limit) } : {}) };
      },
      readBytes: async id => {
        const item = media.get(id);
        if (!item) throw new Error("not found");
        return { bytes: PNG, filename: item.filename, mimeType: item.mimeType, size: PNG.byteLength };
      },
    },
    storage: { emails: collection() },
    kv: {
      async get(key) { return kv.get(key)?.value ?? null; },
      async set(key, value) { kv.set(key, { value, revision: String(++turn) }); },
      async delete(key) { return kv.delete(key); },
      async getVersioned(key) { return kv.get(key) ?? null; },
      async compareAndSet(key, expected, value) {
        if ((kv.get(key)?.revision ?? null) !== expected) return { applied: false };
        kv.set(key, { value, revision: String(++turn) });
        return { applied: true };
      },
    },
  };
  return ctx;
}

export const staff = (input, role = 50, email = "owner@example.test") => ({
  input, ui: { surface: "admin-page", locale: "en", direction: "ltr" },
  user: { id: "u1", email, name: "Owner", role, createdAt: "" },
  request: { url: "", method: "POST", headers: {} },
});

/** The store's courier: a call to a private door from the store's own code, with no signed-in person. */
export const courier = input => ({ input: { courier: 1, ...input }, request: { url: "", method: "POST", headers: {} } });

const usd = minor => ({ currency: "USD", minor });
let n = 0;
/** Commerce's courier news, in the shapes of /mnt/project-files/store-email/commerce-courier-payloads.md. */
export const paid = (data = {}, at = new Date().toISOString()) => {
  n++;
  return { id: `order-${n}:paid`, at, data: {
    orderId: `order-${n}`, number: 1040 + n, test: false, email: `jamie${n}@example.test`, name: "Jamie Rivera",
    shipTo: { name: "Jamie Rivera", line1: "12 Pine Street", city: "Asheville", region: "NC", postalCode: "28801", country: "US" },
    lines: [{ name: "Smoky Mountain Tee", options: "Size: M · Colour: Black", quantity: 2, unitPrice: usd("2400") }, { name: "Enamel Mug", options: "", quantity: 1, unitPrice: usd("1600") }],
    subtotal: usd("6400"), discount: null, shipping: usd("600"), total: usd("7000"), ...data } };
};
export const shipped = (data = {}, at = new Date().toISOString()) => {
  n++;
  return { id: `order-${n}:shipped`, at, data: {
    orderId: `order-${n}`, number: 1040 + n, test: false, shippedAt: at, email: `kim${n}@example.test`, name: "Kim Lee",
    carrier: "USPS", tracking: "9400 1000 0000 0000 0000 00", lines: [{ productId: "tee", productName: "Smoky Mountain Tee" }], ...data } };
};
export const left = (data = {}, at = new Date().toISOString()) => {
  n++;
  const link = `https://store.example.test/cart/c/cap${n}?key=secret${n}`;
  return { id: `cart-${n}:left`, at, data: {
    email: `taylor${n}@example.test`, ticked: true, link, stopLink: `${link}&stop=1`,
    lines: [{ name: "Enamel Mug", quantity: 1, options: "" }], ...data } };
};
