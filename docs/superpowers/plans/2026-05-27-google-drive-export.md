# Google Drive Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Google Drive split button to the panel header that exports the current analysis as a native Google Doc into a "Trading Analyzer" folder, then opens it in the browser.

**Architecture:** Main process owns all Google API work — OAuth2 PKCE flow with tokens in `userData`, Drive multipart upload converting HTML to a Google Doc. Renderer fires two IPC commands (`gdrive:export`, `gdrive:status`) and receives back a URL or auth status; it never touches tokens directly.

**Tech Stack:** `googleapis` npm package (OAuth2 + Drive API v3), Electron `shell.openExternal`, Node.js `http`/`net` (local callback server), React split-button component.

---

### Task 1: Install `googleapis` and add Google credentials block to config

**Files:**
- Modify: `package.json` (via npm install)
- Modify: `config/config.json`

- [ ] **Step 1: Install the googleapis package**

```bash
cd /Users/jameslmueller/Projects/tv-claude-chart-monitor
npm install googleapis
```

Expected: `googleapis` appears under `"dependencies"` in `package.json`.

- [ ] **Step 2: Add the `google` credentials block to `config/config.json`**

Open `config/config.json` and add the following block after the `"annotator"` section (before the closing `}`):

```json
  "google": {
    "clientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",
    "clientSecret": "YOUR_CLIENT_SECRET"
  }
```

> **Note for developer:** Before running, replace `YOUR_CLIENT_ID` and `YOUR_CLIENT_SECRET` with real values from Google Cloud Console:
> 1. Create a project → Enable Drive API
> 2. OAuth consent screen → add scope `https://www.googleapis.com/auth/drive.file`
> 3. Create OAuth 2.0 Client ID → Application type: **Desktop app**
> 4. Copy Client ID and Client Secret into `config/config.json`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json config/config.json
git commit -m "feat(gdrive): install googleapis, add credentials config block"
```

---

### Task 2: Extend shared types — IPC channels and ElectronAPI

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add new IPC channel constants to the `IPC` object**

In `src/shared/types.ts`, find the `IPC` const (around line 9) and add three new entries at the end of the object, before `} as const`:

```typescript
  GDRIVE_EXPORT:  'gdrive:export',
  GDRIVE_STATUS:  'gdrive:status',
  GDRIVE_SIGNOUT: 'gdrive:signout',
```

- [ ] **Step 2: Add the `GDriveStatus` interface**

After the `ElectronAPI` interface closing brace (end of file), add:

```typescript
export interface GDriveStatus {
  authenticated: boolean;
  email?: string;
}
```

- [ ] **Step 3: Extend `ElectronAPI` with the three new methods**

Inside the `ElectronAPI` interface (after `onPnlUpdate`), add:

```typescript
  exportToDrive(): Promise<{ url: string; folderUrl: string }>;
  getGDriveStatus(): Promise<GDriveStatus>;
  gdriveSignOut(): Promise<void>;
```

- [ ] **Step 4: Fix the `lastResult` type in `index.ts` (prerequisite for Task 6)**

In `src/main/index.ts`, change line 56 from:
```typescript
let lastResult: unknown               = null;
```
to:
```typescript
let lastResult: AnalysisResult | null = null;
```

`AnalysisResult` is already imported at line 11.

- [ ] **Step 5: Type-check**

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/index.ts
git commit -m "feat(gdrive): add IPC channels, GDriveStatus type, extend ElectronAPI"
```

---

### Task 3: Implement `google-auth.ts` — OAuth2 PKCE flow

**Files:**
- Create: `src/main/google-auth.ts`

- [ ] **Step 1: Create `src/main/google-auth.ts` with the following content**

