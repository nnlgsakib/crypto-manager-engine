// src/blockchain/indexer.ts
import { ethers } from "ethers";
import { networks } from "../config/networks";
import { db } from "../db/leveldb";
import { AccountModel, DepositModel, BalanceModel, Balance, Deposit, BlockCacheModel, BlockCache } from "../db/models";
import { logger } from "../utils/logger";
import { TransactionService } from "./transaction";
import { WebSocket as _ws } from "ws";
import { WebSocketService } from "../services/websocket";

export class IndexerService {
 private wsProviders: Record<string, ethers.providers.WebSocketProvider> = {};
 private httpProviders: Record<string, ethers.providers.JsonRpcProvider> = {};
 private erc20Contracts: Record<string, Record<string, ethers.Contract>> = {};
 private activeAddresses: Set<string> = new Set();
 private processedTransactions: Set<string> = new Set();
 private pendingQueues: Map<string, Set<string>> = new Map();
 private processingTxs: Set<string> = new Set();
 private reconnectionAttempts: Record<string, number> = {};
 private readonly MAX_RETRIES = 3;
 private readonly PROCESS_INTERVAL_MS = 1000;
 private readonly BLOCK_CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour TTL
 private readonly POLLING_INTERVAL_MS = 5000; // 5 seconds for HTTP fallback
 private readonly RECOVERY_LOOKBACK_BLOCKS = 1000; // Look back 1000 blocks
 private readonly RECOVERY_INTERVAL_MS = 1000 * 60 * 5; // Every 5 minutes
 private readonly WS_RECONNECT_DELAY_BASE = 3000;

 constructor() {
 this.initializeProviders();
 this.initialize();
 }

 private initializeProviders() {
 for (const [network, netConfig] of Object.entries(networks)) {
 this.setupWebSocketProvider(network, netConfig.rpcUrl);
 this.httpProviders[network] = new ethers.providers.JsonRpcProvider({
 url: netConfig.httpRpcUrl,
 timeout: 10000,
 });
 this.erc20Contracts[network] = {};
 for (const [tokenName, token] of Object.entries(netConfig.erc20Tokens)) {
 const provider = this.wsProviders[network] || this.httpProviders[network];
 this.erc20Contracts[network][tokenName] = new ethers.Contract(
 token.address,
 ["event Transfer(address indexed from, address indexed to, uint256 value)"],
 provider
 );
 this.pendingQueues.set(`${network}:${tokenName}`, new Set());
 }
 this.pendingQueues.set(`${network}:${netConfig.nativeCurrency}`, new Set());
 }
 }

 private setupWebSocketProvider(network: string, wsUrl: string) {
 try {
 const ws = new _ws(wsUrl, { timeout: 10000 });
 const provider = new ethers.providers.WebSocketProvider(ws, networks[network].chainId);
 this.wsProviders[network] = provider;
 this.reconnectionAttempts[network] = 0;
 const maxReconnectAttempts = 5;

 ws.on("open", () => {
 logger.info(`WebSocket connected for ${network} at ${wsUrl}`);
 this.reconnectionAttempts[network] = 0;
 this.verifyNetwork(network);
 // Reinitialize ERC-20 listeners on reconnect
 for (const [tokenName, contract] of Object.entries(this.erc20Contracts[network])) {
 contract.removeAllListeners();
 this.setupErc20Listeners(network, tokenName, contract);
 }
 });

 ws.on("close", () => {
 if (this.reconnectionAttempts[network] >= maxReconnectAttempts) {
 logger.error(`Max reconnection attempts reached for ${network}. Using HTTP polling for indexing fallback.`);
 this.startHttpPolling(network);
 return;
 }
 this.reconnectionAttempts[network]++;
 logger.warn(
 `WebSocket for ${network} disconnected. Reconnecting (${this.reconnectionAttempts[network]}/${maxReconnectAttempts})...`
 );
 const delay = this.WS_RECONNECT_DELAY_BASE * Math.pow(2, this.reconnectionAttempts[network] - 1);
 setTimeout(() => this.setupWebSocketProvider(network, wsUrl), delay);
 });

 ws.on("error", (error: any) => {
 logger.error(`WebSocket error for ${network}: ${error.message}`);
 });

 this.setupBlockListener(network);
 } catch (err: any) {
 logger.error(`Failed to initialize WebSocket for ${network}: ${err.message}. Using HTTP polling for indexing fallback.`);
 this.startHttpPolling(network);
 }
 }

 private async verifyNetwork(network: string) {
 try {
 const chainId = await this.wsProviders[network].getNetwork().then((n) => n.chainId);
 if (chainId !== networks[network].chainId) {
 logger.error(`Chain ID mismatch for ${network}: expected ${networks[network].chainId}, got ${chainId}`);
 } else {
 logger.info(`Chain ID verified for ${network}: ${chainId}`);
 }
 } catch (err: any) {
 logger.error(`Failed to verify chain ID for ${network}: ${err.message}`);
 }
 }

