// Vercel serverless function: POST /api/request
// Handles two kinds of requests and opens a Stripe Checkout page for the deposit:
//   1. A custom piece request (deposit by type of piece)
//   2. A reservation of an in-stock watch (watch deposit)
// Amounts and watch details come from custom.json on the server, never from the browser.
// Request details are saved on the Stripe payment (Dashboard > Payments > the payment > Metadata).
const Stripe = require("stripe");
const cfg = require("../custom.json");

const clean = (v, max) =>
  String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, max);

const cad = (n) => "$" + Number(n).toLocaleString("en-CA") + " CAD";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "Payments are not set up yet. Add STRIPE_SECRET_KEY in Vercel." });
  }

  try {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const s = cfg.settings;

    // Bots fill the hidden field; humans never see it.
    if (clean(b.website, 50)) return res.status(400).json({ error: "Request could not be sent." });

    const name = clean(b.name, 80);
    const email = clean(b.email, 120);
    const phone = clean(b.phone, 30);
    const reference = clean(b.reference, 300);
    const neededBy = clean(b.neededBy, 10);
    const description = clean(b.description, 1000);

    if (name.length < 2) return res.status(400).json({ error: "Enter your name." });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (neededBy && !/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) return res.status(400).json({ error: "Enter a valid date." });
    if (reference && !/^https?:\/\/\S+$/i.test(reference)) return res.status(400).json({ error: "The reference link must start with http:// or https://" });
    if (b.consent !== true) return res.status(400).json({ error: "Please tick the box to confirm the deposit terms." });

    const watchId = Number(b.watchId) || 0;
    let watch = null;
    let meta, lineName, lineDesc, amountCents, note, payDesc;

    if (watchId) {
      // ---- Watch reservation ----
      watch = (cfg.watches || []).find((w) => w.id === watchId);
      if (!watch || watch.sold) return res.status(400).json({ error: "Sorry, that watch is no longer available." });
      const title = `${watch.name} ${watch.ref} (${watch.condition})`;
      amountCents = Math.round(s.watchDeposit * 100);
      lineName = `Watch reservation deposit: ${watch.name} ${watch.ref}`;
      lineDesc = `Credited toward the purchase price (listed at ${cad(watch.price)}).`;
      note = s.watchCheckoutNote;
      payDesc = `Watch reservation: ${title} for ${name}`;
      meta = {
        request_type: "Watch reservation", watch: title, listed_price: cad(watch.price), name,
        phone, notes_1: description.slice(0, 500), notes_2: description.slice(500),
      };
    } else {
      // ---- Custom piece request ----
      const type = clean(b.type, 30);
      const metal = clean(b.metal, 40);
      const budget = clean(b.budget, 40);
      if (!Object.prototype.hasOwnProperty.call(s.deposits, type)) return res.status(400).json({ error: "Choose a type of piece." });
      if (!s.metals.includes(metal)) return res.status(400).json({ error: "Choose a metal." });
      if (!s.budgets.includes(budget)) return res.status(400).json({ error: "Choose a budget range." });
      if (description.length < 20) return res.status(400).json({ error: "Describe your idea in at least a couple of sentences." });
      amountCents = Math.round(s.deposits[type] * 100);
      lineName = `Custom design deposit: ${type}`;
      lineDesc = "Credited toward the final price of your custom piece.";
      note = s.checkoutNote;
      payDesc = `Custom ${type.toLowerCase()} request from ${name}`;
      meta = {
        request_type: type, name, metal, budget, phone,
        stone: clean(b.stone, 100), size: clean(b.size, 60), needed_by: neededBy,
        reference, inspiration: clean(b.inspiration, 60),
        desc_1: description.slice(0, 500), desc_2: description.slice(500),
      };
    }

    // Stripe drops empty metadata values, so remove them up front.
    for (const k of Object.keys(meta)) if (!meta[k]) delete meta[k];

    const origin = process.env.SITE_URL || `https://${req.headers.host}`;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "cad",
            unit_amount: amountCents,
            tax_behavior: "exclusive",
            product_data: { name: lineName, description: lineDesc },
          },
        },
      ],
      custom_text: { submit: { message: note } },
      payment_intent_data: { description: payDesc, metadata: meta },
      metadata: meta,
      ...(process.env.STRIPE_AUTOMATIC_TAX === "true" ? { automatic_tax: { enabled: true } } : {}),
      success_url: `${origin}/?request=success`,
      cancel_url: `${origin}/#request`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Request error:", err && err.message);
    return res.status(500).json({ error: "We could not start checkout. Please try again in a moment." });
  }
};