```typescript
import { app, shell } from 'electron';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import http from 'http';
import net from 'net';
import crypto from 'crypto';
import { URL } from 'url';

const TOKEN_PATH = path.join(app.getPath('userData'), 'google-auth.json');
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
];

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cfg = require('../../config/config.json') as {
  google: { clientId: string; clientSecret: string };
};

interface StoredTokens {
  access_token:  string;
  refresh_token: string;
  expiry_date:   number;
  email:         string;
}

function loadTokens(): StoredTokens | null {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8')); }
  catch { return null; }
}

function saveTokens(t: StoredTokens): void {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(t));
}

function clearTokens(): void {
  try { fs.unlinkSync(TOKEN_PATH); } catch { /* already gone */ }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function runAuthFlow(): Promise<StoredTokens> {
  const { clientId, clientSecret } = cfg.google;
  const port = await findFreePort();
  const redirectUri = `http://localhost:${port}/callback`;
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const verifier   = crypto.randomBytes(32).toString('base64url');
  const challenge  = crypto.createHash('sha256').update(verifier).digest('base64url');

  const authUrl = client.generateAuthUrl({
    access_type:           'offline',
    scope:                 SCOPES,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    prompt:                'consent',
  });

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url   = new URL(req.url!, `http://localhost:${port}`);
        const code  = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>Signed in! You can close this tab.</h2></body></html>');
        server.close();

        if (error || !code) { reject(new Error(error ?? 'No auth code received')); return; }

        const { tokens } = await client.getToken({ code, codeVerifier: verifier });
        client.setCredentials(tokens);

        const oauth2Api = google.oauth2({ version: 'v2', auth: client });
        const { data }  = await oauth2Api.userinfo.get();

        const stored: StoredTokens = {
          access_token:  tokens.access_token!,
          refresh_token: tokens.refresh_token!,
          expiry_date:   tokens.expiry_date!,
          email:         data.email ?? '',
        };
        saveTokens(stored);
        resolve(stored);
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => { shell.openExternal(authUrl); });
    server.on('error', reject);

    // Time out after 5 minutes if the user never completes sign-in
    setTimeout(() => { server.close(); reject(new Error('Google sign-in timed out')); }, 5 * 60_000);
  });
}

export async function getAuthClient(): Promise<InstanceType<typeof google.auth.OAuth2>> {
  let tokens = loadTokens();
  if (!tokens) tokens = await runAuthFlow();

  const { clientId, clientSecret } = cfg.google;
  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date:   tokens.expiry_date,
  });

  // Proactively refresh if expiring within 60 s
  if (tokens.expiry_date - Date.now() < 60_000) {
    const { credentials } = await client.refreshAccessToken();
    const refreshed: StoredTokens = {
      ...tokens,
      access_token: credentials.access_token!,
      expiry_date:  credentials.expiry_date!,
    };
    saveTokens(refreshed);
    client.setCredentials(credentials);
  }

  return client;
}

export function getStatus(): { authenticated: boolean; email?: string } {
  const t = loadTokens();
  return t ? { authenticated: true, email: t.email } : { authenticated: false };
}

