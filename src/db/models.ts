// src/db/models.ts
import { db } from './leveldb';
import { logger } from '../utils/logger';
import { networks } from '../config/networks';

// Existing interfaces unchanged
export interface Account {
  username: string;
  address: string;
  encryptedPrivateKey: string;
  timestamp: number;
}

export interface Balance {
  username: string;
  blockchain: string;
  currency: string;
  amount: string;
  frozenAmount: string;
}

export interface Deposit {
  id: string;
  username: string;
  blockchain: string;
  currency: string;
  amount: string;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  status: 'pending' | 'confirming' | 'confirmed' | 'credited' | 'failed';
  confirmations: number;
  requiredConfirmations: number;
  timestamp: number;
  retries?: number;
}

export interface Withdrawal {
  id: string;
  username: string;
  blockchain: string;
  currency: string;
  amount: string;
  toAddress: string;
  status: 'created' | 'added_to_bucket' | 'processing' | 'completed' | 'failed';
  bucketId?: string;
  txHash?: string;
  timestamp: number;
}

export interface Bucket {
  id: string;
  blockchain: string;
  currency: string;
  createdAt: number;
  expiresAt: number;
  withdrawalIds: string[];
}

// New interface for block cache
export interface BlockCache {
  id: string; // Format: `${blockchain}:${blockNumber}`
  blockchain: string;
  blockNumber: number;
  blockData: any; // ethers.providers.BlockWithTransactions
  timestamp: number;
  expiresAt: number; // TTL for cache
}

// Existing AccountModel, BalanceModel, DepositModel, WithdrawalModel, BucketModel unchanged
export class AccountModel {
  static async create(account: Account): Promise<void> {
    await db.put(`account:${account.username}`, account);
  }

  static async findByUsername(username: string): Promise<Account | null> {
    return await db.get(`account:${username}`);
  }

  static async findByAddress(address: string): Promise<Account | null> {
    const accounts = await db.iterator('account:');
    return (
      accounts.find(
        a => a.value.address.toLowerCase() === address.toLowerCase()
      )?.value || null
    );
  }
}

export class BalanceModel {
  static async getBalance(
    username: string,
    blockchain: string,
    currency: string
  ): Promise<Balance> {
    const key = `balance:${username}:${blockchain}:${currency}`;
    const balance = await db.get(key);
    return (
      balance || {
        username,
        blockchain,
        currency,
        amount: '0.00',
        frozenAmount: '0.00',
      }
    );
  }

  static async updateBalance(balance: Balance): Promise<void> {
    const key = `balance:${balance.username}:${balance.blockchain}:${balance.currency}`;
    const parsedAmount = parseFloat(balance.amount);
    const parsedFrozenAmount = parseFloat(balance.frozenAmount);
    if (parsedAmount < 0) {
      throw new Error(
        `Negative amount not allowed for ${balance.username}: ${balance.amount} ${balance.currency}`
      );
    }
    if (parsedFrozenAmount < 0) {
      throw new Error(
        `Negative frozen amount not allowed for ${balance.username}: ${balance.frozenAmount} ${balance.currency}`
      );
    }
    await db.put(key, {
      ...balance,
      amount: parsedAmount.toFixed(2),
      frozenAmount: parsedFrozenAmount.toFixed(2),
    });
    logger.debug(
      `Updated balance for ${balance.username}: ${balance.amount} ${balance.currency}, frozen: ${balance.frozenAmount}`
    );
  }

  static async freezeBalance(
    username: string,
    blockchain: string,
    currency: string,
    amountToFreeze: string
  ): Promise<void> {
    const balance = await this.getBalance(username, blockchain, currency);
    const available = parseFloat(balance.amount);
    const frozen = parseFloat(balance.frozenAmount || '0.00');
    const amount = parseFloat(amountToFreeze);
    if (available < amount) {
      throw new Error(
        `Insufficient available balance to freeze: ${available} ${currency}, required: ${amount}`
      );
    }
    const newBalance: Balance = {
      username,
      blockchain,
      currency,
      amount: (available - amount).toFixed(2),
      frozenAmount: (frozen + amount).toFixed(2),
    };
    await this.updateBalance(newBalance);
    logger.info(
      `Froze ${amount} ${currency} for ${username}, new available: ${newBalance.amount}, frozen: ${newBalance.frozenAmount}`
    );
  }

  static async unfreezeBalance(
    username: string,
    blockchain: string,
    currency: string,
    amountToUnfreeze: string
  ): Promise<void> {
    const balance = await this.getBalance(username, blockchain, currency);
    const frozen = parseFloat(balance.frozenAmount || '0.00');
    const amount = parseFloat(amountToUnfreeze);
    if (frozen < amount) {
      logger.warn(
        `Attempt to unfreeze more than frozen: ${amount} ${currency}, frozen: ${frozen}`
      );
      return;
    }
    const newBalance: Balance = {
      username,
      blockchain,
      currency,
      amount: (parseFloat(balance.amount) + amount).toFixed(2),
      frozenAmount: (frozen - amount).toFixed(2),
    };
    await this.updateBalance(newBalance);
    logger.info(
      `Unfroze ${amount} ${currency} for ${username}, new available: ${newBalance.amount}, frozen: ${newBalance.frozenAmount}`
    );
  }

