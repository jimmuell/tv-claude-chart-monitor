# Google Drive Export — Design Spec
**Date:** 2026-05-27
**Branch:** feat/capture-and-analysis

---

## Overview

Add a Google Drive split button to the panel header. Clicking it exports the current analysis as a native Google Doc into a dedicated "Trading Analyzer" folder in the user's Drive, then opens the doc in the browser. Authentication uses OAuth2 PKCE with tokens persisted in Electron's `userData`.

---

## Architecture

All Google API work is confined to the main process. The renderer fires IPC commands and receives back a URL or status — it never holds tokens or makes direct network calls to Google.

### New files

| File | Role |
|---|---|
| `src/main/google-auth.ts` | OAuth2 PKCE: local HTTP callback server, token storage/refresh |
| `src/main/google-drive.ts` | Drive multipart upload, folder creation/lookup, returns doc URL |
| `src/main/google-doc-formatter.ts` | Converts `AnalysisResult` → HTML for Drive's doc importer |

### Existing files modified

| File | Change |
|---|---|
| `src/main/index.ts` | Register `gdrive:export` and `gdrive:status` IPC handlers |
| `src/main/preload.ts` | Expose `exportToDrive` and `getGDriveStatus` on `window.api` |
| `src/renderer/App.tsx` | Add `GDriveButton` split button to `header-row1` |
| `src/shared/types.ts` | Add `GDRIVE_EXPORT`, `GDRIVE_STATUS` to `IPC`; extend `ElectronAPI` |

---

## OAuth2 Flow (`google-auth.ts`)

1. On first export attempt, check `userData/google-auth.json` — if missing or invalid, start the sign-in flow.
2. Bind a local HTTP server using `net.createServer` on port 0 (OS assigns a free port); read the assigned port from `server.address().port`.
3. Build the Google OAuth2 authorization URL with:
   - `response_type=code`
   - `code_challenge` (S256 PKCE)
   - `redirect_uri=http://localhost:<port>/callback`
   - Scopes: `https://www.googleapis.com/auth/drive.file openid email`
4. Open the URL via `shell.openExternal`.
5. Wait for the redirect; extract `code` from query params; exchange for `access_token` + `refresh_token` via POST to `https://oauth2.googleapis.com/token`.
6. Save `{ access_token, refresh_token, expiry_date, email }` to `userData/google-auth.json`.
7. On subsequent calls, if `expiry_date` is within 60s, silently refresh using `refresh_token` and save updated tokens.
8. Sign-out clears `google-auth.json` and revokes the token via `https://oauth2.googleapis.com/revoke`.

**Google Cloud setup required (one-time, by developer):**
- Create a project in Google Cloud Console
- Enable Drive API
- Create an OAuth 2.0 Client ID of type "Desktop app"
- Store `client_id` and `client_secret` in `config/config.json` under `google.clientId` / `google.clientSecret`
- No redirect URI registration needed for loopback (`localhost`) per RFC 8252

---

## Drive Upload (`google-drive.ts`)

### Folder management
- On first export, search Drive for a folder named "Trading Analyzer" owned by the user: `GET /drive/v3/files?q=name='Trading Analyzer' and mimeType='application/vnd.google-apps.folder' and trashed=false`
- If not found, create it: `POST /drive/v3/files` with `{ name, mimeType: 'application/vnd.google-apps.folder' }`
- Cache the folder ID in memory for the session (re-lookup on next app launch)

### Document creation
- `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`
- Multipart body: metadata part (`name`, `mimeType: application/vnd.google-apps.document`, `parents: [folderId]`) + media part (HTML body with `Content-Type: text/html`)
- Drive converts HTML to a native Google Doc automatically
- Response includes `webViewLink` — open via `shell.openExternal(webViewLink)`

### Document naming
`{SYMBOL} {TIMEFRAME}m — {VERDICT} — {YYYY-MM-DD HH:mm}` (local time)
Example: `ES 5m — LONG — 2026-05-27 09:32`

---

## Document Formatter (`google-doc-formatter.ts`)

