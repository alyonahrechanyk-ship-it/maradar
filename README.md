# 📡 M&A Acquisition Radar

An AI agent that hunts for acquisition rumors 3× a day, looks up real stock prices,
estimates the acquisition premium, and delivers a clean email digest to your inbox.

## What each email shows

For every rumor:
- **Target company** + stock ticker
- **Rumored acquirer**
- **Current share price** (live from Yahoo Finance)
- **Estimated acquisition price** — based on the rumored bid, or a calculated premium
- **Upside %** if the deal happens
- **Link to the original article**

---

## Setup (5 minutes)

### 1. Install Node.js
Download from https://nodejs.org (v18 or newer)

### 2. Install dependencies
```bash
cd acquisition-agent
npm install
```

### 3. Configure your environment
```bash
cp .env.example .env
```
Then open `.env` and fill in:

| Variable | What to put |
|---|---|
| `ANTHROPIC_API_KEY` | From https://console.anthropic.com |
| `EMAIL_FROM` | Gmail address that sends the digest |
| `EMAIL_PASS` | Gmail **App Password** (see below) |
| `EMAIL_TO` | Where you want to receive digests |
| `SEARCH_TARGETS` | Companies/sectors to watch |

### 4. Gmail App Password (required)
Gmail won't let apps use your regular password.
1. Go to https://myaccount.google.com/apppasswords
2. Create an App Password for "Mail"
3. Paste the 16-character code into `EMAIL_PASS`

If you use Outlook/Office 365, set:
```
EMAIL_HOST=smtp.office365.com
EMAIL_PORT=587
```

### 5. Run the agent
```bash
node index.js
```

It runs immediately on startup, then repeats at 8am, 1pm, and 7pm (server time).

---

## Customize

**Change schedule** — edit `CRON_SCHEDULE` in `.env`:
```
0 9,15,21 * * *    ← 9am, 3pm, 9pm
0 */4 * * *        ← every 4 hours
```

**Focus on specific sectors** — edit `SEARCH_TARGETS`:
```
SEARCH_TARGETS=semiconductor companies, AI startups, biotech
```

**Focus on specific companies**:
```
SEARCH_TARGETS=Apple, Netflix, Spotify, Snap
```

---

## Run in the background (so it keeps running after you close terminal)

### On a Mac/Linux server
```bash
npm install -g pm2
pm2 start index.js --name "ma-radar"
pm2 save
pm2 startup   # auto-start on reboot
```

### On a VPS / cloud server
Same pm2 commands above. Cheapest options:
- DigitalOcean Droplet ($6/month)
- Railway.app (has a free tier)
- Render.com (has a free tier)

---

## How it works

1. **Claude API + web search** scans news for acquisition rumors → structured JSON
2. **Yahoo Finance** fetches the real-time stock price for each target company
3. **Premium calculator** estimates acquisition price (uses rumored bid if found, else adds ~30% premium)
4. **Nodemailer** sends a formatted HTML email digest
5. **node-cron** repeats the whole pipeline 3× a day

---

*Not financial advice. For informational purposes only.*
