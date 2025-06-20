import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { networks } from '../../config/networks';
import {
  BalanceModel,
  WithdrawalModel,
  AccountModel,
  Balance,
  Withdrawal,
} from '../../db/models';
import { BatchProcessorService } from '../../blockchain/batchProcessor';
import { logger } from '../../utils/logger';
import { ethers } from 'ethers';
import { WebSocketService } from '../../services/websocket';

const router = express.Router();

router.post('/send_balance_to_user', async (req, res) => {
  try {
    const { username, recipientUsername, blockchain, currency, amount } =
      req.body;
    const sender = await AccountModel.findByUsername(username);
    if (!sender) {
      return res.status(404).json({ error: 'Sender not found' });
    }
    const recipient = await AccountModel.findByUsername(recipientUsername);
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const balance = await BalanceModel.getBalance(
      username,
      blockchain,
      currency
    );
    const available = parseFloat(balance.amount) || 0;
    const frozen = parseFloat(balance.frozenAmount) || 0;
    const parsedAmount = parseFloat(amount);
    if (available < parsedAmount) {
      return res.status(400).json({
        error: `Insufficient available ${currency} balance (available: ${available}, frozen: ${frozen})`,
      });
    }

    const newBalance: Balance = {
      username,
      blockchain,
      currency,
      amount: (available - parsedAmount).toFixed(2),
      frozenAmount: frozen.toFixed(2),
    };
    const recipientBalance = await BalanceModel.getBalance(
      recipientUsername,
      blockchain,
      currency
    );
    const newRecipientBalance: Balance = {
      username: recipientUsername,
      blockchain,
      currency,
      amount: (
        parseFloat(recipientBalance.amount || '0') + parsedAmount
      ).toFixed(2),
      frozenAmount: parseFloat(recipientBalance.frozenAmount || '0').toFixed(2),
    };

    await Promise.all([
      BalanceModel.updateBalance(newBalance),
      BalanceModel.updateBalance(newRecipientBalance),
    ]);

    // Broadcast balance updates
    WebSocketService.broadcast({
      type: 'balance_update',
      data: {
        username,
        blockchain,
        currency,
        amount: newBalance.amount,
        frozenAmount: newBalance.frozenAmount,
      },
    });
    WebSocketService.broadcast({
      type: 'balance_update',
      data: {
        username: recipientUsername,
        blockchain,
        currency,
        amount: newRecipientBalance.amount,
        frozenAmount: newRecipientBalance.frozenAmount,
      },
    });

    // Broadcast transfer update
    WebSocketService.broadcast({
      type: 'transfer_update',
      data: {
        senderUsername: username,
        recipientUsername,
        blockchain,
        currency,
        amount: parsedAmount.toFixed(2),
        timestamp: Date.now(),
      },
    });

    res.json({ message: 'Transfer successful' });
  } catch (err: any) {
    logger.error(`Error in send_balance_to_user: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/req_deposit', async (req, res) => {
  try {
    const { username, blockchain, currency, amount, toAddress } = req.body;
    const networkConfig = networks[blockchain];
    if (!networkConfig) {
      return res.status(400).json({ error: 'Invalid blockchain' });
    }

    const isNative = currency === networkConfig.nativeCurrency;
    const config = isNative
      ? networkConfig
      : networkConfig.erc20Tokens[currency];
    if (!config) {
      return res.status(400).json({ error: 'Invalid currency' });
    }

    const parsedAmount = parseFloat(amount);
    const minWithdrawal = parseFloat(config.min_withdrawal || '0');
    const maxWithdrawal = parseFloat(config.max_withdrawal || 'Infinity');
    const fee = parseFloat(config.withdrawal_fee || '0');

    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Invalid withdrawal amount' });
    }
    if (parsedAmount < minWithdrawal) {
      return res.status(400).json({
        error: `Withdrawal amount below minimum (${minWithdrawal} ${currency})`,
      });
    }
    if (parsedAmount > maxWithdrawal) {
      return res.status(400).json({
        error: `Withdrawal amount above maximum (${maxWithdrawal} ${currency})`,
      });
    }

    const balance = await BalanceModel.getBalance(
      username,
      blockchain,
      currency
    );
    const available = parseFloat(balance.amount) || 0;
    const frozen = parseFloat(balance.frozenAmount) || 0;
    const required = parsedAmount + fee;
    if (available < required) {
      return res.status(400).json({
        error: `Insufficient available ${currency} balance (available: ${available}, frozen: ${frozen}, required: ${required} including ${fee} ${currency} fee)`,
      });
    }

    await BalanceModel.freezeBalance(
      username,
      blockchain,
      currency,
      required.toFixed(2)
    );

    const withdrawal: Withdrawal = {
      id: uuidv4(),
      username,
      blockchain,
      currency,
      amount: parsedAmount.toFixed(2),
      toAddress,
      status: 'created',
      timestamp: Date.now(),
    };

    await WithdrawalModel.create(withdrawal);
    const provider = new ethers.providers.JsonRpcProvider(
      networkConfig.httpRpcUrl
    );
    const bucket = await BatchProcessorService.addToBucket(
      withdrawal,
      provider
    );
    res.json({
      withdrawalId: withdrawal.id,
      bucketId: withdrawal.bucketId,
      bucketExpiresAt: bucket.expiresAt,
    });
  } catch (err: any) {
    logger.error(`Error in req_deposit: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/get_withdraw_status_by_id', async (req, res) => {
  try {
    const { withdrawalId } = req.query as { withdrawalId: string };
    const withdrawal = await WithdrawalModel.findById(withdrawalId);
    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }
    res.json(withdrawal);
  } catch (err: any) {
    logger.error(`Error in get_withdraw_status_by_id: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/get_all_withdrawal_history', async (req, res) => {
  try {
    const {
      username,
      page = '1',
      limit = '10',
      status,
    } = req.query as {
      username: string;
      page?: string;
      limit?: string;
      status?: string;
    };
    const withdrawals = await WithdrawalModel.getAllByUsername(username, {
      page: parseInt(page),
      limit: parseInt(limit),
      status,
    });
    res.json(withdrawals);
  } catch (err: any) {
    logger.error(`Error in get_all_withdrawal_history: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
