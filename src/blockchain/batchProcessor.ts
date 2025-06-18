// src/blockchain/batchProcessor.ts
import { ethers } from 'ethers';
import { networks } from '../config/networks';
import {
  WithdrawalModel,
  BucketModel,
  Withdrawal,
  Bucket,
  Balance,
  BalanceModel,
} from '../db/models';
import { logger } from '../utils/logger';
import keys from '../config/keys';
import { WebSocketService } from '../services/websocket';

export class BatchProcessorService {
  private static hotWalletPrivateKey = keys.hot_wallet_key;
  private static BUCKET_DURATION_MS = 1 * 60 * 1000; // 1 minute
  private static processingBuckets = new Set<string>();
  private static DEFAULT_ERC20_GAS_LIMIT = 200000;
  private static DEFAULT_APPROVE_GAS_LIMIT = 100000;

  static async addToBucket(
    withdrawal: Withdrawal,
    provider: ethers.providers.JsonRpcProvider
  ): Promise<Bucket> {
    try {
      const currentTime = Date.now();
      const bucketId = `${withdrawal.blockchain}:${withdrawal.currency}:${Math.floor(currentTime / this.BUCKET_DURATION_MS)}`;
      let bucket = await BucketModel.findById(bucketId);

      if (!bucket || bucket.expiresAt <= currentTime) {
        bucket = {
          id: bucketId,
          blockchain: withdrawal.blockchain,
          currency: withdrawal.currency,
          createdAt: currentTime,
          expiresAt: currentTime + this.BUCKET_DURATION_MS,
          withdrawalIds: [],
        };
        await BucketModel.create(bucket);
        this.scheduleBucketProcessing(bucket, provider);
      }

      bucket.withdrawalIds.push(withdrawal.id);
      withdrawal.bucketId = bucketId;
      withdrawal.status = 'added_to_bucket';
      await Promise.all([
        BucketModel.update(bucket),
        WithdrawalModel.update(withdrawal),
      ]);
      logger.info(
        `Added withdrawal ${withdrawal.id} to bucket ${bucketId}, expires at ${new Date(bucket.expiresAt).toISOString()}`
      );
      WebSocketService.broadcast({
        type: 'withdrawal_update',
        data: withdrawal,
      });

      return bucket;
    } catch (err: any) {
      logger.error(
        `Error adding withdrawal ${withdrawal.id} to bucket: ${err.message}`
      );
      throw err;
    }
  }

  private static scheduleBucketProcessing(
    bucket: Bucket,
    provider: ethers.providers.JsonRpcProvider
  ) {
    const timeUntilExpiry = bucket.expiresAt - Date.now();
    setTimeout(
      async () => {
        await this.processBucket(bucket.id, provider);
      },
      Math.max(timeUntilExpiry, 0)
    );
  }

