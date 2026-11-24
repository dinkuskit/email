# Proof: the Sales tax row

`order-confirmation-sales-tax.jpg` is the order confirmation for a Nashville order taxed at 9.75%. It shows:

- a $64.00 subtotal;
- a $6.40 discount;
- $6.00 shipping;
- $6.21 sales tax: $5.62 on the $57.60 after the discount, plus $0.59 on shipping, each rounded half up;
- a total of $69.81.

It is the template rendered by `src/render.ts`, captured with Playwright.

An untaxed order, or Commerce news with `tax: null` or no `tax` at all, shows no Sales tax row (`tests/emails.test.mjs`).
