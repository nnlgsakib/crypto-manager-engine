// src/blockchain/indexer.ts
import { ethers } from "ethers";
import { networks } from "../config/networks";
import { db } from "../db/leveldb";
import { AccountModel, DepositModel, BalanceModel, Balance, Deposit } from "../db/models";
import { logger } from "../utils/logger";
import { TransactionService } from "./transaction";
import { WebSocket as _ws } from "ws";

export class IndexerService {
  private providers: Record<string, ethers.providers.WebSocketProvider> = {};
  private httpProviders: Record<string, ethers.providers.JsonRpcProvider> = {};
  private erc20Contracts: Record<string, Record<string, ethers.Contract>> = {};
  private activeAddresses: Set<string> = new Set();
  private processedTransactions: Set<string> = new Set();
  private pendingQueues: Map<string, Set<string>> = new Map(); // Per chain-currency queue
  private reconnectionAttempts: Record<string, number> = {};
  private hotWalletAddress: string = TransactionService.getHotWalletAddress().toLowerCase();
  private readonly MAX_RETRIES = 3;
  private readonly PROCESS_INTERVAL_MS = 1000;

  constructor() {
    this.initializeProviders();
    this.initialize();
  }

  private initializeProviders() {
    for (const [network, netConfig] of Object.entries(networks)) {
      this.setupWebSocketProvider(network, netConfig.rpcUrl);
      this.httpProviders[network] = new ethers.providers.JsonRpcProvider(netConfig.httpRpcUrl);
      this.erc20Contracts[network] = {};
      for (const [tokenName, token] of Object.entries(netConfig.erc20Tokens)) {
        this.erc20Contracts[network][tokenName] = new ethers.Contract(
          token.address,
          ["event Transfer(address indexed from, address indexed to, uint256 value)"],
          this.providers[network]
        );
        this.pendingQueues.set(`${network}:${tokenName}`, new Set());
      }
      this.pendingQueues.set(`${network}:${netConfig.nativeCurrency}`, new Set());
    }
  }

  private setupWebSocketProvider(network: string, wsUrl: string) {
    const ws = new _ws(wsUrl);
    const provider = new ethers.providers.WebSocketProvider(ws);
    this.providers[network] = provider;
    this.reconnectionAttempts[network] = 0;
    const maxReconnectAttempts = 5;
    const reconnectDelayBase = 5000;

    ws.on("close", async () => {
      if (this.reconnectionAttempts[network] >= maxReconnectAttempts) {
        logger.error(`Max reconnection attempts reached for ${network}.`);
        return;
      }
      this.reconnectionAttempts[network]++;
      logger.warn(`WebSocket for ${network} disconnected. Reconnecting (${this.reconnectionAttempts[network]}/${maxReconnectAttempts})...`);
      const delay = reconnectDelayBase * Math.pow(2, this.reconnectionAttempts[network] - 1);
      setTimeout(() => {
        const newProvider = new ethers.providers.WebSocketProvider(wsUrl);
        this.providers[network] = newProvider;
        this.reconnectionAttempts[network] = 0;
        logger.info(`Reconnected WebSocket for ${network}`);
        for (const [tokenName, contract] of Object.entries(this.erc20Contracts[network])) {
          contract.removeAllListeners();
          this.setupErc20Listeners(network, tokenName, contract);
        }
        this.setupBlockListener(network);
      }, delay);
    });

    ws.on("error", (error: any) => {
      logger.error(`WebSocket error for ${network}: ${error.message}`);
    });

    this.setupBlockListener(network);
  }

  private setupBlockListener(network: string) {
    const provider = this.providers[network];
    provider.on("block", async (blockNumber: number) => {
      try {
        const block = await provider.getBlockWithTransactions(blockNumber);
        const nativeCurrency = networks[network].nativeCurrency;
        const promises: Promise<void>[] = [];
        for (const tx of block.transactions) {
          if (
            tx.to &&
            tx.from &&
            this.activeAddresses.has(tx.to.toLowerCase()) &&
            tx.from.toLowerCase() !== this.hotWalletAddress &&
            !this.processedTransactions.has(tx.hash) &&
            !this.pendingQueues.get(`${network}:${nativeCurrency}`)!.has(tx.hash)
          ) {
            const account = await AccountModel.findByAddress(tx.to);
            if (account && nativeCurrency) {
              promises.push(this.queueTransaction(tx, blockNumber, network, tx.to));
            }
          }
        }
        await Promise.all(promises);
      } catch (err: any) {
        logger.error(`Error processing block ${blockNumber} on ${network}: ${err.message}`);
      }
    });
  }

  private setupErc20Listeners(network: string, tokenName: string, contract: ethers.Contract) {
    contract.on("Transfer", async (from: string, to: string, value: ethers.BigNumber, event: ethers.Event) => {
      try {
        const toAddress = to.toLowerCase();
        const txHash = event.transactionHash;
        const blockNumber = event.blockNumber;

        if (
          this.activeAddresses.has(toAddress) &&
          !this.processedTransactions.has(txHash) &&
          !this.pendingQueues.get(`${network}:${tokenName}`)!.has(txHash)
        ) {
          const account = await AccountModel.findByAddress(toAddress);
          if (account && networks[network].erc20Tokens[tokenName]) {
            const tx = await this.providers[network].getTransaction(txHash);
            if (tx) {
              await this.queueTransaction(tx, blockNumber!, network, toAddress, value, tokenName);
            }
          }
        }
      } catch (err: any) {
        logger.error(`Error processing ERC-20 Transfer ${event.transactionHash || "unknown"} on ${network}:${tokenName}: ${err.message}`);
      }
    });
  }

