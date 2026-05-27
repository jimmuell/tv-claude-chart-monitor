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