Converts `AnalysisResult` to an HTML string. Structure:

```
<h1>{VERDICT}: {headline}</h1>
<p><strong>{symbol} {timeframe}m @ {closedBarPrice}</strong> · {timestamp}</p>

<h2>Key Levels</h2>
<ul>
  <li><strong>{price}</strong> {label} — {action}</li>
  ...
</ul>

<h2>Trade Plan ({direction})</h2>
<table>
  <tr><th>Entry</th><th>Stop</th><th>Target</th><th>R:R</th><th>Confidence</th></tr>
  <tr><td>...</td>...</tr>
</table>
<p>{rationale}</p>

<h2>Best Setup</h2>
<p>{setup}</p>
<p>Entry: {entry_zone} | Stop: {stop} | Targets: {targets}</p>

<h2>What Happened</h2>
<ol>
  <li>...</li>
</ol>

<h2>Chart State</h2>
<p>{objective}</p>

<h2>Directives</h2>
<p><strong>NOW:</strong> {what_now}</p>
<p><strong>NOT:</strong> {what_not}</p>

<h2>Summary</h2>
<p>{bottom_line}</p>
<p><strong>IF:</strong> {next_trigger}</p>
<p><em>LESSON: {key_lesson}</em></p>
```

Sections with null/empty data are omitted.

---

## UI Button (`App.tsx`)

### Placement
In `header-row1`, between the `<h1 className="title">` and the gear icon button. The button is only rendered when `uiStatus === 'complete' && result !== null`.

### Split button anatomy
```
[ ▲ Google Drive  |  ∨ ]
```
- Left side: Google Drive multicolor triangle SVG + "Google Drive" label. Click triggers export.
- Right side: chevron-down. Click opens a small dropdown (positioned below-right of the button):
  - **Open folder** — opens the Trading Analyzer Drive folder URL in browser
  - **Sign out** — clears tokens, resets button to unauthenticated state

### Button states
| State | Appearance |
|---|---|
| No result | Hidden |
| Authenticated, idle | Normal (dark pill, Drive logo) |
| Not authenticated | Label reads "Connect Drive" |
| Exporting | Spinner replaces logo, label "Exporting…", left side disabled |
| Success (2s) | Label "Opened ✓", green tint |
| Error (3s) | Label "Failed", red tint; error message in existing toast |

### Dropdown folder URL
Stored in component state after first export. Initially null (Open folder item is disabled until first export completes).

---

## IPC Contract

### `gdrive:export` → `{ url: string; folderUrl: string }`
Runs: authenticate (if needed) → format HTML → upload → open URL → return URL + folderUrl.
`folderUrl` is the Drive web URL for the "Trading Analyzer" folder; the renderer stores it in state to enable the "Open folder" dropdown item across app sessions.
Throws on auth failure, network error, or Drive API error (renderer shows toast).

### `gdrive:status` → `{ authenticated: boolean; email?: string }`
Returns current auth state. Called on mount and after sign-out to update the dropdown label.

### `window.api` additions (types.ts + preload.ts)
```ts
exportToDrive(): Promise<{ url: string; folderUrl: string }>;
getGDriveStatus(): Promise<{ authenticated: boolean; email?: string }>;
```

---

## Error Handling

- **OAuth cancelled** (user closes browser without signing in): reject with `'Google sign-in cancelled'`, show toast.
- **Token refresh fails** (revoked): clear stored tokens, re-trigger sign-in flow.
- **Drive API 4xx/5xx**: surface error message in the existing toast system.
- **No result to export**: button is hidden when `result === null`, so this cannot happen.

---

## Dependencies

Add to `package.json`:
- `googleapis` — Google's official Node.js SDK (handles OAuth2, Drive API, token refresh)

No new devDependencies needed.

---

## Out of Scope

- Choosing a different Drive folder (configurable folder picker) — not in this iteration
- Updating an existing doc on re-export (always creates a new doc)
- Offline queue / retry if Drive is unreachable
- DOCX format (native Google Doc only per design decision)
