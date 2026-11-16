import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { AppSettings } from '../shared/types';

const DEFAULTS: AppSettings = {
  autoDraw:              false,
  autoRefresh:           true,
  persistLevels:         false,
  notifications:         true,
  autoTrade:             false,
  autoTradeTestMode:     false,
  autoTradeStopDollars:   15.00,
  autoTradeTargetDollars: 30.00,
  autoTradeTrailingStop:  false,
  tradeSession:          'number',
  cdpPort:               9222,
  lineThickness:         2,
  labelSize:             'large',
  apiKeyOverride:        '',
  // Renamed from feePerContract (which meant $/round-trip) so a stale settings.json
  // cannot silently keep charging the old 1.24 against the new per-side model.
  feePerContractSide:    0.60,
  feeLiquidationDaily:   0,
  feeDataMonthly:        0,
  feeTradingDays:        21,
  subtractCommissions:   false,
  pnlVisible:            true,
  orderImportEnabled:      true,
  orderImportFolder:       '',   // '' resolves to ~/Downloads
  orderImportStaleMinutes: 30,
  liveFeedEnabled:         true,
  liveFeedPollSeconds:     5,
  paperMode:               false,
  prevDayBalance:          null,
  // Default lever: the 08:30-11:00 Chicago window only, nothing blocked.
  rules: {
    enabled:          true,
    blockedSetupKeys: [],
    minConfidence:    0,
    windowStart:      '08:30',
    windowEnd:        '11:00',
  },
};
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

let current: AppSettings = { ...DEFAULTS };

export function loadSettings(): AppSettings {
  try {
    current = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) };
  } catch {
    current = { ...DEFAULTS };
  }
  return current;
}

export function saveSettings(settings: AppSettings): void {
  try {
    current = { ...DEFAULTS, ...settings };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(current), { mode: 0o600 });
  } catch { /* ignore */ }
}

export function getSettings(): AppSettings {
  return current;
}
