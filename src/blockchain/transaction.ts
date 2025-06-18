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
  private static gasFundingTxs = new Set<string>();

  static getHotWalletAddress(): string {
    return this.hotWalletAddress;
  }

  static async transferToHotWallet(deposit: Deposit, provider: ethers.providers.JsonRpcProvider): Promise<string> {
    try {
      const networkConfig = networks[deposit.blockchain];
      const currency = deposit.currency;
      const wallet = new ethers.Wallet(this.hotWalletPrivateKey, provider);
      const isNative = currency === networkConfig.nativeCurrency;

      if (isNative) {
        const accountWallet = new ethers.Wallet(await WalletService.getPrivateKey(deposit.username), provider);
        const gasPrice = await provider.getGasPrice();
        const gasLimit = ethers.BigNumber.from(21000);
        const gasCost = gasPrice.mul(gasLimit);
        const depositAmount = ethers.utils.parseEther(deposit.amount);
        const amountToTransfer = depositAmount.sub(gasCost);

        let balance: ethers.BigNumber;
        for (let i = 0; i < 5; i++) {
          balance = await provider.getBalance(deposit.toAddress);
          if (balance.gte(depositAmount)) {
            break;
          }
          logger.warn(
            `Balance check ${i + 1}/5 for ${deposit.toAddress}: ${ethers.utils.formatEther(balance)} ${currency}, needed ${deposit.amount} ${currency}`
          );
          await new Promise((resolve) => setTimeout(resolve, 3000 * (i + 1)));
        }

        if (balance!.lt(depositAmount)) {
          throw new Error(`Insufficient balance: ${ethers.utils.formatEther(balance!)} ${currency}, needed ${deposit.amount} ${currency}`);
        }
        if (amountToTransfer.lte(0)) {
          throw new Error(
            `Insufficient funds after gas: deposit ${deposit.amount} ${currency}, gas cost ${ethers.utils.formatEther(gasCost)} ${currency}`
          );
        }

        const tx = await accountWallet.sendTransaction({
          to: this.hotWalletAddress,
          value: amountToTransfer,
          gasPrice,
          gasLimit,
        });
        const receipt = await tx.wait(1);
        logger.info(
          `Transferred ${ethers.utils.formatEther(amountToTransfer)} ${currency} to hot wallet for deposit ${deposit.id}: ${tx.hash}, ` +
          `gas cost: ${ethers.utils.formatEther(gasCost)} ${currency}`
        );
        return tx.hash;
      } else {
        const tokenConfig = networkConfig.erc20Tokens[currency];
        const balance = await provider.getBalance(deposit.toAddress);
        const gasPrice = await provider.getGasPrice();
        const gasLimit = ethers.BigNumber.from(100000);
        const gasCost = gasPrice.mul(gasLimit);

        if (balance.lt(gasCost)) {
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
          await gasTx.wait(1);
          this.gasFundingTxs.add(gasTx.hash);
          await db.put(`gasFundingTx:${gasTx.hash}`, deposit.id);
          logger.info(`Funded gas for ${deposit.toAddress}: ${gasTx.hash}, cost: ${ethers.utils.formatEther(gasCost)} ${networkConfig.nativeCurrency}`);
        }

        const accountWallet = new ethers.Wallet(await WalletService.getPrivateKey(deposit.username), provider);
        const contract = new ethers.Contract(
          tokenConfig.address,
          ["function transfer(address to, uint256 amount) returns (bool)"],
          accountWallet
        );
        const amount = ethers.utils.parseUnits(deposit.amount, tokenConfig.decimals);
        const estimatedGas = await contract.estimateGas.transfer(this.hotWalletAddress, amount);
        const tx = await contract.transfer(this.hotWalletAddress, amount, {
          gasPrice,
          gasLimit: estimatedGas.mul(120).div(100),
        });
        const receipt = await tx.wait(1, 15000);
        logger.info(`Transferred ${deposit.amount} ${currency} to hot wallet for deposit ${deposit.id}: ${tx.hash}`);
        return tx.hash;
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