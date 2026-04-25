import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDNA,
  extractBrandName,
  listSkillFiles,
  planTask,
  readSkillFile
} from "./hermes.js";
import { buildMicroEconomyPlan, getUnitDefinition } from "./microeconomy.js";
import { createTaskRunner } from "./orchestrator.js";
import { db as realDb } from "../db/index.js";

process.env.MOCK_X402 = "true";

function createDbMock() {
  const state = {
    taskUpdates: [],
    steps: [],
    skills: []
  };

  return {
    state,
    tasks: {
      async update(id, data) {
        state.taskUpdates.push({ id, data });
        return { id, ...data };
      }
    },
    steps: {
      async create(data) {
        state.steps.push(data);
        return data;
      }
    },
    skills: {
      async create(data) {
        state.skills.push(data);
        return data;
      }
    }
  };
}

function createSocketRecorder() {
  const events = [];

  return {
    events,
    emit(event, data) {
      events.push({ event, data });
    }
  };
}

test("planTask returns a 52-unit investment micro-plan when DNA is missing", async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                brand_name: "AutoCRM",
                dna_exists: false,
                skipped_units: []
              })
            }
          }
        ]
      };
    }
  });

  const result = await planTask(
    {
      prompt: "Сделай Twitter-пост и баннер для 'AutoCRM'",
      taskType: "twitter_post"
    },
    {
      fetchImpl,
      skillsDir: path.join(os.tmpdir(), "muse-v6-empty-skills")
    }
  );

  assert.equal(result.brand_name, "AutoCRM");
  assert.equal(result.dna_exists, false);
  assert.equal(result.micro_plan.length, 52);
  assert.equal(result.skipped_units.length, 0);
  assert.equal(result.blueprint_total_units, 52);
});

test("planTask returns the 20-unit dividend plan plus 32 skipped units when DNA exists", async () => {
  const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "muse-v6-skills-"));
  await fs.writeFile(path.join(skillsDir, "AutoCRM_DNA.md"), "# AutoCRM Brand DNA", "utf-8");

  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content: `wrapped {"brand_name":"AutoCRM","dna_exists":true}`
            }
          }
        ]
      };
    }
  });

  const result = await planTask(
    {
      prompt: "Сделай email-кампанию для нового релиза AutoCRM",
      taskType: "email_campaign"
    },
    {
      fetchImpl,
      skillsDir
    }
  );

  assert.equal(result.dna_exists, true);
  assert.equal(result.dna_file, "AutoCRM_DNA.md");
  assert.equal(result.micro_plan.length, 20);
  assert.equal(result.skipped_units.length, 32);
  assert.equal(result.blueprint_total_units, 52);
  assert.equal(result.savings_usdc, 0.148);
});

test("planTask trusts a matching DNA file even if Hermes reports dna_exists false", async () => {
  const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "muse-v6-dna-deterministic-"));
  await fs.writeFile(path.join(skillsDir, "AutoCRM_DNA.md"), "# AutoCRM Brand DNA", "utf-8");

  const result = await planTask(
    {
      prompt: "Сделай email-кампанию для нового релиза AutoCRM",
      taskType: "email_campaign"
    },
    {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    brand_name: "AutoCRM",
                    dna_exists: false
                  })
                }
              }
            ]
          };
        }
      }),
      skillsDir
    }
  );

  assert.equal(result.dna_exists, true);
  assert.equal(result.micro_plan.length, 20);
  assert.equal(result.skipped_units.length, 32);
});

test("planTask falls back locally when Hermes JSON is unusable", async () => {
  const result = await planTask(
    {
      prompt: "Сделай Twitter-пост и баннер для 'AutoCRM'",
      taskType: "twitter_post"
    },
    {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: "not valid json at all"
                }
              }
            ]
          };
        }
      }),
      skillsDir: path.join(os.tmpdir(), "muse-v6-missing-skills")
    }
  );

  assert.equal(result.brand_name, "AutoCRM");
  assert.equal(result.dna_exists, false);
  assert.equal(result.micro_plan.length, 52);
});

test("extractBrandName prefers AutoCRM over Russian filler words in release prompts", () => {
  assert.equal(
    extractBrandName("Сделай email-кампанию для нового релиза AutoCRM"),
    "AutoCRM"
  );
});