export async function signOut(): Promise<void> {
  const t = loadTokens();
  if (t?.access_token) {
    try {
      const { clientId, clientSecret } = cfg.google;
      const client = new google.auth.OAuth2(clientId, clientSecret);
      client.setCredentials({ access_token: t.access_token });
      await client.revokeCredentials();
    } catch { /* best effort */ }
  }
  clearTokens();
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors. If you see `@types/node` missing errors, they're already in devDependencies — run `npm install` first.

- [ ] **Step 3: Commit**

```bash
git add src/main/google-auth.ts
git commit -m "feat(gdrive): implement OAuth2 PKCE auth module"
```

---

### Task 4: Implement `google-doc-formatter.ts` — HTML document builder

**Files:**
- Create: `src/main/google-doc-formatter.ts`

- [ ] **Step 1: Create `src/main/google-doc-formatter.ts` with the following content**

```typescript
import type { AnalysisResult } from '../shared/types';

const VERDICT_LABEL: Record<string, string> = {
  valid_long:      'LONG',
  valid_long_was:  'LONG (WAS)',
  valid_short:     'SHORT',
  valid_short_was: 'SHORT (WAS)',
  no_trade:        'NO TRADE',
  wait:            'WAIT',
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmt(n: number | null): string {
  return n != null ? n.toFixed(2) : '—';
}

function stripLeadingNumber(s: string): string {
  return s.replace(/^\d+[.)]\s*/, '');
}

export function formatAsHtml(result: AnalysisResult): string {
  const { symbol, timeframe, closedBarPrice, commentary } = result;
  const {
    headline, setup_verdict, objective, steps_what_happened,
    what_now, what_not, trade_plan, key_levels_to_watch,
    structure_read, highest_probability_trade,
    bottom_line, next_trigger, key_lesson,
  } = commentary;

  const verdict   = VERDICT_LABEL[setup_verdict] ?? setup_verdict;
  const now       = new Date();
  const pad       = (n: number) => n.toString().padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const parts: string[] = [
    `<h1>${esc(verdict)}: ${esc(headline)}</h1>`,
    `<p><strong>${esc(symbol)} ${esc(timeframe)}m @ ${closedBarPrice}</strong> · ${timestamp}</p>`,
  ];

  if (structure_read) {
    parts.push(`<h2>Structure</h2><p>${esc(structure_read)}</p>`);
  }

  if (key_levels_to_watch && key_levels_to_watch.length > 0) {
    parts.push('<h2>Key Levels</h2><ul>');
    for (const lvl of key_levels_to_watch) {
      parts.push(`<li><strong>${lvl.price.toFixed(2)}</strong> ${esc(lvl.label)} — ${esc(lvl.action)}</li>`);
    }
    parts.push('</ul>');
  }

  if (highest_probability_trade) {
    const hpt = highest_probability_trade;
    parts.push(`<h2>Best Setup</h2><p>${esc(hpt.setup)}</p>`);
    parts.push(`<p>Entry: ${esc(hpt.entry_zone)} | Stop: ${esc(hpt.stop)} | Targets: ${esc(hpt.targets)}</p>`);
    if (hpt.condition) {
      parts.push(`<p><strong>IF:</strong> ${esc(hpt.condition)}</p>`);
    }
  }

  if (trade_plan && trade_plan.direction !== 'none') {
    const tp = trade_plan;
    parts.push(`<h2>Trade Plan (${esc(tp.direction.toUpperCase())})</h2>`);
    parts.push(
      `<table><tr><th>Entry</th><th>Stop</th><th>Target</th><th>R:R</th><th>Confidence</th></tr>` +
      `<tr><td>${fmt(tp.entry)}</td><td>${fmt(tp.stop)}</td><td>${fmt(tp.target)}</td>` +
      `<td>${tp.rr != null ? tp.rr.toFixed(1) + 'R' : '—'}</td><td>${esc(tp.confidence.toUpperCase())}</td></tr></table>`,
    );
    if (tp.rationale) parts.push(`<p>${esc(tp.rationale)}</p>`);
  }

  if (steps_what_happened.length > 0) {
    parts.push('<h2>What Happened</h2><ol>');
    for (const step of steps_what_happened) {
      parts.push(`<li>${esc(stripLeadingNumber(step))}</li>`);
    }
    parts.push('</ol>');
  }

  parts.push(`<h2>Chart State</h2><p>${esc(objective)}</p>`);
  parts.push(
    `<h2>Directives</h2>` +
    `<p><strong>NOW:</strong> ${esc(what_now)}</p>` +
    `<p><strong>NOT:</strong> ${esc(what_not)}</p>`,
  );
  parts.push(`<h2>Summary</h2><p>${esc(bottom_line)}</p>`);
  if (next_trigger) parts.push(`<p><strong>IF:</strong> ${esc(next_trigger)}</p>`);
  if (key_lesson)   parts.push(`<p><em>LESSON: ${esc(key_lesson)}</em></p>`);

  return parts.join('\n');
}

export function docName(result: AnalysisResult): string {
  const { symbol, timeframe, commentary } = result;
  const verdict = VERDICT_LABEL[commentary.setup_verdict] ?? commentary.setup_verdict;
  const now     = new Date();
  const pad     = (n: number) => n.toString().padStart(2, '0');
  const date    = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time    = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${symbol} ${timeframe}m — ${verdict} — ${date} ${time}`;
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/google-doc-formatter.ts
git commit -m "feat(gdrive): implement HTML document formatter"
```

---

### Task 5: Implement `google-drive.ts` — Drive upload and folder management

**Files:**
- Create: `src/main/google-drive.ts`

- [ ] **Step 1: Create `src/main/google-drive.ts` with the following content**

```typescript
import { google } from 'googleapis';
import { shell } from 'electron';
import { getAuthClient } from './google-auth';
import { formatAsHtml, docName } from './google-doc-formatter';
import type { AnalysisResult } from '../shared/types';

const FOLDER_NAME = 'Trading Analyzer';

let cachedFolderId: string | null = null;

async function findOrCreateFolder(
  auth: Awaited<ReturnType<typeof getAuthClient>>,
): Promise<{ folderId: string; folderUrl: string }> {
  if (cachedFolderId) {
    return {
      folderId:  cachedFolderId,
      folderUrl: `https://drive.google.com/drive/folders/${cachedFolderId}`,
    };
  }

  const drive = google.drive({ version: 'v3', auth });

  const search = await drive.files.list({
    q:      `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  });

  if (search.data.files && search.data.files.length > 0) {
    cachedFolderId = search.data.files[0].id!;
    return {
      folderId:  cachedFolderId,
      folderUrl: `https://drive.google.com/drive/folders/${cachedFolderId}`,
    };
  }

  const created = await drive.files.create({
    requestBody: {
      name:     FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });

  cachedFolderId = created.data.id!;
  return {
    folderId:  cachedFolderId,
    folderUrl: `https://drive.google.com/drive/folders/${cachedFolderId}`,
  };
}

export async function exportAnalysis(
  result: AnalysisResult,
): Promise<{ url: string; folderUrl: string }> {
  const auth  = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  const { folderId, folderUrl } = await findOrCreateFolder(auth);

  const html = formatAsHtml(result);
  const name = docName(result);

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.document',
      parents:  [folderId],
    },
    media: {
      mimeType: 'text/html',
      body:     html,
    },
    fields: 'id,webViewLink',
  });

  const url = created.data.webViewLink!;
  shell.openExternal(url);
  return { url, folderUrl };
}

