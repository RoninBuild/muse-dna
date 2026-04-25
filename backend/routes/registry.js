import express from "express";
import { listAgents, registryMode, seedMuseAgents } from "../services/agentRegistry.js";
import { requireAdminAuthStrict } from "../middleware/adminAuth.js";

const router = express.Router();

router.get("/", async (_req, res) => {
  try {
    const agents = await listAgents();
    res.json({
      mode: registryMode(),
      count: agents.length,
      agents
    });
  } catch (error) {
    console.error("Registry lookup failed:", error.message);
    res.status(500).json({ error: "Failed to load registry." });
  }
});

router.post("/seed", requireAdminAuthStrict, async (_req, res) => {
  try {
    const results = await seedMuseAgents();
    res.json({ mode: registryMode(), seeded: results });
  } catch (error) {
    console.error("Registry seed failed:", error.message);
    res.status(500).json({ error: "Failed to seed registry." });
  }
});

export default router;