test("planTask respects explicit skipped_units from Hermes for partial DNA reuse", async () => {
  const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "muse-v6-partial-skips-"));
  await fs.writeFile(path.join(skillsDir, "AutoCRM_DNA.md"), "# AutoCRM Brand DNA", "utf-8");

  const result = await planTask(
    {
      prompt: "Сделай email-кампанию для нового релиза AutoCRM",
      taskType: "email_campaign"
    },
    {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    brand_name: "AutoCRM",
                    dna_exists: true,
                    skipped_units: ["product-summary", "voice-seed"]
                  })
                }
              }
            ]
          };
        }
      }),
      skillsDir
    }
  );

  assert.equal(result.dna_exists, true);
  assert.deepEqual(result.skipped_units, ["product-summary", "voice-seed"]);
  assert.equal(result.micro_plan.length, 50);
  assert.equal(result.reused_units, 2);
});

test("planTask uses exact DNA file matching instead of substring matching", async () => {
  const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "muse-v6-exact-match-"));
  await fs.writeFile(path.join(skillsDir, "AutoCRM_DNA.md"), "# AutoCRM Brand DNA", "utf-8");

  const result = await planTask(
    {
      prompt: "Сделай Twitter-пост для 'Auto'",
      taskType: "twitter_post"
    },
    {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    brand_name: "Auto",
                    dna_exists: true,
                    skipped_units: ["product-summary"]
                  })
                }
              }
            ]
          };
        }
      }),
      skillsDir
    }
  );

  assert.equal(result.brand_name, "Auto");
  assert.equal(result.dna_exists, false);
  assert.equal(result.micro_plan.length, 52);
});

test("buildDNA writes Hermes skill files and read/list helpers return them", async () => {
  const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "muse-v6-build-"));

  const dna = await buildDNA(
    {
      brandName: "AutoCRM",
      strategyResult: {
        blocks: [
          {
            unit: "product-summary",
            label: "Product Summary",
            dnaKey: "product.summary",
            output: { text: "AI dashboards for sales teams" }
          }
        ]
      },
      prompt: "Build DNA for AutoCRM"
    },
    {
      skillsDir,
      fetchImpl: async () => {
        throw new Error("Hermes offline");
      }
    }
  );

  const files = await listSkillFiles({ skillsDir });
  const content = await readSkillFile(dna.fileName, { skillsDir });

  assert.equal(dna.fileName, "AutoCRM_DNA.md");
  assert.deepEqual(files, ["AutoCRM_DNA.md"]);
  assert.match(content, /^# AutoCRM Brand DNA/m);
});

test("buildDNA preserves non-ASCII brand names in Hermes filenames", async () => {
  const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "muse-v6-unicode-brand-"));

  const dna = await buildDNA(
    {
      brandName: "АвтоCRM",
      strategyResult: {
        blocks: [
          {
            unit: "product-summary",
            label: "Product Summary",
            dnaKey: "product.summary",
            output: { text: "AI dashboards for sales teams" }
          }
        ]
      },
      prompt: "Build DNA for АвтоCRM"
    },
    {
      skillsDir,
      fetchImpl: async () => {
        throw new Error("Hermes offline");
      }
    }
  );

  assert.equal(dna.fileName, "АвтоCRM_DNA.md");
  assert.ok(await readSkillFile(dna.fileName, { skillsDir }));
});

