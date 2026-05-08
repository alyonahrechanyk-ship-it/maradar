require("dotenv").config();
const nodemailer = require("nodemailer");
const cron = require("node-cron");

// ─── Config ────────────────────────────────────────────────────────────────
const CONFIG = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  alphaVantageKey: process.env.ALPHAVANTAGE_KEY || "BLMLKJKAYRJUGPRY",
  emailFrom: process.env.EMAIL_FROM,
  emailTo: process.env.EMAIL_TO,
  emailPass: process.env.EMAIL_PASS,
  emailHost: process.env.EMAIL_HOST || "smtp.gmail.com",
  emailPort: parseInt(process.env.EMAIL_PORT || "587"),
  searchTargets: process.env.SEARCH_TARGETS || "any publicly traded company",
  cronSchedule: process.env.CRON_SCHEDULE || "0 8,13,19 * * *",
};

// ─── Step 1: Fetch rumors via Claude + web search ──────────────────────────
async function fetchRumors() {
  console.log(`[${new Date().toISOString()}] Fetching acquisition rumors...`);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CONFIG.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      system: `You are an M&A intelligence analyst. Search the web for the latest acquisition rumors
from the past 24 hours. Focus on: ${CONFIG.searchTargets}.

Return ONLY a raw JSON object — no markdown, no backticks, no explanation. Structure:
{
  "rumors": [
    {
      "targetCompany": "Full company name being acquired",
      "targetTicker": "TICKER or null if unknown/private",
      "acquirerCompany": "Full company name of buyer",
      "acquirerTicker": "TICKER or null",
      "rumoredPremium": 30,
      "rumoredBidPrice": null,
      "summary": "2-sentence summary of the rumor",
      "articleUrl": "https://...",
      "articleSource": "Publication name",
      "confidence": "high|medium|low"
    }
  ]
}

Rules:
- rumoredPremium: % above current price (e.g. 30 for 30%). Default 30 if unspecified.
- rumoredBidPrice: specific dollar bid per share if mentioned in the article, else null.
- targetTicker: stock ticker symbol (e.g. AAPL). Set null if company is private.
- articleUrl must be a real URL from actual search results.
- Include up to 6 rumors. Prioritize those with known stock tickers.`,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [
        {
          role: "user",
          content: `Search for M&A acquisition rumors, merger talks, takeover bids, and buyout speculation
published in the last 24 hours for: ${CONFIG.searchTargets}. Include article URLs. Return JSON only.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text response from Claude");

  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Could not parse JSON from response");

  return JSON.parse(jsonMatch[0]);
}

// ─── Step 2: Fetch stock price from Alpha Vantage ──────────────────────────
async function fetchStockPrice(ticker) {
  if (!ticker) return null;
  try {
    const url = "https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=" + ticker + "&apikey=" + CONFIG.alphaVantageKey;
    const response = await fetch(url);
    const data = await response.json();
    const quote = data["Global Quote"];
    if (!quote || !quote["05. price"]) throw new Error("No price data");
    const price = parseFloat(quote["05. price"]);
    const change = parseFloat(quote["10. change percent"]);
    return {
      price: price,
      currency: "USD",
      changePercent: change,
      exchange: "Alpha Vantage",
      marketCap: null,
    };
  } catch (err) {
    console.warn("  Could not fetch price for " + ticker + ": " + err.message);
    return null;
  }
}

// ─── Step 3: Calculate expected acquisition price ──────────────────────────
function calcAcquisitionPrice(currentPrice, rumoredBidPrice, rumoredPremium) {
  if (!currentPrice) return null;

  if (rumoredBidPrice && rumoredBidPrice > currentPrice) {
    const premium = ((rumoredBidPrice - currentPrice) / currentPrice) * 100;
    return {
      expectedPrice: rumoredBidPrice,
      premium: premium.toFixed(1),
      source: "rumored bid",
    };
  }

  const pct = rumoredPremium > 0 ? rumoredPremium : 30;
  return {
    expectedPrice: parseFloat((currentPrice * (1 + pct / 100)).toFixed(2)),
    premium: pct,
    source: "estimated",
  };
}

// ─── Step 4: Enrich rumors with stock data ─────────────────────────────────
async function enrichRumors(rumors) {
  console.log("Enriching " + rumors.length + " rumors with stock data...");
  const results = [];
  for (const r of rumors) {
    const stock = await fetchStockPrice(r.targetTicker);
    const priceCalc = stock
      ? calcAcquisitionPrice(stock.price, r.rumoredBidPrice, r.rumoredPremium)
      : null;
    results.push(Object.assign({}, r, { stock, priceCalc }));
    // Wait 12 seconds between requests (Alpha Vantage free = 5 per minute)
    if (r.targetTicker) await new Promise(res => setTimeout(res, 12000));
  }
  return results;
}

// ─── Step 5: Build email HTML ──────────────────────────────────────────────
function buildEmail(enrichedRumors) {
  const badge = {
    high: { bg: "#dcfce7", color: "#166534" },
    medium: { bg: "#fef9c3", color: "#854d0e" },
    low: { bg: "#fee2e2", color: "#991b1b" },
  };

  function fmt(n) {
    if (n == null) return "—";
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  const cards = enrichedRumors.length === 0
    ? "<p style='text-align:center;color:#6b7280;padding:32px;'>No acquisition rumors found in the last 24 hours.</p>"
    : enrichedRumors.map(function(r) {
        const b = badge[r.confidence] || badge.medium;
        const hasStock = r.stock && r.stock.price;
        const upside = hasStock && r.priceCalc
          ? (((r.priceCalc.expectedPrice - r.stock.price) / r.stock.price) * 100).toFixed(1)
          : null;

        return "<div style='background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin-bottom:16px;'>" +
          "<div style='display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;'>" +
          "<div><div style='font-size:19px;font-weight:700;color:#111827'>" + r.targetCompany +
          (r.targetTicker ? " <span style='font-size:13px;color:#6b7280;font-weight:400'>(" + r.targetTicker + ")</span>" : "") +
          "</div><div style='color:#6b7280;font-size:13px;margin-top:3px;'>rumored acquirer: <strong style='color:#1d4ed8'>" + r.acquirerCompany + "</strong></div></div>" +
          "<span style='background:" + b.bg + ";color:" + b.color + ";font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;margin-left:12px;'>" + r.confidence.toUpperCase() + "</span></div>" +
          (hasStock ? "<div style='display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;'>" +
            "<div style='flex:1;min-width:130px;background:#f8fafc;border-radius:8px;padding:12px 14px;'>" +
            "<div style='color:#6b7280;font-size:10px;font-weight:700;text-transform:uppercase;margin-bottom:4px;'>Current Price</div>" +
            "<div style='font-size:22px;font-weight:800;color:#111827'>$" + fmt(r.stock.price) + "</div>" +
            "<div style='color:#9ca3af;font-size:11px;margin-top:2px'>" + (r.targetTicker || "") + "</div></div>" +
            (r.priceCalc ? "<div style='flex:1;min-width:130px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 14px;'>" +
            "<div style='color:#166534;font-size:10px;font-weight:700;text-transform:uppercase;margin-bottom:4px;'>Est. Acquisition Price</div>" +
            "<div style='font-size:22px;font-weight:800;color:#15803d'>$" + fmt(r.priceCalc.expectedPrice) + "</div>" +
            "<div style='color:#16a34a;font-size:11px;font-weight:600;margin-top:2px'>+" + upside + "% upside &middot; " + r.priceCalc.premium + "% premium (" + r.priceCalc.source + ")</div></div>" : "") +
            "</div>" :
            "<div style='background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin-bottom:14px;color:#92400e;font-size:13px;'>" +
            (r.targetTicker ? "Price unavailable for " + r.targetTicker : "Private company") + "</div>") +
          "<p style='color:#374151;font-size:14px;line-height:1.65;margin:0 0 12px'>" + r.summary + "</p>" +
          "<div style='border-top:1px solid #f3f4f6;padding-top:10px;display:flex;justify-content:space-between;align-items:center;'>" +
          "<span style='color:#9ca3af;font-size:12px'>📰 " + r.articleSource + "</span>" +
          "<a href='" + r.articleUrl + "' style='color:#2563eb;font-size:13px;font-weight:600;text-decoration:none'>Read article →</a></div></div>";
      }).join("");

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

  return {
    subject: "📡 M&A Radar · " + enrichedRumors.length + " rumor" + (enrichedRumors.length !== 1 ? "s" : "") + " · " + dateStr,
    html: "<!DOCTYPE html><html><head><meta charset='utf-8'></head><body style='margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,sans-serif;'>" +
      "<div style='max-width:600px;margin:0 auto;padding:24px 16px;'>" +
      "<div style='background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);border-radius:14px;padding:28px;margin-bottom:20px;text-align:center;'>" +
      "<div style='font-size:32px;margin-bottom:6px'>📡</div>" +
      "<h1 style='color:#fff;margin:0;font-size:22px;font-weight:800;'>M&A Acquisition Radar</h1>" +
      "<p style='color:#93c5fd;margin:6px 0 0;font-size:13px'>" + dateStr + " · " + timeStr + "</p></div>" +
      cards +
      "<div style='text-align:center;padding:20px 0;color:#9ca3af;font-size:11px;'>Powered by Claude AI + Alpha Vantage<br>Not financial advice.</div>" +
      "</div></body></html>",
  };
}

// ─── Step 6: Send email ────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  const transporter = nodemailer.createTransport({
    host: CONFIG.emailHost,
    port: CONFIG.emailPort,
    secure: CONFIG.emailPort === 465,
    auth: { user: CONFIG.emailFrom, pass: CONFIG.emailPass },
  });
  await transporter.sendMail({
    from: '"M&A Radar 📡" <' + CONFIG.emailFrom + ">",
    to: CONFIG.emailTo,
    subject,
    html,
  });
  console.log("✅ Email sent → " + CONFIG.emailTo);
}

// ─── Main pipeline ─────────────────────────────────────────────────────────
async function runAgent() {
  console.log("\n" + "─".repeat(50));
  console.log("🚀 M&A Radar · " + new Date().toISOString());
  console.log("─".repeat(50));
  try {
    const { rumors } = await fetchRumors();
    console.log("  Found " + rumors.length + " rumors");
    const enriched = await enrichRumors(rumors);
    const { subject, html } = buildEmail(enriched);
    await sendEmail(subject, html);
  } catch (err) {
    console.error("❌ Agent error:", err.message);
  }
}

// ─── Schedule & boot ───────────────────────────────────────────────────────
console.log("📅 Scheduled: " + CONFIG.cronSchedule);
cron.schedule(CONFIG.cronSchedule, runAgent);
runAgent();