  static async getAllBalances(
    username: string
  ): Promise<
    Record<string, Record<string, { amount: string; frozenAmount: string }>>
  > {
    const balances = await db.iterator(`balance:${username}:`);
    const result: Record<
      string,
      Record<string, { amount: string; frozenAmount: string }>
    > = {};

    for (const [blockchain, config] of Object.entries(networks)) {
      result[blockchain] = {
        [config.nativeCurrency]: { amount: '0.00', frozenAmount: '0.00' },
      };
      for (const [tokenName] of Object.entries(config.erc20Tokens)) {
        result[blockchain][tokenName] = {
          amount: '0.00',
          frozenAmount: '0.00',
        };
      }
    }

    for (const { value } of balances) {
      const balance: Balance = value;
      if (!result[balance.blockchain]) {
        result[balance.blockchain] = {};
      }
      result[balance.blockchain][balance.currency] = {
        amount: balance.amount,
        frozenAmount: balance.frozenAmount || '0.00',
      };
    }

    return result;
  }
}

export class DepositModel {
  static async create(deposit: Deposit): Promise<void> {
    await db.put(`deposit:${deposit.id}`, deposit);
  }

  static async update(deposit: Deposit): Promise<void> {
    await db.put(`deposit:${deposit.id}`, deposit);
  }

  static async findById(id: string): Promise<Deposit | null> {
    return await db.get(`deposit:${id}`);
  }

  static async getAllByUsername(
    username: string,
    options: { page: number; limit: number; status?: string }
  ): Promise<Deposit[]> {
    const deposits = await db.iterator(`deposit:`);
    let filtered = deposits
      .map(d => d.value as Deposit)
      .filter(
        d =>
          d.username === username &&
          (!options.status || d.status === options.status)
      )
      .sort((a, b) => b.timestamp - a.timestamp);
    const start = (options.page - 1) * options.limit;
    return filtered.slice(start, start + options.limit);
  }
}

export class WithdrawalModel {
  static async create(withdrawal: Withdrawal): Promise<void> {
    await db.put(`withdrawal:${withdrawal.id}`, withdrawal);
  }

  static async update(withdrawal: Withdrawal): Promise<void> {
    await db.put(`withdrawal:${withdrawal.id}`, withdrawal);
  }

  static async findById(id: string): Promise<Withdrawal | null> {
    return await db.get(`withdrawal:${id}`);
  }

  static async getAllByUsername(
    username: string,
    options: { page: number; limit: number; status?: string }
  ): Promise<Withdrawal[]> {
    const withdrawals = await db.iterator(`withdrawal:`);
    let filtered = withdrawals
      .map(w => w.value as Withdrawal)
      .filter(
        w =>
          w.username === username &&
          (!options.status || w.status === options.status)
      )
      .sort((a, b) => b.timestamp - a.timestamp);
    const start = (options.page - 1) * options.limit;
    return filtered.slice(start, start + options.limit);
  }
}

export class BucketModel {
  static async create(bucket: Bucket): Promise<void> {
    await db.put(`bucket:${bucket.id}`, bucket);
  }

  static async update(bucket: Bucket): Promise<void> {
    await db.put(`bucket:${bucket.id}`, bucket);
  }

  static async findById(id: string): Promise<Bucket | null> {
    return await db.get(`bucket:${id}`);
  }

  static async getActiveBuckets(): Promise<Bucket[]> {
    const buckets = await db.iterator(`bucket:`);
    return buckets
      .map(b => b.value as Bucket)
      .filter(b => b.expiresAt > Date.now());
  }
}

// New BlockCacheModel
export class BlockCacheModel {
  static async create(blockCache: BlockCache): Promise<void> {
    await db.put(`blockCache:${blockCache.id}`, blockCache);
    logger.debug(`Cached block ${blockCache.id}`);
  }

  static async findById(id: string): Promise<BlockCache | null> {
    return await db.get(`blockCache:${id}`);
  }

  static async getByBlockchain(blockchain: string): Promise<BlockCache[]> {
    const blocks = await db.iterator(`blockCache:${blockchain}:`);
    return blocks
      .map(b => b.value as BlockCache)
      .filter(b => b.expiresAt > Date.now())
      .sort((a, b) => a.blockNumber - b.blockNumber);
  }

  static async delete(id: string): Promise<void> {
    await db.del(`blockCache:${id}`);
    logger.debug(`Deleted cached block ${id}`);
  }

  static async cleanupExpired(blockchain: string): Promise<void> {
    const blocks = await db.iterator(`blockCache:${blockchain}:`);
    const now = Date.now();
    const ops = blocks
      .map(b => b.value as BlockCache)
      .filter(b => b.expiresAt <= now)
      .map(b => ({ type: 'del' as const, key: `blockCache:${b.id}` }));
    if (ops.length > 0) {
      await db.batch(ops);
      logger.info(`Cleaned up ${ops.length} expired blocks for ${blockchain}`);
    }
  }
}