test("runTask executes the investment flow and injects fresh DNA before the copy batch", async () => {
  const db = createDbMock();
  const socket = createSocketRecorder();
  const callOrder = [];
  const copyPayloads = [];
  const plan = {
    brand_name: "AutoCRM",
    dna_exists: false,
    dna_file: null,
    ...buildMicroEconomyPlan({ dnaExists: false })
  };

  const runTask = createTaskRunner({
    db,
    planTask: async () => plan,
    buildDNA: async () => ({
      fileName: "AutoCRM_DNA.md",
      dnaContent: "# AutoCRM Brand DNA\n\nFresh DNA"
    }),
    readSkillFile: async () => null,
    callAgent: async ({ payload, agentName }) => {
      const unitDefinition = getUnitDefinition(payload.unit);
      callOrder.push(agentName);

      if (payload.service === "copy") {
        copyPayloads.push(payload);
      }

      if (payload.service === "image" && payload.unit === "banner-render") {
        return {
          output: {
            url: "https://cdn.example.com/autocrm.png"
          },
          payment: {
            txHash: `0x${payload.unit}`,
            amountUsdc: unitDefinition.price,
            arcUrl: `https://testnet.arcscan.app/tx/0x${payload.unit}`
          }
        };
      }

      if (payload.service === "search") {
        return {
          output: {
            summary: `${payload.unit} summary`
          },
          payment: {
            txHash: `0x${payload.unit}`,
            amountUsdc: unitDefinition.price,
            arcUrl: `https://testnet.arcscan.app/tx/0x${payload.unit}`
          }
        };
      }

      if (payload.service === "copy" && payload.unit === "final-copy") {
        return {
          output: {
            text: "twitter_post"
          },
          payment: {
            txHash: `0x${payload.unit}`,
            amountUsdc: unitDefinition.price,
            arcUrl: `https://testnet.arcscan.app/tx/0x${payload.unit}`
          }
        };
      }

      return {
        output: {
          text: payload.unit
        },
        payment: {
          txHash: `0x${payload.unit}`,
          amountUsdc: unitDefinition.price,
          arcUrl: `https://testnet.arcscan.app/tx/0x${payload.unit}`
        }
      };
    }
  });

  const outcome = await runTask(
    {
      id: "task-1",
      prompt: "Сделай Twitter-пост и баннер для 'AutoCRM'",
      taskType: "twitter_post"
    },
    socket
  );

  assert.equal(outcome.plan.micro_plan.length, 52);
  assert.equal(outcome.transactions.length, 52);
  assert.equal(outcome.dnaFileCreated, "AutoCRM_DNA.md");
  assert.equal(outcome.result.text, "twitter_post");
  assert.equal(outcome.result.imageUrl, "https://cdn.example.com/autocrm.png");
  assert.ok(copyPayloads.every((payload) => payload.dnaContent === "# AutoCRM Brand DNA\n\nFresh DNA"));
  assert.equal(db.state.skills.length, 1);
  assert.equal(
    db.state.steps.filter((entry) => entry.status === "completed").length,
    52
  );
  assert.ok(socket.events.some((entry) => entry.event === "dna:created"));
  assert.ok(callOrder.includes("strategy.product-summary"));
  assert.ok(callOrder.includes("copy.final-copy"));
});

test("runTask skips reusable units when DNA already exists", async (t) => {
  // The orchestrator force-disables DNA reuse by default so every demo run
  // produces a fresh 50+-tx ledger. This test exercises the dividend flow
  // where reuse IS expected, so flip the flag for its scope only.
  const previousDisable = process.env.MUSE_DISABLE_DNA_REUSE;
  process.env.MUSE_DISABLE_DNA_REUSE = "false";
  t.after(() => {
    if (previousDisable === undefined) delete process.env.MUSE_DISABLE_DNA_REUSE;
    else process.env.MUSE_DISABLE_DNA_REUSE = previousDisable;
  });
  const db = createDbMock();
  const socket = createSocketRecorder();
  const callOrder = [];
  const plan = {
    brand_name: "AutoCRM",
    dna_exists: true,
    dna_file: "AutoCRM_DNA.md",
    ...buildMicroEconomyPlan({ dnaExists: true })
  };

  const runTask = createTaskRunner({
    db,
    planTask: async () => plan,
    readSkillFile: async () => "# AutoCRM Brand DNA\n\nMemory DNA",
    buildDNA: async () => {
      throw new Error("buildDNA should not run when DNA already exists");
    },
    callAgent: async ({ payload }) => {
      const unitDefinition = getUnitDefinition(payload.unit);
      callOrder.push(`${payload.service}.${payload.unit}`);

      return {
        output: payload.unit === "banner-render"
          ? { url: "https://cdn.example.com/dividend.png" }
          : payload.unit === "final-copy"
            ? { text: "email_campaign" }
            : { text: payload.unit, summary: `${payload.unit} summary` },
        payment: {
          txHash: `0x${payload.unit}`,
          amountUsdc: unitDefinition.price,
          arcUrl: `https://testnet.arcscan.app/tx/0x${payload.unit}`
        }
      };
    }
  });

  const outcome = await runTask(
    {
      id: "task-2",
      prompt: "Сделай email-кампанию для нового релиза AutoCRM",
      taskType: "email_campaign"
    },
    socket
  );

  assert.equal(outcome.transactions.length, 20);
  assert.equal(outcome.dnaFileCreated, "AutoCRM_DNA.md");
  assert.equal(outcome.result.text, "email_campaign");
  assert.equal(outcome.result.imageUrl, "https://cdn.example.com/dividend.png");
  assert.equal(
    db.state.steps.filter((entry) => entry.reusedFromDna).length,
    32
  );
  assert.ok(
    socket.events.some((entry) => entry.event === "unit:reused")
  );
  assert.equal(callOrder.length, 20);
});

