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
  feePerContract:        1.24,
  feeLiquidationDaily:   2.50,
  feeDataMonthly:        45.00,
  feeTradingDays:        21,
  subtractCommissions:   false,
  pnlVisible:            true,
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
