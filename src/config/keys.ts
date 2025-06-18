// src/config/keys.ts
import fs from 'fs';
import path from 'path';
import toml from '@iarna/toml';

const CONFIG_FILE = './config.toml';
const configPath = path.resolve(__dirname, CONFIG_FILE);

// 1. Ensure file exists
if (!fs.existsSync(configPath)) {
  throw new Error(`❌ Missing config file at: ${configPath}`);
}

// 2. Read + parse TOML config
let parsed: any;
try {
  const raw = fs.readFileSync(configPath, 'utf-8');
  parsed = toml.parse(raw);
} catch (err) {
  throw new Error(`❌ Failed to parse TOML: ${(err as Error).message}`);
}

// 3. Extract keys from [wallet] section
const wallet = parsed.wallet ?? {};
const {
  encryption_key: encryptionKey,
  hot_wallet_key: hotWalletKey,
  hot_wallet_address: hotWalletAddress,
} = wallet;

// 4. Validate keys
for (const [keyName, value] of Object.entries({
  encryptionKey,
  hotWalletKey,
  hotWalletAddress,
})) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`❌ Invalid or missing [wallet].${keyName} in config.toml`);
  }
}

// 5. Export keys
const keys = {
  encryptionKey,
  hot_wallet_key: hotWalletKey,
  hot_wallet_address: hotWalletAddress,
};

export default keys;