test("runTask accepts DB-style snake_case task records", async () => {
  const db = createDbMock();
  const plan = {
    brand_name: "AutoCRM",
    dna_exists: true,
    dna_file: "AutoCRM_DNA.md",
    ...buildMicroEconomyPlan({ dnaExists: true })
  };

  const runTask = createTaskRunner({
    db,
    planTask: async () => plan,
    readSkillFile: async () => "# AutoCRM Brand DNA\n\nMemory DNA",
    buildDNA: async () => {
      throw new Error("buildDNA should not run");
    },
    callAgent: async ({ payload }) => {
      const unitDefinition = getUnitDefinition(payload.unit);

      return {
        output: payload.unit === "banner-render"
          ? { url: "https://cdn.example.com/dividend.png" }
          : payload.unit === "final-copy"
            ? { text: payload.taskType }
            : { text: payload.unit, summary: `${payload.unit} summary` },
        payment: {
          txHash: `0x${payload.unit}`,
          amountUsdc: unitDefinition.price,
          arcUrl: `https://testnet.arcscan.app/tx/0x${payload.unit}`
        }
      };
    }
  });

  const outcome = await runTask({
    id: "task-3",
    prompt: "Сделай email-кампанию для нового релиза AutoCRM",
    task_type: "email_campaign"
  });

  assert.equal(outcome.result.text, "email_campaign");
});

test("runTask rejects agent receipts whose settled amount does not match the unit catalog", async () => {
  const db = createDbMock();
  const socket = createSocketRecorder();
  const plan = {
    brand_name: "AutoCRM",
    dna_exists: false,
    dna_file: null,
    micro_plan: [getUnitDefinition("product-summary")],
    skipped_units: [],
    skipped_unit_definitions: [],
    estimated_cost_usdc: 0.005,
    investment_cost_usdc: 0.248,
    savings_usdc: 0,
    blueprint_total_units: 52,
    payable_units: 1,
    reused_units: 0,
    dna_blocks_total: 24
  };

  const runTask = createTaskRunner({
    db,
    planTask: async () => plan,
    readSkillFile: async () => null,
    buildDNA: async () => ({
      fileName: "AutoCRM_DNA.md",
      dnaContent: "# AutoCRM Brand DNA"
    }),
    callAgent: async () => ({
      output: { text: "bad receipt" },
      payment: {
        txHash: "0xwrongamount",
        amountUsdc: 1,
        arcUrl: "https://testnet.arcscan.app/tx/0xwrongamount"
      }
    })
  });

  const outcome = await runTask(
    {
      id: "task-bad-receipt",
      prompt: "Сделай Twitter-пост и баннер для 'AutoCRM'",
      taskType: "twitter_post"
    },
    socket
  );

  assert.equal(outcome, null);
  assert.ok(socket.events.some((entry) => entry.event === "task:error"));
});

