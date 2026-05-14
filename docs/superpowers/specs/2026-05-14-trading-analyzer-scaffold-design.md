# Design Spec: Trading Analyzer — Electron Menubar Scaffold

**Date:** 2026-05-14
**Status:** Approved
**Scope:** Phase 1 scaffold — tray icon, menubar panel, placeholder React UI

---

## Overview

A macOS menubar app called **Trading Analyzer** that lives in the system tray. Clicking the icon opens a slide-out panel (420×700px) containing a React UI. No dock icon. Built with Electron + the `menubar` npm package + React/TypeScript/Vite.

The repo root (`tv-claude-chart-monitor/`) is the project root — all project files live here, not in a subdirectory.

---

## Architecture

### Process Model

Two Electron processes:

**Main process** (`src/main/index.ts`)
- Runs in Node.js
- Owns the `menubar` instance (wraps Tray + BrowserWindow)
- Calls `app.dock.hide()` and `app.setActivationPolicy('accessory')` at startup to suppress dock icon
- Builds and attaches the right-click context menu
- In dev: loads renderer from Vite dev server (`http://localhost:5173`)
- In prod: loads from `dist/renderer/index.html`

**Renderer process** (`src/renderer/`)
- Vite-bundled React + TypeScript app
- Loaded into the menubar's BrowserWindow
- No IPC in v1 (all UI is static placeholder)

**Shared** (`src/shared/types.ts`)
- TypeScript interfaces and IPC channel name constants shared between processes

### Dev Workflow

`npm run dev` uses `concurrently` to run in parallel:
1. `tsc --watch --project tsconfig.main.json` — compiles main process to `dist/main/`
2. `vite` — serves renderer at `http://localhost:5173`
3. `electron dist/main/index.js` — launches app (waits for Vite to be ready first using `wait-on`)

---

## File Structure

```
tv-claude-chart-monitor/
├── src/
│   ├── main/
│   │   └── index.ts
│   ├── renderer/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   └── styles.css
│   └── shared/
│       └── types.ts
├── assets/
│   └── iconTemplate.png          ← 22×22 grayscale template PNG (placeholder)
├── docs/
│   └── superpowers/specs/        ← design specs
├── package.json
├── tsconfig.json                 ← base config (used by renderer/vite)
├── tsconfig.main.json            ← extends base, targets main process (CommonJS/Node)
├── vite.config.ts
├── electron-builder.yml
└── CLAUDE.md
```

---

## Components

### Main Process (`src/main/index.ts`)

```
menubar({
  index: devUrl | prodFile,
  icon: assets/iconTemplate.png,
  browserWindow: {
    width: 420,
    height: 700,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  },
  preloadWindow: true
})
```

On `tray.on('right-click')`:
```
Menu.buildFromTemplate([
  { label: 'Show Panel',   click: mb.showWindow() },
  { label: 'Refresh Now',  click: mb.showWindow() },  // v1: same as Show Panel; IPC wired later
  { type: 'separator' },
  { label: 'Quit',         click: app.quit() }
])
```

### Renderer UI (`src/renderer/App.tsx`)

Three sections, full-height flex column:

| Section | Content |
|---------|---------|
| Header | "Trading Analyzer" title + status dot (hardcoded gray/inactive in v1) + gear icon (non-functional) |
| Body | Centered placeholder: "No analysis yet. Click refresh to capture." |
| Footer | "Refresh" button (non-functional in v1) |

### Icon (`assets/iconTemplate.png`)

22×22px grayscale PNG. macOS template icons must be black-on-transparent; the OS applies tinting. A simple bar-chart or candlestick shape. Placeholder is acceptable for v1.

---

## Styling

TradingView-matched dark theme via CSS variables in `styles.css`:

| Variable | Value |
|----------|-------|
| `--bg` | `#1e222d` |
| `--surface` | `#262b3d` |
| `--text-primary` | `#d1d4dc` |
| `--text-secondary` | `#787b86` |
| `--accent` | `#26a69a` |
| `--bearish` | `#ef5350` |
| `--border` | `#363a45` |

---

## Build / Packaging

`electron-builder.yml` — config only, no build in v1:
- `appId`: `com.tradinganalyzer.app`
- `productName`: `Trading Analyzer`
- `mac.target`: `dmg`
- `mac.category`: `public.app-category.finance`
- `files`: `dist/**`, `assets/**`

---

## Acceptance Criteria

- [ ] `npm run dev` launches app with tray icon, no dock icon
- [ ] Clicking tray icon shows the 420×700 panel
- [ ] Panel renders dark-themed React UI (header, placeholder, refresh button)
- [ ] Right-click shows context menu with Show Panel / Refresh Now / separator / Quit
- [ ] No console errors on launch