export function invalidateFolderCache(): void {
  cachedFolderId = null;
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/google-drive.ts
git commit -m "feat(gdrive): implement Drive upload and folder management"
```

---

### Task 6: Wire IPC handlers in `index.ts`

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add imports at the top of `index.ts`**

After the existing imports (around line 14), add:

```typescript
import { exportAnalysis, invalidateFolderCache } from './google-drive';
import { getStatus as getGDriveStatus, signOut as gdriveSignOut } from './google-auth';
```

- [ ] **Step 2: Register the three new IPC handlers**

Find the comment `// IPC: app version` (near the end of the `app.on('ready', ...)` block, around line 371) and add the following three handlers **before** it:

```typescript
  // IPC: Google Drive export
  ipcMain.handle(IPC.GDRIVE_EXPORT, async () => {
    if (!lastResult) throw new Error('No analysis result to export');
    return exportAnalysis(lastResult);
  });

  // IPC: Google Drive auth status
  ipcMain.handle(IPC.GDRIVE_STATUS, () => getGDriveStatus());

  // IPC: Google Drive sign-out
  ipcMain.handle(IPC.GDRIVE_SIGNOUT, async () => {
    await gdriveSignOut();
    invalidateFolderCache();
  });
```

- [ ] **Step 3: Type-check**

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(gdrive): register gdrive:export, gdrive:status, gdrive:signout IPC handlers"
```

---

### Task 7: Expose Drive API via `preload.ts`

**Files:**
- Modify: `src/main/preload.ts`

- [ ] **Step 1: Add the three new methods to the contextBridge `exposeInMainWorld` call**

In `src/main/preload.ts`, find the last entry before the closing `});` (the `onPnlUpdate` handler). Add these three methods after `onPnlUpdate`:

```typescript
  exportToDrive: (): Promise<{ url: string; folderUrl: string }> =>
    ipcRenderer.invoke(IPC.GDRIVE_EXPORT),
  getGDriveStatus: (): Promise<import('../shared/types').GDriveStatus> =>
    ipcRenderer.invoke(IPC.GDRIVE_STATUS),
  gdriveSignOut: (): Promise<void> =>
    ipcRenderer.invoke(IPC.GDRIVE_SIGNOUT),
```

- [ ] **Step 2: Type-check the renderer-facing types**

```bash
npx tsc --noEmit
```

Expected: no errors (this checks that `window.api.exportToDrive` matches `ElectronAPI`).

- [ ] **Step 3: Commit**

```bash
git add src/main/preload.ts
git commit -m "feat(gdrive): expose exportToDrive, getGDriveStatus, gdriveSignOut on window.api"
```

---

### Task 8: Add CSS for the Google Drive split button

**Files:**
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Add the Drive button CSS**

Find the `.icon-btn-active` block near the end of `styles.css` (around line 707) and append the following after it:

```css
/* ── Google Drive split button ── */

.header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  -webkit-app-region: no-drag;
}

.gdrive-wrap {
  position: relative;
  -webkit-app-region: no-drag;
}

.gdrive-split-btn {
  display: flex;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: visible;
  -webkit-app-region: no-drag;
}

.gdrive-btn-left {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  background: none;
  border: none;
  border-right: 1px solid var(--border);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: 0.01em;
  transition: background 0.15s;
  -webkit-app-region: no-drag;
}