 private startHttpPolling(network: string) {
 logger.info(`Starting HTTP polling for ${network} as indexing fallback`);
 let lastBlockNumber = 0;
 setInterval(async () => {
 try {
 if (this.wsProviders[network] && this.wsProviders[network]._websocket.readyState === _ws.OPEN) {
 return;
 }
 const currentBlock = await this.httpProviders[network].getBlockNumber();
 if (currentBlock > lastBlockNumber) {
 for (let blockNumber = lastBlockNumber + 1; blockNumber <= currentBlock; blockNumber++) {
 await this.processBlock(network, blockNumber, false);
 logger.debug(`Processed block ${blockNumber} via HTTP polling for ${network}`);
 }
 lastBlockNumber = currentBlock;
 }
 } catch (err: any) {
 logger.error(`HTTP polling error for ${network}: ${err.message}`);
 }
 }, this.POLLING_INTERVAL_MS);
 }

 private async setupBlockListener(network: string) {
 const provider = this.wsProviders[network];
 if (!provider) {
 logger.warn(`No WebSocket provider for ${network}. Relying on HTTP polling for indexing.`);
 return;
 }
 provider.on("block", async (blockNumber: number) => {
 try {
 logger.debug(`Received block ${blockNumber} for ${network} via WebSocket`);
 await this.processBlock(network, blockNumber, true);
 } catch (err: any) {
 logger.error(`Error processing block ${blockNumber} on ${network}: ${err.message}`);
 }
 });
 }

 private async processBlock(network: string, blockNumber: number, useWebSocket: boolean) {
 const provider = useWebSocket && this.wsProviders[network] ? this.wsProviders[network] : this.httpProviders[network];
 try {
 const block = await provider.getBlockWithTransactions(blockNumber);
 const blockCache: BlockCache = {
 id: `${network}:${blockNumber}`,
 blockchain: network,
 blockNumber,
 blockData: block,
 timestamp: Date.now(),
 expiresAt: Date.now() + this.BLOCK_CACHE_TTL_MS,
 };
 await BlockCacheModel.create(blockCache);
 await db.put(`lastProcessedBlock:${network}`, blockNumber.toString());
 logger.debug(`Cached and processed block ${blockNumber} for ${network} using ${useWebSocket ? "WebSocket" : "HTTP"}`);
 } catch (err: any) {
 logger.error(`Failed to process block ${blockNumber} for ${network}: ${err.message}`);
 }
 }

 private setupErc20Listeners(network: string, tokenName: string, contract: ethers.Contract) {
 logger.debug(`Setting up ERC-20 listener for ${tokenName} on ${network}`);
 contract.on("Transfer", async (from: string, to: string, value: ethers.BigNumber, event: ethers.Event) => {
 try {
 const toAddress = to.toLowerCase();
 const txHash = event.transactionHash;
 const blockNumber = event.blockNumber;

 logger.debug(`Detected Transfer event for ${tokenName} on ${network}: ${txHash} to ${toAddress}`);
 if (
 this.activeAddresses.has(toAddress) &&
 !this.processedTransactions.has(txHash) &&
 !this.pendingQueues.get(`${network}:${tokenName}`)!.has(txHash) &&
 !TransactionService.isGasFundingTx(txHash)
 ) {
 const account = await AccountModel.findByAddress(toAddress);
 if (account && networks[network].erc20Tokens[tokenName]) {
 const provider = this.wsProviders[network] || this.httpProviders[network];
 const tx = await provider.getTransaction(txHash);
 if (tx) {
 await this.queueTransaction(tx, blockNumber, network, toAddress, value, tokenName);
 logger.info(`Queued ERC-20 deposit ${txHash} for ${account.username} (${tokenName}) on ${network}`);
 } else {
 logger.warn(`Transaction ${txHash} not found for ${tokenName} deposit to ${toAddress}`);
 }
 } else {
 logger.debug(`No account or token config for ${toAddress} or ${tokenName} on ${network}`);
 }
 }
 } catch (err: any) {
 logger.error(`Error processing ERC-20 Transfer ${event.transactionHash || "unknown"} on ${network}:${tokenName}: ${err.message}`);
 }
 });
 }

