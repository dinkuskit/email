# DinkusKit Store emails

The emails a shopper gets about an order or a cart, for [DinkusKit Commerce](https://github.com/dinkuskit/commerce) stores on [EmDash](https://emdashcms.com), sent from the store's own address.

## Status

First build. Nothing is published to the Registry. Two pieces outside this repository come with it: Commerce's courier news (`order.paid`, `cart.left`, and carrier and tracking on `order.shipped`) and the store template's Cloudflare sender with its cart-email guard. Until both are released, no store sends these emails.

What exists:

- An EmDash Registry plugin, `dinkus-email` ("DinkusKit Store emails"), sandboxed, Block Kit only. It asks for four capabilities and no network host:
  - `email:send` hands each email to the store's own sender, the one picked in EmDash's Settings > Email.
  - `users:read` finds the store's first Administrator, who gets the emails of TEST orders.
  - `media:read` lists the store's Media images for the email logo, and `media:bytes:read` lets the public `logo` route serve the one picked.
- **Order confirmation.** One per paid order, about a minute after payment: order number, items with their options, subtotal, discount, shipping, total, the ship-to address and a "View your order" button to the store's `/track-order` page. Always on, as on Shopify.
- **Shipping confirmation.** When the owner marks an order Completed, through Ship or by hand: the carrier and tracking number when given, with a "Track your package" button for USPS, UPS, FedEx and DHL. On from install; the owner can turn it off.
- **Abandoned cart email.** Commerce decides a cart was left (10 hours after the shopper gave an email, unpaid, not empty, not on the stop list) and passes it on. The owner picks Off (the default), Shoppers who ticked the box, or All customers. The email carries the cart link and the stop link. Cart emails are marketing, and Cloudflare's sender allows only transactional email, so the page says they need an SMTP sender and links to the Guide.
- **TEST orders** email the store's first Administrator instead of the shopper, marked `[Test]`.
- **The Store emails page** (Administrators): both customer emails and their status, the shipping switch, the cart email choice with its note, whether an email sender is set up and when Commerce's news last arrived, **Email styling** (a logo picked from Media, one button colour, a footer line, and "Email me a sample order"), and **Recent emails** with masked addresses and each result.
- **Sending.** The plugin runs every minute on the site's scheduler and hands up to 10 emails to the sender per run, oldest first. An email is marked sent before it is handed over, so two runs never send it twice, and that mark already drops its content: the address and links go to the sender from memory and are written back only when the sender refuses the email and it waits for another try. A failed hand-over is tried again after 1, 5, 15 and 60 minutes, then given up on. News that arrives more than a day late is not emailed, and an email that could not go out for 3 days is given up on, with or without a sender set up. A cart email the template's Cloudflare guard refuses (`MARKETING_BLOCKED`) is marked "Not sent: cart emails need an SMTP sender" and not tried again.
- **Privacy.** While an email waits, its record holds what it needs. Once settled only the log line stays: the masked address, what it was and the result. Log lines are deleted after 90 days. Every email is simple HTML with inline styles plus a plain-text copy, with no tracking pixels.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `POST admin` | Administrators (`settings:manage`) | The Store emails page. |
| `POST courier/inbox` | The store's courier only; refuses any signed-in caller | Built to the [courier's doors](https://github.com/dinkuskit/courier/blob/main/docs/doors.md). Wants `order.paid`, `order.shipped` and `cart.left` from `dinkus-commerce`, each from its own bookmark. |
| `GET logo` | Public | The logo the owner picked, read from Media each time; 404 when none. |

The news shapes are Commerce's (`order.paid` data: `orderId, number, test, email, name, shipTo, lines[{name, options, quantity, unitPrice}], moreLines, subtotal, discount, shipping, total`; `order.shipped` adds `number, test, carrier, tracking`; `cart.left`: `email, ticked, link, stopLink, lines, moreLines`). An item out of shape is kept as "Not sent" and never emailed.

## Install type

Registry only, sandboxed. Not listed in the Registry yet.

## Develop

Node 24 (`.nvmrc`).

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

`npm test` builds the plugin, packages it the way the Registry does (failing if the backend passes 128 KiB or asks for anything not listed above), and runs the tests against the built bundle.
