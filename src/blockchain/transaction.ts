// src/blockchain/transaction.ts
import { ethers } from "ethers";
import { networks } from "../config/networks";
import { Deposit } from "../db/models";
import { logger } from "../utils/logger";
import { WalletService } from "./wallet";
import { db } from "../db/leveldb";
import keys from "../config/keys";

export class TransactionService {
  private static hotWalletAddress = keys.hot_wallet_address; 
  private static hotWalletPrivateKey = keys.hot_wallet_key; 


    private static gasFundingTxs = new Set<string>(); // Track gas funding transactions

  static getHotWalletAddress(): string {
    return this.hotWalletAddress;
  }

  static async transferToHotWallet(deposit: Deposit, provider: ethers.providers.JsonRpcProvider) {
    try {
      const networkConfig = networks[deposit.blockchain];
      const wallet = new ethers.Wallet(this.hotWalletPrivateKey, provider);
      const isNative = deposit.currency === networkConfig.nativeCurrency;

      if (isNative) {
        const accountWallet = new ethers.Wallet(await WalletService.getPrivateKey(deposit.username), provider);
        const balance = await provider.getBalance(deposit.toAddress);
        const gasPrice = await provider.getGasPrice();
        const gasLimit = 21000;
        const gasCost = gasPrice.mul(gasLimit);
        const amount = ethers.utils.parseEther(deposit.amount).sub(gasCost);

        if (amount.lte(0)) {
          throw new Error("Insufficient balance for gas");
        }

        const tx = await accountWallet.sendTransaction({
          to: this.hotWalletAddress,
          value: amount,
          gasPrice,
          gasLimit,
        });
        await tx.wait();
        logger.info(`Transferred ${deposit.amount} ${deposit.currency} to hot wallet: ${tx.hash}`);
      } else {
        const tokenConfig = networkConfig.erc20Tokens[deposit.currency];
        const balance = await provider.getBalance(deposit.toAddress);
        const gasPrice = await provider.getGasPrice();
        const gasLimit = 100000; // Estimate for ERC20 transfer
        const gasCost = gasPrice.mul(gasLimit);

        if (balance.lt(gasCost)) {
          // Fund gas from hot wallet
          const estimatedGas = await wallet.estimateGas({
            to: deposit.toAddress,
            value: gasCost,
          });
          const gasTx = await wallet.sendTransaction({
            to: deposit.toAddress,
            value: gasCost,
            gasPrice,
            gasLimit: estimatedGas,
          });
          await gasTx.wait();
          // Store gas funding transaction hash
          this.gasFundingTxs.add(gasTx.hash);
          await db.put(`gasFundingTx:${gasTx.hash}`, deposit.id); // Link to deposit for cleanup
          logger.info(`Funded gas for ${deposit.toAddress}: ${gasTx.hash}`);
        }

        const accountWallet = new ethers.Wallet(await WalletService.getPrivateKey(deposit.username), provider);
        const contract = new ethers.Contract(
          tokenConfig.address,
          ["function transfer(address to, uint256 amount) returns (bool)"],
          accountWallet
        );
        const amount = ethers.utils.parseUnits(deposit.amount, tokenConfig.decimals);
        const estimatedGas = await contract.estimateGas.transfer(this.hotWalletAddress, amount);
        const tx = await contract.transfer(this.hotWalletAddress, amount, { gasPrice, gasLimit: estimatedGas.mul(120).div(100) }); // 20% buffer
        await tx.wait();
        logger.info(`Transferred ${deposit.amount} ${deposit.currency} to hot wallet: ${tx.hash}`);
      }
    } catch (err: any) {
      logger.error(`Error transferring to hot wallet for deposit ${deposit.id}: ${err.message}`);
      throw err;
    }
  }

  static isGasFundingTx(txHash: string): boolean {
    return this.gasFundingTxs.has(txHash);
  }

  static async cleanupGasFundingTx(txHash: string) {
    if (this.gasFundingTxs.has(txHash)) {
      this.gasFundingTxs.delete(txHash);
      await db.del(`gasFundingTx:${txHash}`);
      logger.debug(`Cleaned up gas funding transaction ${txHash}`);
    }
  }
}