 async initialize() {
 const accounts = await db.iterator("account:");
 accounts.forEach((a) => {
 this.activeAddresses.add(a.value.address.toLowerCase());
 logger.debug(`Added account address ${a.value.address} for user ${a.value.username}`);
 });
 logger.info(`Loaded ${accounts.length} active addresses: ${Array.from(this.activeAddresses).join(", ")}`);

 for (const [network, tokens] of Object.entries(this.erc20Contracts)) {
 for (const [tokenName, contract] of Object.entries(tokens)) {
 this.setupErc20Listeners(network, tokenName, contract);
 }
 }

 for (const queueKey of this.pendingQueues.keys()) {
 this.startQueueWorker(queueKey);
 }

 for (const network of Object.keys(networks)) {
 this.startBlockProcessor(network);
 this.startBlockCleanup(network);
 this.startBlockRecovery(network);
 }

 logger.info("Indexer initialized");
 }

 private async startBlockRecovery(network: string) {
 setInterval(async () => {
 try {
 const provider = this.wsProviders[network] || this.httpProviders[network];
 const currentBlock = await provider.getBlockNumber();
 const lastProcessedBlock = parseInt((await db.get(`lastProcessedBlock:${network}`)) || "0", 10);
 const startBlock = Math.max(lastProcessedBlock - this.RECOVERY_LOOKBACK_BLOCKS, 0);
 if (currentBlock <= lastProcessedBlock) {
 logger.debug(`No new blocks to recover for ${network}: current=${currentBlock}, lastProcessed=${lastProcessedBlock}`);
 return;
 }

 logger.info(`Recovering blocks ${startBlock} to ${currentBlock} for ${network}`);
 for (let i = startBlock; i <= currentBlock; i++) {
 if (!(await BlockCacheModel.findById(`${network}:${i}`))) {
 await this.processBlock(network, i, !!this.wsProviders[network]);
 logger.debug(`Recovered block ${i} for ${network}`);
 }
 }
 } catch (err: any) {
 logger.error(`Error during block recovery for ${network}: ${err.message}`);
 }
 }, this.RECOVERY_INTERVAL_MS);
 }

 private async startBlockProcessor(network: string) {
 setInterval(async () => {
 try {
 const blocks = await BlockCacheModel.getByBlockchain(network);
 const provider = this.wsProviders[network] || this.httpProviders[network];
 const currentBlock = await provider.getBlockNumber();
 const networkConfig = networks[network];
 const nativeCurrency = networkConfig.nativeCurrency;

 for (const blockCache of blocks) {
 if (blockCache.blockNumber > currentBlock - networkConfig.requiredConfirmations) {
 continue;
 }

 const block = blockCache.blockData;
 const promises: Promise<void>[] = [];

 for (const tx of block.transactions) {
 if (
 tx.to &&
 tx.from &&
 this.activeAddresses.has(tx.to.toLowerCase()) &&
 !this.processedTransactions.has(tx.hash) &&
 !this.pendingQueues.get(`${network}:${nativeCurrency}`)!.has(tx.hash) &&
 !TransactionService.isGasFundingTx(tx.hash) &&
 tx.data === "0x" // Native transfer
 ) {
 const account = await AccountModel.findByAddress(tx.to);
 if (account && nativeCurrency) {
 logger.debug(`Detected native deposit ${tx.hash} to ${tx.to} on ${network}`);
 promises.push(this.queueTransaction(tx, blockCache.blockNumber, network, tx.to));
 }
 }
 }

 await Promise.all(promises);
 await BlockCacheModel.delete(blockCache.id);
 logger.debug(`Processed and deleted block cache ${blockCache.blockNumber} for ${network}`);
 }
 } catch (err: any) {
 logger.error(`Error processing blocks for ${network}: ${err.message}`);
 }
 }, this.PROCESS_INTERVAL_MS);
 }

 private async startBlockCleanup(network: string) {
 setInterval(async () => {
 try {
 await BlockCacheModel.cleanupExpired(network);
 logger.debug(`Cleaned up expired blocks for ${network}`);
 } catch (err: any) {
 logger.error(`Error cleaning up expired blocks for ${network}: ${err.message}`);
 }
 }, this.BLOCK_CACHE_TTL_MS / 2);
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
 logger.warn(`No account found for address ${toAddress}`);
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
 logger.info(`Tx ${tx.hash} amount ${amount} ${currencyName} below min_deposit ${minDeposit}`);
 return;
 }

 const deposit: Deposit = {
 id: tx.hash,
 username: account.username,
 blockchain: network,
 currency: currencyName,
 timestamp: Date.now(),
 amount: amount.toFixed(2),
 txHash: tx.hash,
 fromAddress: tx.from,
 toAddress,
 status: "pending",
 confirmations: 1,
 requiredConfirmations: networkConfig.requiredConfirmations,
 retries: 0,
 };

