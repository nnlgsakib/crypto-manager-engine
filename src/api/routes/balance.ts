// src/api/routes/balance.ts
import express from "express";
import { BalanceModel, AccountModel } from "../../db/models";
import { logger } from "../../utils/logger";
import { networks } from "../../config/networks";

const router = express.Router();

router.get("/get_balance", async (req, res) => {
  try {
    const { username } = req.query as { username?: string };
    if (!username) {
      return res.status(400).json({ error: "Username required" });
    }
    const account = await AccountModel.findByUsername(username);
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }
    const balances = await BalanceModel.getAllBalances(account.username);
    res.json(balances);
  } catch (err: any) {
    logger.error(`Error in get_balance: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/get_balance_by_currency", async (req, res) => {
  try {
    const { username, blockchain, currency } = req.query as {
      username: string;
      blockchain: string;
      currency: string;
    };
    if (!username || !blockchain || !currency) {
      return res.status(400).json({ error: "Username, blockchain, and currency required" });
    }
    const account = await AccountModel.findByUsername(username);
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }
    if (!networks[blockchain] || (!networks[blockchain].erc20Tokens[currency] && currency !== networks[blockchain].nativeCurrency)) {
      return res.status(400).json({ error: "Invalid blockchain or currency" });
    }
    const balance = await BalanceModel.getBalance(account.username, blockchain, currency);
    res.json({ username, blockchain, currency, amount: balance.amount });
  } catch (err: any) {
    logger.error(`Error in get_balance_by_currency: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;