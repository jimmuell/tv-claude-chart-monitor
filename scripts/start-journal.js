#!/usr/bin/env node
'use strict';

require('dotenv/config');
const path = require('path');
const os   = require('os');

// Database lives in Electron's userData directory (same path the app uses)
const userDataPath = process.env.JOURNAL_DB_PATH ||
  path.join(os.homedir(), 'Library', 'Application Support', 'trading-analyzer');

const { TradeStore }       = require('../dist/main/trade-store');
const { startJournalServer } = require('../dist/main/journal-server');

const store    = new TradeStore(userDataPath);
const getApiKey = () => process.env.ANTHROPIC_API_KEY || '';

startJournalServer(store, getApiKey);
