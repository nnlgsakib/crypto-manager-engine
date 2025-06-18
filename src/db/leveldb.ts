// src/db/leveldb.ts
import { Level } from "level";
import { LRUCache } from "lru-cache";
import { logger } from "../utils/logger";

export class Database {
  private db: Level<string, any>;
  private cache: LRUCache<string, any>;

  constructor(dbPath: string = "./data/db") {
    this.db = new Level<string, any>(dbPath, { valueEncoding: "json" });
    this.cache = new LRUCache<string, any>({
      max: 10000,
      ttl: 1000 * 60 * 5, // 5 minutes TTL for cache
    });
  }

  async get(key: string): Promise<any> {
    try {
      const cached = this.cache.get(key);
      if (cached) {
        logger.debug(`Cache hit for key: ${key}`);
        return cached;
      }
      const value = await this.db.get(key);
      this.cache.set(key, value);
      logger.debug(`Cache miss for key: ${key}, fetched from DB`);
      return value;
    } catch (err: any) {
      if (err.code === "LEVEL_NOT_FOUND") {
        return null;
      }
      logger.error(`DB get error for key ${key}: ${err.message}`);
      throw err;
    }
  }

  async put(key: string, value: any): Promise<void> {
    try {
      await this.db.put(key, value);
      this.cache.set(key, value);
      logger.debug(`Stored key: ${key}`);
    } catch (err: any) {
      logger.error(`DB put error for key ${key}: ${err.message}`);
      throw err;
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.db.del(key);
      this.cache.delete(key);
      logger.debug(`Deleted key: ${key}`);
    } catch (err: any) {
      logger.error(`DB delete error for key ${key}: ${err.message}`);
      throw err;
    }
  }

  async batch(operations: { type: "put" | "del"; key: string; value?: any }[]): Promise<void> {
    try {
      const batchOps = operations.map(op =>
        op.type === "put"
          ? { type: "put" as const, key: op.key, value: op.value }
          : { type: "del" as const, key: op.key }
      );
      await this.db.batch(batchOps);
      operations.forEach((op) => {
        if (op.type === "put") {
          this.cache.set(op.key, op.value);
        } else if (op.type === "del") {
          this.cache.delete(op.key);
        }
      });
      logger.debug(`Batch operation completed: ${operations.length} ops`);
    } catch (err: any) {
      logger.error(`DB batch error: ${err.message}`);
      throw err;
    }
  }

  async iterator(prefix: string): Promise<any[]> {
    const results: any[] = [];
    try {
      for await (const [key, value] of this.db.iterator({ gte: prefix, lte: prefix + "\uffff" })) {
        results.push({ key, value });
      }
      return results;
    } catch (err: any) {
      logger.error(`DB iterator error for prefix ${prefix}: ${err.message}`);
      throw err;
    }
  }
}

export const db = new Database();