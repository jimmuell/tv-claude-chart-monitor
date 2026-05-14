# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # compile main process, start Vite + Electron
npm run build    # compile main + Vite production build
npm run package  # build then package with electron-builder (macOS DMG)
```

Type-check renderer only (Vite handles this at build time):
```bash
npx tsc --noEmit
```

Type-check main process:
```bash
npx tsc -p tsconfig.main.json --noEmit
```

## Architecture

Two-process Electron app with no dock icon (macOS menubar only).

**Main process** (`src/main/index.ts`) — compiled via `tsconfig.main.json` → `dist/main/index.js`. Owns the `menubar` instance (wraps Tray + BrowserWindow), builds the right-click context menu. In dev it loads `http://localhost:5173`; in prod it loads `dist/renderer/index.html`.

**Renderer process** (`src/renderer/`) — React + TypeScript, bundled by Vite. `index.html` is the Vite root entry; `main.tsx` mounts the React tree; `App.tsx` is the top-level component. Dark theme via CSS variables in `styles.css`.

**Shared** (`src/shared/types.ts`) — TypeScript types and IPC channel constants used by both processes.

## Key config details

- `tsconfig.json` — renderer only (`noEmit: true`, targets Vite/bundler moduleResolution)
- `tsconfig.main.json` — main process only (`module: CommonJS`, emits to `dist/main/`)
- `vite.config.ts` — root is `src/renderer/`, output is `dist/renderer/`
- `electron-builder.yml` — config only; packaging not yet wired into CI

## Dark theme tokens

`--bg` `#1e222d` · `--surface` `#262b3d` · `--text-primary` `#d1d4dc` · `--text-secondary` `#787b86` · `--accent` `#26a69a` · `--bearish` `#ef5350` · `--border` `#363a45`
