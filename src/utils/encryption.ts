// src/utils/encryption.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { logger } from './logger';
import keys from '../config/keys';

const ALGORITHM = 'aes-256-cbc';
const KEY = Buffer.from(keys.encryptionKey, 'hex');
const IV_LENGTH = 16;

export async function encrypt(text: string): Promise<string> {
  try {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (err: any) {
    logger.error(`Encryption error: ${err.message}`);
    throw err;
  }
}

export async function decrypt(encryptedText: string): Promise<string> {
  try {
    const [ivHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err: any) {
    logger.error(`Decryption error: ${err.message}`);
    throw err;
  }
}
