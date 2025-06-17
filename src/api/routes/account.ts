// src/api/routes/account.ts
import express from "express";
import { WalletService } from "../../blockchain/wallet";
import { AccountModel } from "../../db/models";
import { logger } from "../../utils/logger";

const router = express.Router();

router.post("/generate_account", async (req, res) => {
  try {
    const username = req.headers["username"] as string;
    if (!username) {
      return res.status(400).json({ error: "Username header required" });
    }
    // Check if account exists to determine response message
    const existingAccount = await AccountModel.findByUsername(username);
    const account = await WalletService.generateAccount(username);
    res.json({
      ...account,
      message: existingAccount ? "Existing account retrieved" : "New account created",
    });
  } catch (err: any) {
    logger.error(`Error in generate_account: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;