test("runTask accepts gateway receipts with a transaction reference but no arcUrl", async () => {
  const db = createDbMock();
  const socket = createSocketRecorder();
  const unitDefinition = getUnitDefinition("product-summary");
  const plan = {
    brand_name: "AutoCRM",
    dna_exists: false,
    dna_file: null,
    micro_plan: [unitDefinition],
    skipped_units: [],
    skipped_unit_definitions: [],
    estimated_cost_usdc: unitDefinition.price,
    investment_cost_usdc: 0.248,
    savings_usdc: 0,
    blueprint_total_units: 52,
    payable_units: 1,
    reused_units: 0,
    dna_blocks_total: 24
  };

  const runTask = createTaskRunner({
    db,
    planTask: async () => plan,
    readSkillFile: async () => null,
    buildDNA: async () => ({
      fileName: "AutoCRM_DNA.md",
      dnaContent: "# AutoCRM Brand DNA"
    }),
    callAgent: async () => ({
      output: { text: "gateway receipt" },
      payment: {
        transaction: "gw_test_transfer_123",
        amountUsdc: unitDefinition.price,
        note: "Circle Gateway accepted the x402 payment"
      }
    })
  });

  const outcome = await runTask(
    {
      id: "task-gateway-receipt",
      prompt: "Create a strategy snapshot for AutoCRM",
      taskType: "twitter_post"
    },
    socket
  );

  assert.ok(outcome);
  assert.equal(outcome.transactions.length, 1);
  assert.equal(outcome.transactions[0].txHash, "gw_test_transfer_123");
  assert.equal(outcome.transactions[0].arcUrl, null);
  assert.equal(db.state.steps.at(-1)?.txHash, "gw_test_transfer_123");
});

test("runTask retries transient unit failures before succeeding", async () => {
  const db = createDbMock();
  const socket = createSocketRecorder();
  let attempts = 0;
  const plan = {
    brand_name: "AutoCRM",
    dna_exists: false,
    dna_file: null,
    micro_plan: [getUnitDefinition("product-summary")],
    skipped_units: [],
    skipped_unit_definitions: [],
    estimated_cost_usdc: 0.005,
    investment_cost_usdc: 0.248,
    savings_usdc: 0,
    blueprint_total_units: 52,
    payable_units: 1,
    reused_units: 0,
    dna_blocks_total: 24
  };

  const runTask = createTaskRunner({
    db,
    planTask: async () => plan,
    readSkillFile: async () => null,
    buildDNA: async () => ({
      fileName: "AutoCRM_DNA.md",
      dnaContent: "# AutoCRM Brand DNA"
    }),
    callAgent: async () => {
      attempts += 1;

      if (attempts < 3) {
        throw new Error("Agent strategy.product-summary failed with 429: rate limited");
      }

      return {
        output: { text: "ok" },
        payment: {
          txHash: "0xretried",
          amountUsdc: 0.005,
          arcUrl: "https://testnet.arcscan.app/tx/0xretried"
        }
      };
    }
  });

  const outcome = await runTask(
    {
      id: "task-retry",
      prompt: "Retry strategy for AutoCRM",
      taskType: "twitter_post"
    },
    socket
  );

  assert.equal(attempts, 3);
  assert.equal(outcome.transactions.length, 1);
  assert.equal(db.state.steps.filter((entry) => entry.status === "failed").length, 0);
});