  async initialize() {
    const accounts = await db.iterator("account:");
    accounts.forEach((a) => this.activeAddresses.add(a.value.address.toLowerCase()));
    logger.info(`Loaded ${accounts.length} active addresses`);

    for (const [network, tokens] of Object.entries(this.erc20Contracts)) {
      for (const [tokenName, contract] of Object.entries(tokens)) {
        this.setupErc20Listeners(network, tokenName, contract);
      }
    }

    // Start workers for each chain-currency pair
    for (const queueKey of this.pendingQueues.keys()) {
      this.startQueueWorker(queueKey);
    }

    logger.info("Indexer initialized");
  }

  private async queueTransaction(
    tx: ethers.providers.TransactionResponse,
    blockNumber: number,
    network: string,
    toAddress: string,
    erc20Value?: ethers.BigNumber,
    currency?: string
  ) {
    const account = await AccountModel.findByAddress(toAddress);
    if (!account) {
      return;
    }

    const networkConfig = networks[network];
    const isNative = !currency;
    const currencyName = isNative ? networkConfig.nativeCurrency : currency!;
    const decimals = isNative ? 18 : networkConfig.erc20Tokens[currencyName].decimals;
    const minDeposit = isNative
      ? parseFloat(networkConfig.min_deposit || "0")
      : parseFloat(networkConfig.erc20Tokens[currencyName].min_deposit || "0");
    const amount = isNative
      ? parseFloat(ethers.utils.formatEther(tx.value))
      : parseFloat(ethers.utils.formatUnits(erc20Value!, decimals));

    if (amount < minDeposit) {
      return;
    }

    const deposit: Deposit = {
      id: tx.hash,
      username: account.username,
      blockchain: network,
      currency: currencyName,
      amount: amount.toFixed(2),
      txHash: tx.hash,
      fromAddress: tx.from,
      toAddress,
      status: "pending",
      confirmations: 1,
      requiredConfirmations: networkConfig.requiredConfirmations,
      timestamp: Date.now(),
    };

    await DepositModel.create(deposit);
    const queueKey = `${network}:${currencyName}`;
    this.pendingQueues.get(queueKey)!.add(tx.hash);
    await db.put(`depositStartBlock:${tx.hash}`, blockNumber.toString());
    logger.info(`Queued deposit ${tx.hash} for ${account.username} (${amount} ${currencyName}) on ${network}`);
  }

  private startQueueWorker(queueKey: string) {
    const [network, currency] = queueKey.split(":");
    setInterval(async () => {
      const queue = this.pendingQueues.get(queueKey)!;
      if (queue.size === 0) {
        return;
      }

      const txHashes = Array.from(queue);
      for (const txHash of txHashes) {
        await this.processDeposit(txHash, network, currency);
      }
    }, this.PROCESS_INTERVAL_MS);
  }

  private async processDeposit(txHash: string, network: string, currency: string) {
    let retries = 0;
    const queueKey = `${network}:${currency}`;
    const queue = this.pendingQueues.get(queueKey)!;

    while (retries <= this.MAX_RETRIES) {
      try {
        const deposit = await DepositModel.findById(txHash);
        if (!deposit) {
          queue.delete(txHash);
          this.processedTransactions.add(txHash);
          await db.del(`depositStartBlock:${txHash}`);
          return;
        }

        const networkConfig = networks[network];
        const provider = this.providers[network];
        const currentBlock = await provider.getBlockNumber();
        const startBlock = parseInt(await db.get(`depositStartBlock:${txHash}`), 10);
        const confirmations = currentBlock - startBlock + 1;

        if (confirmations >= networkConfig.requiredConfirmations && deposit.status !== "confirmed") {
          deposit.status = "confirmed";
          deposit.confirmations = confirmations;
          await DepositModel.update(deposit);

          await TransactionService.transferToHotWallet(deposit, this.httpProviders[network]);
          deposit.status = "credited";

          const balance = await BalanceModel.getBalance(deposit.username, deposit.blockchain, deposit.currency);
          const currentAmount = parseFloat(balance.amount) || 0;
          const depositAmount = parseFloat(deposit.amount);
          const newBalance: Balance = {
            username: deposit.username,
            blockchain: deposit.blockchain,
            currency: deposit.currency,
            amount: (currentAmount + depositAmount).toFixed(2),
            frozenAmount: parseFloat(balance.frozenAmount || "0").toFixed(2),
          };
          await BalanceModel.updateBalance(newBalance);
          await DepositModel.update(deposit);
          logger.info(`Credited ${deposit.amount} ${deposit.currency} to ${deposit.username}, new balance: ${newBalance.amount} on ${network}`);
        } else if (confirmations !== deposit.confirmations) {
          deposit.confirmations = Math.min(confirmations, networkConfig.requiredConfirmations);
          deposit.status = "confirming";
          await DepositModel.update(deposit);
        }

        if (deposit.status === "credited" || deposit.status === "failed") {
          queue.delete(txHash);
          this.processedTransactions.add(txHash);
          await db.del(`depositStartBlock:${txHash}`);
        }
        return;
      } catch (err: any) {
        retries++;
        if (retries > this.MAX_RETRIES) {
          const deposit = await DepositModel.findById(txHash);
          if (deposit) {
            deposit.status = "failed";
            await DepositModel.update(deposit);
            logger.error(`Failed deposit ${txHash} on ${network}:${currency} after ${retries} retries: ${err.message}`);
          }
          queue.delete(txHash);
          this.processedTransactions.add(txHash);
          await db.del(`depositStartBlock:${txHash}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000 * retries));
      }
    }
  }

  addActiveAddress(address: string) {
    this.activeAddresses.add(address.toLowerCase());
  }
}

export const indexerService = new IndexerService();