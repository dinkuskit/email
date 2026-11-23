**Where do the emails come from?**

From the sender you pick in Settings > Email, using your store's own address. DinkusKit never sends them for you.

**Why don't my abandoned cart emails go out?**

They are marketing, and Cloudflare's sender allows only transactional email. Pick an SMTP sender in Settings > Email. Until then the Store emails page marks them "Not sent: cart emails need an SMTP sender".

**What happens when a shopper presses "Stop these emails"?**

Commerce keeps that address on its stop list. No more cart emails go to it, including one already waiting to be sent. Order and shipping emails still go.

**Does it track opens or clicks?**

No. The emails carry no tracking pixels and no tracked links.

**How long are email records kept?**

Each email's address and links are dropped once it is settled. A masked log line stays for 90 days.

**Where can I learn more or contribute?**

[Browse the source](https://github.com/dinkuskit/email) or [report an issue](https://github.com/dinkuskit/email/issues).