.gdrive-btn-left:hover:not(:disabled) {
  background: var(--border);
}

.gdrive-btn-left:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.gdrive-btn-left.success {
  color: var(--accent);
}

.gdrive-btn-left.error-state {
  color: var(--bearish);
}

.gdrive-btn-right {
  display: flex;
  align-items: center;
  padding: 4px 7px;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 10px;
  transition: background 0.15s, color 0.15s;
  -webkit-app-region: no-drag;
}

.gdrive-btn-right:hover {
  background: var(--border);
  color: var(--text-primary);
}

.gdrive-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  min-width: 150px;
  z-index: 200;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.gdrive-dropdown-item {
  display: block;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;
  -webkit-app-region: no-drag;
}

.gdrive-dropdown-item:hover:not(:disabled) {
  background: var(--border);
}

.gdrive-dropdown-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.gdrive-dropdown-sep {
  height: 1px;
  background: var(--border);
  margin: 2px 0;
}

.gdrive-spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: gdrive-spin 0.7s linear infinite;
}

@keyframes gdrive-spin {
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/styles.css
git commit -m "feat(gdrive): add Google Drive split button CSS"
```

---

### Task 9: Add `GDriveButton` component and wire it into `App.tsx`

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add the Google Drive SVG icon and the `GDriveButton` component**

Find the `BackArrowIcon` component definition (around line 14 in `App.tsx`) and insert the following **before** it:

```tsx
const GoogleDriveIcon: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M4.53 21L0 13.5 4.53 6h4.52L4.53 21z" />
    <path fill="#34A853" d="M19.47 21H4.53l2.26-3.9h15.2z" />
    <path fill="#EA4335" d="M19.47 21l4.53-7.5L19.47 6l-2.26 3.9 4.52 7.6z" />
    <path fill="#0F9D58" d="M9.88 21l2.26-3.9h5.07L9.88 21z" />
    <path fill="#1565C0" d="M4.53 6h4.52l2.26 3.9H6.8z" />
    <path fill="#FFC107" d="M14.14 9.9h5.07l-2.26 3.9h-5.08z" />
  </svg>
);

const ChevronDownIcon: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M7 10l5 5 5-5z" />
  </svg>
);

type GDriveState = 'unauthenticated' | 'idle' | 'exporting' | 'success' | 'error';

