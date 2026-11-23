# Agent Contract

This repository owns DinkusKit Store emails: the order confirmation, the
shipping confirmation and the abandoned-cart email for DinkusKit Commerce stores
on EmDash, sent from the store's own email sender. Keep it generic: site copy,
customer data, branding, credentials, and production configuration do not
belong here.

## Direction and decisions

Read the organization [vision](https://github.com/dinkuskit/.github/blob/main/VISION.md)
and [scope and planning](https://github.com/dinkuskit/.github/blob/main/ROADMAP.md).
The decisions this plugin builds are recorded in the GrillTrack ledger of
[dinkuskit/dinkuskit](https://github.com/dinkuskit/dinkuskit): `store-email-sender-20261122`,
`store-emails-plugin-20261122` and `store-email-styling-20261122`. A product,
API or data-model change needs a ledger entry the owner approves before it is
built. Use the installed `emdash-commerce` skill for material product or
architecture questions.

## Running GrillTrack

Run `./scripts/agent-skills` first; it installs the pinned SaariusSkills
skills into ignored `.cursor/skills/`. Only the GrillTrack CLI changes a
`.grilltrack/` directory; never edit it by hand.

In Claude Code cloud sessions `.claude/hooks/session-start.sh` checks Node
against `.nvmrc` and runs `npm ci`, then reports anything missing; read that
report before running project scripts.

## Boundary

- DinkusKit Commerce owns orders, carts, the checkout tick box, the stop list
  and the cart link. Store emails never writes any of them. It hears Commerce's
  news (`order.paid`, `order.shipped`, `cart.left`) only through the store's
  courier, at its private `courier/inbox` route (`src/inbox.ts`), which refuses
  every signed-in caller. Do not read Commerce's data directly or assume
  cross-plugin access ([plugin communication rule](https://github.com/dinkuskit/dinkuskit/blob/main/docs/plugin-communication.md),
  [courier doors](https://github.com/dinkuskit/courier/blob/main/docs/doors.md)).
- A shopper's address goes to the store's own email sender (`ctx.email`) and
  nowhere else. A record keeps what an email needs only while it waits; once
  settled only the log line stays (masked address, label, result), and log
  lines are deleted after 90 days. Never keep a cart link or stop link after
  the email is settled.
- Review request and reminder emails belong to DinkusKit Reviews, not here.
- The cart email must carry its stop link (`/cart/c/...&stop=1`) in both the
  text and HTML parts: the store template's Cloudflare guard finds it by that
  link, and refuses it with an error starting `MARKETING_BLOCKED:`.
- Images live in the store's Media library. The logo is kept by its Media id
  and served to mail apps by the public `logo` route, read from Media each
  time; never copy or hardcode an image.
- Admin screens are Block Kit only. No React admin. Every email is simple HTML
  with inline styles plus a plain-text copy, with no tracking pixels.
- The plugin is Registry-enabled and sandboxed. It asks for a capability, a
  network host or a public route only when a recorded decision needs one;
  `scripts/check-registry-bundle.mjs` fails the build otherwise.

## Develop

Run `npm ci --ignore-scripts`, `npm run typecheck` and `npm test` before
pushing. `npm test` builds the plugin, runs the official Registry packaging
with its 128 KiB per-file limit, then runs the tests against the built bundle.

`.github/workflows/clawsweeper-dispatch.yml` sends non-draft pull requests to
`main` for a ClawSweeper review. It does nothing until the repository variable
`CLAWSWEEPER_SPARK_ENABLED` is `true` and the review runner has enrolled this
repository.

## Gates

Do not publish to npm, list in the EmDash Registry, deploy, merge, or change a
live store without the owner's explicit approval.