test("runTask completes with warnings when only part of a batch fails", async () => {
  const db = createDbMock();
  const socket = createSocketRecorder();
  const plan = {
    brand_name: "AutoCRM",
    dna_exists: false,
    dna_file: null,
    micro_plan: [
      getUnitDefinition("product-summary"),
      getUnitDefinition("promise-core"),
      getUnitDefinition("final-copy"),
      getUnitDefinition("banner-render")
    ],
    skipped_units: [],
    skipped_unit_definitions: [],
    estimated_cost_usdc: 0.021,
    investment_cost_usdc: 0.248,
    savings_usdc: 0,
    blueprint_total_units: 52,
    payable_units: 4,
    reused_units: 0,
    dna_blocks_total: 24
  };

  const runTask = createTaskRunner({
    db,
    planTask: async () => plan,
    readSkillFile: async () => null,
    buildDNA: async () => ({
      fileName: "AutoCRM_DNA.md",
      dnaContent: "# AutoCRM Brand DNA\n\nPartial strategy"
    }),
    callAgent: async ({ payload }) => {
      if (payload.unit === "promise-core") {
        throw new Error("Agent strategy.promise-core failed with 500: upstream unavailable");
      }

      if (payload.unit === "final-copy") {
        return {
          output: { text: "copy ready" },
          payment: {
            txHash: "0xcopyready",
            amountUsdc: 0.005,
            arcUrl: "https://testnet.arcscan.app/tx/0xcopyready"
          }
        };
      }

      if (payload.unit === "banner-render") {
        return {
          output: { url: "https://cdn.example.com/partial.png" },
          payment: {
            txHash: "0ximagepartial",
            amountUsdc: 0.006,
            arcUrl: "https://testnet.arcscan.app/tx/0ximagepartial"
          }
        };
      }

      return {
        output: { text: payload.unit },
        payment: {
          txHash: `0x${payload.unit}`,
          amountUsdc: 0.005,
          arcUrl: `https://testnet.arcscan.app/tx/0x${payload.unit}`
        }
      };
    }
  });

  const outcome = await runTask(
    {
      id: "task-partial",
      prompt: "Partial batch failure for AutoCRM",
      taskType: "twitter_post"
    },
    socket
  );

  assert.ok(outcome);
  assert.equal(outcome.transactions.length, 3);
  assert.equal(outcome.result.metrics.failedUnits, 1);
  assert.ok(socket.events.some((entry) => entry.event === "task:warning"));
  assert.ok(socket.events.some((entry) => entry.event === "task:completed"));
  assert.equal(db.state.steps.filter((entry) => entry.status === "failed").length, 1);
});

test("runTask does not repay a unit when DB persistence retries after settlement", async () => {
  const db = createDbMock();
  const socket = createSocketRecorder();
  const unitDefinition = getUnitDefinition("news-query");
  const plan = {
    brand_name: "AutoCRM",
    dna_exists: false,
    dna_file: null,
    micro_plan: [unitDefinition],
    skipped_units: [],
    skipped_unit_definitions: [],
    estimated_cost_usdc: unitDefinition.price,
    investment_cost_usdc: unitDefinition.price,
    savings_usdc: 0,
    blueprint_total_units: 1,
    payable_units: 1,
    reused_units: 0,
    dna_blocks_total: 24
  };
  const unitCalls = [];

  let stepInsertAttempts = 0;
  db.steps.create = async (data) => {
    if (data.serviceName === "search" && data.unitName === "news-query") {
      stepInsertAttempts += 1;

      if (stepInsertAttempts === 1) {
        const error = new Error("database timeout while writing settled step");
        error.code = "ETIMEDOUT";
        throw error;
      }
    }

    db.state.steps.push(data);
    return data;
  };

  const runTask = createTaskRunner({
    db,
    planTask: async () => plan,
    buildDNA: async () => ({
      fileName: "AutoCRM_DNA.md",
      dnaContent: "# AutoCRM Brand DNA"
    }),
    readSkillFile: async () => null,
    callAgent: async ({ payload }) => {
      unitCalls.push(`${payload.service}.${payload.unit}`);
      const unitDefinition = getUnitDefinition(payload.unit);

      return {
        output: { text: payload.unit },
        payment: {
          txHash: `0x${payload.unit}`,
          amountUsdc: unitDefinition.price,
          arcUrl: `https://testnet.arcscan.app/tx/0x${payload.unit}`
        }
      };
    }
  });

  await runTask({
    id: "task-db-retry",
    prompt: "Create a fast AutoCRM update",
    taskType: "twitter_post",
    budgetUsdc: 2
  }, socket);

  assert.equal(
    unitCalls.filter((entry) => entry === "search.news-query").length,
    1
  );
  assert.equal(stepInsertAttempts, 2);
});