const GDriveButton: React.FC<{
  result: import('../shared/types').AnalysisResult;
  onError: (msg: string) => void;
}> = ({ result, onError }) => {
  const [gState, setGState]           = useState<GDriveState>('idle');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [folderUrl, setFolderUrl]       = useState<string | null>(null);
  const [userEmail, setUserEmail]       = useState<string | undefined>();
  const dropdownRef                     = useRef<HTMLDivElement>(null);
  const stateTimerRef                   = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    window.api.getGDriveStatus().then(s => {
      if (!s.authenticated) setGState('unauthenticated');
      setUserEmail(s.email);
    }).catch(() => setGState('unauthenticated'));
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const setTempState = (s: GDriveState, ms: number) => {
    setGState(s);
    if (stateTimerRef.current) clearTimeout(stateTimerRef.current);
    stateTimerRef.current = setTimeout(() => { setGState('idle'); stateTimerRef.current = null; }, ms);
  };

  const handleExport = async () => {
    setDropdownOpen(false);
    setGState('exporting');
    try {
      const { folderUrl: fUrl } = await window.api.exportToDrive();
      setFolderUrl(fUrl);
      setTempState('success', 2000);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Drive export failed');
      setTempState('error', 3000);
    }
  };

  const handleSignOut = async () => {
    setDropdownOpen(false);
    try {
      await window.api.gdriveSignOut();
      setGState('unauthenticated');
      setUserEmail(undefined);
      setFolderUrl(null);
    } catch { /* ignore */ }
  };

  const handleOpenFolder = () => {
    setDropdownOpen(false);
    if (folderUrl) window.open(folderUrl, '_blank');
  };

  const leftLabel = () => {
    switch (gState) {
      case 'exporting':     return 'Exporting…';
      case 'success':       return 'Opened ✓';
      case 'error':         return 'Failed';
      case 'unauthenticated': return 'Connect Drive';
      default:              return 'Google Drive';
    }
  };

  const leftClass = [
    'gdrive-btn-left',
    gState === 'success' ? 'success' : '',
    gState === 'error'   ? 'error-state' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="gdrive-wrap" ref={dropdownRef}>
      <div className="gdrive-split-btn">
        <button
          className={leftClass}
          onClick={handleExport}
          disabled={gState === 'exporting'}
          title={gState === 'unauthenticated' ? 'Sign in to Google Drive' : 'Export analysis to Google Drive'}
        >
          {gState === 'exporting'
            ? <span className="gdrive-spinner" />
            : <GoogleDriveIcon />
          }
          {leftLabel()}
        </button>
        <button
          className="gdrive-btn-right"
          onClick={() => setDropdownOpen(v => !v)}
          aria-label="Drive options"
          title="Drive options"
        >
          <ChevronDownIcon />
        </button>
      </div>

      {dropdownOpen && (
        <div className="gdrive-dropdown">
          {userEmail && (
            <button className="gdrive-dropdown-item" style={{ opacity: 0.6, cursor: 'default' }} disabled>
              {userEmail}
            </button>
          )}
          {userEmail && <div className="gdrive-dropdown-sep" />}
          <button
            className="gdrive-dropdown-item"
            onClick={handleOpenFolder}
            disabled={!folderUrl}
            title={folderUrl ? 'Open Trading Analyzer folder' : 'Export first to create the folder'}
          >
            Open folder
          </button>
          <div className="gdrive-dropdown-sep" />
          <button className="gdrive-dropdown-item" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Replace `header-row1` in the analysis view to use `GDriveButton`**

Find the analysis-view `header-row1` block (around line 921 in `App.tsx`):

```tsx
          <div className="header-row1">
            <h1 className="title">Trading Analyzer</h1>
            <button
              className="icon-btn"
              aria-label="Settings"
              title="Settings"
              onClick={() => setView('settings')}
            >
              <GearIcon />
            </button>
          </div>
```

Replace it with:

```tsx
          <div className="header-row1">
            <h1 className="title">Trading Analyzer</h1>
            <div className="header-actions">
              {result && (
                <GDriveButton
                  result={result}
                  onError={showAnnotateError}
                />
              )}
              <button
                className="icon-btn"
                aria-label="Settings"
                title="Settings"
                onClick={() => setView('settings')}
              >
                <GearIcon />
              </button>
            </div>
          </div>
```

- [ ] **Step 3: Type-check the renderer**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Start the app and verify the button renders**

```bash
npm run dev
```

- Open the app. No button should appear until an analysis result is loaded (click Refresh).
- After loading a result, the Google Drive split button should appear between the title and the gear icon.
- Clicking the left side should open a browser sign-in flow (if credentials are configured) or show "Connect Drive" state.
- The `∨` chevron should open the dropdown with "Open folder" (disabled until first export) and "Sign out".
- After a successful export the button flashes "Opened ✓" for 2 s and the doc opens in the browser.
- Export errors show in the existing red toast at the bottom.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(gdrive): add GDriveButton split button component to header"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] OAuth2 PKCE with token storage in `userData/google-auth.json` — Task 3
- [x] Token refresh within 60s of expiry — Task 3
- [x] Sign-out + token revocation — Task 3 + Task 6
- [x] "Trading Analyzer" folder auto-create — Task 5
- [x] Folder ID cached in memory per session — Task 5
- [x] Drive multipart upload, HTML → Google Doc — Task 5
- [x] Document naming: `{SYMBOL} {TF}m — {VERDICT} — {YYYY-MM-DD HH:mm}` local time — Task 4
- [x] `webViewLink` opened via `shell.openExternal` — Task 5
- [x] `folderUrl` returned alongside `url` — Task 5 + Task 6
- [x] Split button in `header-row1`, hidden when `result === null` — Task 9
- [x] All button states (unauthenticated, idle, exporting, success, error) — Task 9
- [x] Dropdown: Open folder (disabled until first export), Sign out — Task 9
- [x] Error surfaced via existing toast system — Task 9
- [x] `preload.ts` updated — Task 7
- [x] `types.ts` updated — Task 2
- [x] `googleapis` installed — Task 1
- [x] `config/config.json` credentials block — Task 1

**No placeholders found.**

**Type consistency:** `GDriveStatus` defined in Task 2, used in preload (Task 7) and component (Task 9). `exportToDrive` returns `{ url: string; folderUrl: string }` consistently across types.ts (Task 2), google-drive.ts (Task 5), and preload.ts (Task 7). `IPC.GDRIVE_EXPORT / STATUS / SIGNOUT` defined in Task 2, used in Tasks 6 and 7.
