import { app, shell } from 'electron';
import { google } from 'googleapis';
import { CodeChallengeMethod } from 'google-auth-library';
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
  google: { clientIdEnv: string; clientSecretEnv: string };
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
  const clientId     = process.env[cfg.google.clientIdEnv] ?? '';
  const clientSecret = process.env[cfg.google.clientSecretEnv] ?? '';
  if (!clientId || !clientSecret) {
    throw new Error(
      `Google OAuth credentials not set. Set ${cfg.google.clientIdEnv} and ${cfg.google.clientSecretEnv} in your environment.`
    );
  }

  const port = await findFreePort();
  const redirectUri = `http://localhost:${port}/callback`;
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const verifier  = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const authUrl = client.generateAuthUrl({
    access_type:           'offline',
    scope:                 SCOPES,
    code_challenge:        challenge,
    code_challenge_method: CodeChallengeMethod.S256,
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

  const clientId     = process.env[cfg.google.clientIdEnv] ?? '';
  const clientSecret = process.env[cfg.google.clientSecretEnv] ?? '';
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
      const clientId     = process.env[cfg.google.clientIdEnv] ?? '';
      const clientSecret = process.env[cfg.google.clientSecretEnv] ?? '';
      const client = new google.auth.OAuth2(clientId, clientSecret);
      client.setCredentials({ access_token: t.access_token });
      await client.revokeCredentials();
    } catch { /* best effort */ }
  }
  clearTokens();
}