test("runTask counts settled unit exactly once even if the DB retry also throws mid-loop", async () => {
  const db = createDbMock();
  const socket = createSocketRecorder();
  const unitDefinition = getUnitDefinition("product-summary");
  const plan = {
    brand_name: "AutoCRM",
    dna_exists: false,
    dna_file: null,
    micro_plan: [unitDefinition],
    skipped_units: [],
    skipped_unit_definitions: [],
    estimated_cost_usdc: unitDefinition.price,
    investment_cost_usdc: unitDefinition.price,
    savings_usdc: 0,
    blueprint_total_units: 52,
    payable_units: 1,
    reused_units: 0,
    dna_blocks_total: 24
  };

  // Fail the steps.create only on the first outer attempt so the orchestrator
  // re-enters the retry loop (settledExecution already set). Before the
  // accounting guard was added, this double-counted totalSpent / transactions
  // and re-emitted dna:progress for strategy units.
  let stepInsertAttempts = 0;
  db.steps.create = async (data) => {
    if (data.serviceName === "strategy" && data.unitName === "product-summary") {
      stepInsertAttempts += 1;
      if (stepInsertAttempts === 1) {
        const error = new Error("database timeout while writing settled step");
        error.code = "ETIMEDOUT";
        throw error;
      }
    }
    db.state.steps.push(data);
    return data;
  };

  let callCount = 0;
  const runTask = createTaskRunner({
    db,
    planTask: async () => plan,
    buildDNA: async () => ({
      fileName: "AutoCRM_DNA.md",
      dnaContent: "# AutoCRM Brand DNA"
    }),
    readSkillFile: async () => null,
    callAgent: async ({ payload }) => {
      callCount += 1;
      const definition = getUnitDefinition(payload.unit);
      return {
        output: { text: payload.unit },
        payment: {
          txHash: `0x${payload.unit}`,
          amountUsdc: definition.price,
          arcUrl: `https://testnet.arcscan.app/tx/0x${payload.unit}`
        }
      };
    }
  });

  const outcome = await runTask(
    {
      id: "task-accounting-guard",
      prompt: "AutoCRM with a flaky steps table",
      taskType: "twitter_post"
    },
    socket
  );

  assert.ok(outcome);
  // callAgent must fire exactly once — payment is already settled.
  assert.equal(callCount, 1);
  // totalSpent must be charged exactly once.
  assert.equal(outcome.totalSpent, unitDefinition.price);
  // transactions list must contain exactly one entry (no duplicate on retry).
  assert.equal(outcome.transactions.length, 1);
  // unit:validated must fire once, not once-per-retry.
  assert.equal(
    socket.events.filter((entry) => entry.event === "unit:validated").length,
    1
  );
  // dna:progress must fire exactly once for the strategy unit.
  assert.equal(
    socket.events.filter((entry) => entry.event === "dna:progress").length,
    1
  );
});

test("runTask stops before execution when the plan exceeds the task budget", async () => {
  const db = createDbMock();
  const socket = createSocketRecorder();
  let agentCalls = 0;
  const plan = {
    brand_name: "AutoCRM",
    dna_exists: false,
    dna_file: null,
    micro_plan: [getUnitDefinition("product-summary"), getUnitDefinition("final-copy")],
    skipped_units: [],
    skipped_unit_definitions: [],
    estimated_cost_usdc: 0.01,
    investment_cost_usdc: 0.248,
    savings_usdc: 0,
    blueprint_total_units: 52,
    payable_units: 2,
    reused_units: 0,
    dna_blocks_total: 24
  };

  const runTask = createTaskRunner({
    db,
    planTask: async () => plan,
    readSkillFile: async () => null,
    buildDNA: async () => {
      throw new Error("buildDNA should not run for over-budget tasks");
    },
    callAgent: async () => {
      agentCalls += 1;
      throw new Error("callAgent should not run for over-budget tasks");
    }
  });

  const outcome = await runTask(
    {
      id: "task-budget-guard",
      prompt: "Keep AutoCRM under budget",
      taskType: "twitter_post",
      budget_usdc: 0.005
    },
    socket
  );

  assert.equal(outcome, null);
  assert.equal(agentCalls, 0);
  assert.ok(socket.events.some((entry) => entry.event === "task:error"));
  assert.equal(db.state.steps.length, 0);
  assert.equal(
    db.state.taskUpdates.at(-1)?.data?.status,
    "failed"
  );
});

// orchestrator.js transitively imports db/index.js, which spins up a pg.Pool
// at module load time. Without explicit teardown, pg's reaper interval keeps
// the event loop alive after the last test resolves and `node --test` hangs.
test("teardown :: close pg pool", async () => {
  await realDb.close().catch(() => {});
});
