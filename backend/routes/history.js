import express from "express";
import { db } from "../db/index.js";
import { listSkillFiles } from "../services/hermes.js";
import { requireSession } from "../middleware/siwe.js";

const router = express.Router();

// P2-5: session guard — only return history to authenticated users.
// Set MUSE_PUBLIC_HISTORY=true to bypass for open hackathon demos or
// when a judge needs to inspect history without going through the UI.
const PUBLIC_HISTORY = (process.env.MUSE_PUBLIC_HISTORY || "").toLowerCase() === "true";

const historyAuth = (req, res, next) => {
  if (PUBLIC_HISTORY) return next();
  return requireSession(req, res, next);
};

router.get("/", historyAuth, async (_req, res) => {
  try {
    const [tasks, skills] = await Promise.all([
      db.tasks.findAll(),
      listSkillFiles()
    ]);
    const summary = await db.tasks.findSummary();

    res.json({
      tasks,
      dnaAssets: skills,
      summary
    });
  } catch (error) {
    console.error("History lookup failed:", error.message);
    res.status(500).json({
      error: "Failed to load history."
    });
  }
});

/**
 * GET /api/history/metrics
 *
 * Cumulative on-chain counter used by the UI badge. The hackathon rules
 * require the demo to show at least 50 settled micro-transactions — this
 * endpoint exposes the running total across every task so the counter
 * keeps climbing even after restarts.
 */
router.get("/metrics", historyAuth, async (_req, res) => {
  try {
    const summary = await db.tasks.findSummary();
    res.json({
      totalMicroPayments: summary.paidUnits,
      totalReusedUnits: summary.reusedUnits,
      totalSpentUsdc: summary.spent,
      totalSavedUsdc: summary.saved,
      completedTasks: summary.completedTasks,
      hackathonTarget: 50,
      hackathonTargetReached: summary.paidUnits >= 50
    });
  } catch (error) {
    console.error("Metrics lookup failed:", error.message);
    res.status(500).json({ error: "Failed to load metrics." });
  }
});

export default router;
