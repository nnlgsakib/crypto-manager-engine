// src/api/routes/deposit.ts
import express from "express";
import { DepositModel } from "../../db/models";
import { logger } from "../../utils/logger";

const router = express.Router();

router.get("/get_all_deposit_history", async (req, res) => {
  try {
    const { username, page = "1", limit = "10", status } = req.query as {
      username: string;
      page?: string;
      limit?: string;
      status?: string;
    };
    const deposits = await DepositModel.getAllByUsername(username, {
      page: parseInt(page),
      limit: parseInt(limit),
      status,
    });
    res.json(deposits);
  } catch (err: any) {
    logger.error(`Error in get_all_deposit_history: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;