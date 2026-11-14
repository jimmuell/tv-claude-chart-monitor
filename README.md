# tv-claude-chart-monitor

TradingView chart analysis and order-history P&L — Electron menubar app.

## Quick start

```bash
# Install (rebuilds better-sqlite3 against Electron's Node ABI automatically)
npm install

# Start TradingView Desktop with CDP enabled
open -a "TradingView" --args --remote-debugging-port=9222

# Copy env and set your Anthropic API key
cp .env.example .env

# Start the app (Electron + both renderer entries)
npm run dev
```

The menu bar shows the current session's net P&L. **Order History & P&L** in the tray
menu opens a window with the session summary, every trade, the raw fills, past days,
the recommendation scorecard and the lessons queue.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Electron app, labelled output (MAIN, VITE, PNL, APP) |
| `npm run dev:all` | Same as `dev` (kept so existing habits still work) |
| `npm run build` | Production build (main + panel + Order History window) |
| `npm run package` | Build + package as macOS DMG |
| `npm test` | Run unit tests |

See `CLAUDE.md` for architecture details, module map, and config reference.
