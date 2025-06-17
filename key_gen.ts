// generate-key.ts
import { randomBytes } from 'crypto';

function generateEncryptionKey(): string {
  // Generate 32 random bytes
  const key = randomBytes(32);
  // Convert to hexadecimal string (64 characters)
  const hexKey = key.toString('hex');
  console.log('Generated Encryption Key:', hexKey);
  console.log('Key Length (bytes):', key.length);
  return hexKey;
}

generateEncryptionKey();