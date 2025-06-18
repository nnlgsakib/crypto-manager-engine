// src/blockchain/wallet.ts
import { ethers } from 'ethers';
import { createHash } from 'crypto';
import { encrypt, decrypt } from '../utils/encryption';
import { AccountModel } from '../db/models';
import { logger } from '../utils/logger';
import { indexerService } from './indexer';

export class WalletService {
  static async generateAccount(
    username: string
  ): Promise<{ username: string; address: string; timestamp: number }> {
    try {
      // Check if account already exists
      const existingAccount = await AccountModel.findByUsername(username);
      if (existingAccount) {
        logger.info(
          `Account already exists for ${username}: ${existingAccount.address}`
        );
        return {
          username: existingAccount.username,
          address: existingAccount.address,
          timestamp: existingAccount.timestamp,
        };
      }

      // Generate SHA-256 hash of username
      const hash = createHash('sha256').update(username).digest('hex');
      // Convert hash to a valid byte array for extraEntropy
      const entropy = ethers.utils.arrayify(`0x${hash}`);

      // Generate wallet with extraEntropy
      const wallet = ethers.Wallet.createRandom({ extraEntropy: entropy });
      const encryptedPrivateKey = await encrypt(wallet.privateKey);

      const account = {
        username,
        address: wallet.address,
        encryptedPrivateKey,
        timestamp: Date.now(),
      };

      await AccountModel.create(account);
      indexerService.addActiveAddress(wallet.address);
      logger.info(`Generated new account for ${username}: ${wallet.address}`);

      return {
        username,
        address: wallet.address,
        timestamp: account.timestamp,
      };
    } catch (err: any) {
      logger.error(`Error generating account for ${username}: ${err.message}`);
      throw err;
    }
  }

  static async getPrivateKey(username: string): Promise<string> {
    const account = await AccountModel.findByUsername(username);
    if (!account) {
      throw new Error('Account not found');
    }
    return await decrypt(account.encryptedPrivateKey);
  }
}