  static async processBucket(
    bucketId: string,
    provider: ethers.providers.JsonRpcProvider
  ) {
    if (this.processingBuckets.has(bucketId)) {
      logger.debug(`Bucket ${bucketId} is already being processed`);
      return;
    }
    this.processingBuckets.add(bucketId);

    try {
      const bucket = await BucketModel.findById(bucketId);
      if (!bucket) {
        logger.warn(`Bucket ${bucketId} not found`);
        return;
      }

      const withdrawals = await Promise.all(
        bucket.withdrawalIds.map(id => WithdrawalModel.findById(id))
      );
      const validWithdrawals = withdrawals.filter(
        w => w && w.status === 'added_to_bucket'
      ) as Withdrawal[];

      if (validWithdrawals.length === 0) {
        logger.info(`No valid withdrawals in bucket ${bucketId}`);
        await BucketModel.update({ ...bucket, withdrawalIds: [] });
        return;
      }

      const networkConfig = networks[bucket.blockchain];
      const wallet = new ethers.Wallet(this.hotWalletPrivateKey, provider);
      const contract = new ethers.Contract(
        networkConfig.withdrawal_processor_contract_address,
        [
          'function processBatchNative(address[] calldata recipients, uint256[] calldata amounts) external payable',
          'function processBatchErc20(address token, address[] calldata recipients, uint256[] calldata amounts) external',
        ],
        wallet
      );

      const recipients: string[] = [];
      const amounts: ethers.BigNumber[] = [];
      for (const w of validWithdrawals) {
        w.status = 'processing';
        await WithdrawalModel.update(w);
        WebSocketService.broadcast({
          type: 'withdrawal_update',
          data: w,
        });
        recipients.push(w.toAddress);
        amounts.push(
          ethers.utils.parseUnits(
            w.amount,
            w.currency === networkConfig.nativeCurrency
              ? 18
              : networkConfig.erc20Tokens[w.currency].decimals
          )
        );
      }

      const gasPrice = await provider.getGasPrice();
      const isNative = bucket.currency === networkConfig.nativeCurrency;
      let tx;

      try {
        if (isNative) {
          const totalAmount = amounts.reduce(
            (sum, a) => sum.add(a),
            ethers.BigNumber.from(0)
          );
          const hotWalletBalance = await provider.getBalance(wallet.address);
          if (hotWalletBalance.lt(totalAmount)) {
            logger.error(
              `Hot wallet lacks sufficient ${bucket.currency} balance (available: ${ethers.utils.formatEther(hotWalletBalance)}, required: ${ethers.utils.formatEther(totalAmount)})`
            );
            throw new Error(
              `Insufficient ${bucket.currency} liquidity in hot wallet for bucket ${bucketId}`
            );
          }

          let estimatedGas;
          try {
            estimatedGas = await contract.estimateGas.processBatchNative(
              recipients,
              amounts,
              { value: totalAmount }
            );
          } catch (err: any) {
            logger.warn(
              `Failed to estimate gas for processBatchNative, using default: ${err.message}`
            );
            estimatedGas = ethers.BigNumber.from(this.DEFAULT_ERC20_GAS_LIMIT);
          }
          tx = await contract.processBatchNative(recipients, amounts, {
            gasPrice,
            gasLimit: estimatedGas.mul(120).div(100),
            value: totalAmount,
          });
        } else {
          const tokenConfig = networkConfig.erc20Tokens[bucket.currency];
          const tokenContract = new ethers.Contract(
            tokenConfig.address,
            [
              'function approve(address spender, uint256 amount) external returns (bool)',
              'function allowance(address owner, address spender) external view returns (uint256)',
              'function balanceOf(address account) external view returns (uint256)',
              'function transferFrom(address sender, address recipient, uint256 amount) external returns (bool)',
            ],
            wallet
          );

          const totalAmount = amounts.reduce(
            (sum, a) => sum.add(a),
            ethers.BigNumber.from(0)
          );
          const hotWalletTokenBalance = await tokenContract.balanceOf(
            wallet.address
          );
          if (hotWalletTokenBalance.lt(totalAmount)) {
            logger.error(
              `Hot wallet lacks sufficient ${bucket.currency} balance (available: ${ethers.utils.formatUnits(hotWalletTokenBalance, tokenConfig.decimals)}, required: ${ethers.utils.formatUnits(totalAmount, tokenConfig.decimals)})`
            );
            throw new Error(
              `Insufficient ${bucket.currency} liquidity in hot wallet for bucket ${bucketId}`
            );
          }

          const currentAllowance = await tokenContract.allowance(
            wallet.address,
            networkConfig.withdrawal_processor_contract_address
          );
          if (currentAllowance.lt(totalAmount)) {
            let approveGas;
            try {
              approveGas = await tokenContract.estimateGas.approve(
                networkConfig.withdrawal_processor_contract_address,
                totalAmount
              );
            } catch (err: any) {
              logger.warn(
                `Failed to estimate gas for approval, using default: ${err.message}`
              );
              approveGas = ethers.BigNumber.from(
                this.DEFAULT_APPROVE_GAS_LIMIT
              );
            }
            const approveTx = await tokenContract.approve(
              networkConfig.withdrawal_processor_contract_address,
              totalAmount,
              { gasPrice, gasLimit: approveGas.mul(120).div(100) }
            );
            await approveTx.wait();
            logger.info(
              `Approved ${ethers.utils.formatUnits(totalAmount, tokenConfig.decimals)} ${bucket.currency} for BatchProcessor`
            );
          }

          let estimatedGas;
          try {
            estimatedGas = await contract.estimateGas.processBatchErc20(
              tokenConfig.address,
              recipients,
              amounts
            );
          } catch (err: any) {
            logger.warn(
              `Failed to estimate gas for processBatchErc20, using default: ${err.message}`
            );
            estimatedGas = ethers.BigNumber.from(this.DEFAULT_ERC20_GAS_LIMIT);
          }
          tx = await contract.processBatchErc20(
            tokenConfig.address,
            recipients,
            amounts,
            {
              gasPrice,
              gasLimit: estimatedGas.mul(120).div(100),
            }
          );
        }

        const receipt = await tx.wait();
        const fee = parseFloat(networkConfig.withdrawal_fee || '0');
        for (const w of validWithdrawals) {
          const withdrawalAmount = parseFloat(w.amount);
          const totalReserved = withdrawalAmount + fee;
          if (receipt.status === 1) {
            w.status = 'completed';
            w.txHash = tx.hash;
            const balance = await BalanceModel.getBalance(
              w.username,
              w.blockchain,
              w.currency
            );
            const newBalance: Balance = {
              username: w.username,
              blockchain: w.blockchain,
              currency: w.currency,
              amount: parseFloat(balance.amount).toFixed(2),
              frozenAmount: (
                parseFloat(balance.frozenAmount || '0') - totalReserved
              ).toFixed(2),
            };
            await Promise.all([
              BalanceModel.updateBalance(newBalance),
              WithdrawalModel.update(w),
            ]);
            logger.info(
              `Processed withdrawal ${w.id} for ${w.username} (${w.amount} ${w.currency} + ${fee} fee), frozen: ${newBalance.frozenAmount}`
            );
            WebSocketService.broadcast({
              type: 'withdrawal_update',
              data: w,
            });
          } else {
            w.status = 'failed';
            await BalanceModel.unfreezeBalance(
              w.username,
              w.blockchain,
              w.currency,
              totalReserved.toFixed(2)
            );
            await WithdrawalModel.update(w);
            logger.error(
              `Marked withdrawal ${w.id} as failed, unfroze ${totalReserved} ${w.currency}`
            );
            WebSocketService.broadcast({
              type: 'withdrawal_update',
              data: w,
            });
          }
        }
      } catch (err: any) {
        logger.error(
          `Error executing batch transaction for bucket ${bucketId}: ${err.message}`
        );
        const fee = parseFloat(networkConfig.withdrawal_fee || '0');
        for (const w of validWithdrawals) {
          const totalReserved = parseFloat(w.amount) + fee;
          w.status = 'failed';
          await BalanceModel.unfreezeBalance(
            w.username,
            w.blockchain,
            w.currency,
            totalReserved.toFixed(2)
          );
          await WithdrawalModel.update(w);
          logger.error(
            `Marked withdrawal ${w.id} as failed, unfroze ${totalReserved} ${w.currency}`
          );
          WebSocketService.broadcast({
            type: 'withdrawal_update',
            data: w,
          });
        }
        throw err;
      } finally {
        await BucketModel.update({ ...bucket, withdrawalIds: [] });
        const newBucketId = `${bucket.blockchain}:${bucket.currency}:${Math.floor(Date.now() / this.BUCKET_DURATION_MS)}`;
        if (newBucketId !== bucketId) {
          const newBucket: Bucket = {
            id: newBucketId,
            blockchain: bucket.blockchain,
            currency: bucket.currency,
            createdAt: Date.now(),
            expiresAt: Date.now() + this.BUCKET_DURATION_MS,
            withdrawalIds: [],
          };
          await BucketModel.create(newBucket);
          this.scheduleBucketProcessing(newBucket, provider);
          logger.info(
            `Created new bucket ${newBucketId} for ${bucket.currency} on ${bucket.blockchain}`
          );
        }
      }
    } catch (err: any) {
      logger.error(`Error processing bucket ${bucketId}: ${err.message}`);
    } finally {
      this.processingBuckets.delete(bucketId);
    }
  }
}
