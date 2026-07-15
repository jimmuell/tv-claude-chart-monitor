# tv-claude-chart-monitor

TradingView chart analysis and trade journal — Electron menubar app.

## Quick start

```bash
# Install (rebuilds better-sqlite3 against Electron's Node ABI automatically)
npm install

# Start TradingView Desktop with CDP enabled
open -a "TradingView" --args --remote-debugging-port=9222

# Copy env and set your Anthropic API key
cp .env.example .env

# Start everything: Electron app + trade journal server (recommended)
npm run dev:all

# Or start the Electron app alone
npm run dev
```

The journal dashboard is served at **http://localhost:3001** by the journal server.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev:all` | Electron app + journal server, labelled output (MAIN, VITE, APP, JOURNAL) |
| `npm run dev` | Electron app only |
| `npm run journal` | Journal server only (reads existing trades.db) |
| `npm run build` | Production build (main + renderer + journal) |
| `npm run package` | Build + package as macOS DMG |
| `npm test` | Run unit tests |

See `CLAUDE.md` for architecture details, module map, and config reference.