 await DepositModel.create(deposit);
 const queueKey = `${network}:${currencyName}`;
 this.pendingQueues.get(queueKey)!.add(tx.hash);
 await db.put(`depositStartBlock:${tx.hash}`, blockNumber.toString());
//  logger.info(`Queued deposit ${tx.hash} for ${account.username} (${amount} ${currencyName}) on ${network}`);
 WebSocketService.broadcast({
 type: "deposit_update",
 data: deposit,
 });
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
 if (!this.processingTxs.has(txHash)) {
 this.processingTxs.add(txHash);
 try {
 await this.processDeposit(txHash, network, currency);
 } finally {
 this.processingTxs.delete(txHash);
 }
 }
 }
 }, this.PROCESS_INTERVAL_MS);
 }

 private async processDeposit(txHash: string, network: string, currency: string) {
 const queueKey = `${network}:${currency}`;
 const queue = this.pendingQueues.get(queueKey)!;

 try {
 const deposit = await DepositModel.findById(txHash);
 if (!deposit) {
 logger.warn(`Deposit ${txHash} not found`);
 queue.delete(txHash);
 this.processedTransactions.add(txHash);
 await db.del(`depositStartBlock:${txHash}`);
 TransactionService.cleanupGasFundingTx(txHash);
 return;
 }

 const networkConfig = networks[network];
 const provider = this.httpProviders[network];
 const currentBlock = await (this.wsProviders[network] || provider).getBlockNumber();
 const startBlock = parseInt(await db.get(`depositStartBlock:${txHash}`), 10);
 const confirmations = currentBlock - startBlock + 1;

 if (confirmations >= networkConfig.requiredConfirmations && deposit.status !== "confirmed") {
 deposit.status = "confirmed";
 deposit.confirmations = confirmations;
 await DepositModel.update(deposit);
 WebSocketService.broadcast({
 type: "deposit_update",
 data: deposit,
 });

 const transferTxHash = await TransactionService.transferToHotWallet(deposit, provider);
 deposit.status = "credited";
 deposit.retries = 0;
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
 logger.info(
 `Credited ${deposit.amount} ${deposit.currency} to ${deposit.username}, ` +
 `new balance: ${newBalance.amount} on ${network}, transfer tx: ${transferTxHash}`
 );
 WebSocketService.broadcast({
 type: "deposit_update",
 data: deposit,
 });
 } else if (confirmations !== deposit.confirmations) {
 deposit.confirmations = Math.min(confirmations, networkConfig.requiredConfirmations);
 deposit.status = "confirming";
 await DepositModel.update(deposit);
 WebSocketService.broadcast({
 type: "deposit_update",
 data: deposit,
 });
 }

 if (deposit.status === "credited" || deposit.status === "failed") {
 queue.delete(txHash);
 this.processedTransactions.add(txHash);
 await db.del(`depositStartBlock:${txHash}`);
 TransactionService.cleanupGasFundingTx(txHash);
 }
 } catch (err: any) {
 const deposit = await DepositModel.findById(txHash);
 if (!deposit) {
 queue.delete(txHash);
 this.processedTransactions.add(txHash);
 await db.del(`depositStartBlock:${txHash}`);
 TransactionService.cleanupGasFundingTx(txHash);
 return;
 }

 if (err.message.includes("Insufficient balance") || err.message.includes("Insufficient funds after gas")) {
 deposit.status = "failed";
 deposit.retries = deposit.retries || 0;
 await DepositModel.update(deposit);
 logger.error(`Failed deposit ${txHash} on ${network}:${currency} permanently: ${err.message}`);
 WebSocketService.broadcast({
 type: "deposit_update",
 data: deposit,
 });
 queue.delete(txHash);
 this.processedTransactions.add(txHash);
 await db.del(`depositStartBlock:${txHash}`);
 TransactionService.cleanupGasFundingTx(txHash);
 return;
 }

 const retries = (deposit.retries || 0) + 1;
 if (retries > this.MAX_RETRIES) {
 deposit.status = "failed";
 deposit.retries = retries;
 await DepositModel.update(deposit);
 logger.error(`Failed deposit ${txHash} on ${network}:${currency} after ${retries} retries: ${err.message}`);
 WebSocketService.broadcast({
 type: "deposit_update",
 data: deposit,
 });
 queue.delete(txHash);
 this.processedTransactions.add(txHash);
 await db.del(`depositStartBlock:${txHash}`);
 TransactionService.cleanupGasFundingTx(txHash);
 return;
 }

 deposit.retries = retries;
 await DepositModel.update(deposit);
 logger.warn(`Retry ${retries}/${this.MAX_RETRIES} for deposit ${txHash}: ${err.message}`);
 await new Promise((resolve) => setTimeout(resolve, 3000 * retries));
 }
 }

 addActiveAddress(address: string) {
 this.activeAddresses.add(address.toLowerCase());
 logger.info(`Added active address: ${address}`);
 }
}

export const indexerService = new IndexerService();