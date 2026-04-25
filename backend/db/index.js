import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const DEFAULT_DATABASE_URL = "postgresql://muse:muse@localhost:5432/muse";
const DATABASE_URL = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
const REQUESTED_DB_MODE = process.env.DB_MODE || "auto";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PENDING_REPLAYS_FILE = resolve(__dirname, "..", "data", "pending-replays.json");
const PENDING_REPLAYS_TMP_FILE = `${PENDING_REPLAYS_FILE}.tmp`;

const pool = new Pool({
  connectionString: DATABASE_URL
});

let activeDatabaseMode = REQUESTED_DB_MODE === "memory" ? "memory" : "postgres";
let memoryFallbackReason = null;
let hasLoggedMemoryFallback = false;
let schemaEnsured = false;
let schemaPromise = null;
let reconnectTimer = null;
const RECONNECT_INTERVAL_MS = 60_000;

// Memory-fallback cap — when Postgres is down for hours we must not let the
// in-memory store grow unbounded. Each table trims the oldest 20% once the
// cap is crossed so the most recent work stays visible to the UI.
const MEMORY_STORE_MAX_ROWS = Math.max(
  200,
  Number(process.env.MUSE_MEMORY_FALLBACK_MAX_ROWS || 10_000)
);

const memoryStore = {
  tasks: [],
  steps: [],
  skills: []
};
const pendingReplays = new Map();
const reconnectListeners = new Set();
let pendingReplaysLoaded = false;

function trimMemoryArray(arr) {
  if (arr.length <= MEMORY_STORE_MAX_ROWS) return;
  const dropCount = Math.ceil(arr.length * 0.2);
  arr.splice(0, dropCount);
}

function enforceMemoryCaps() {
  trimMemoryArray(memoryStore.tasks);
  trimMemoryArray(memoryStore.steps);
  trimMemoryArray(memoryStore.skills);
}

const KEY_OVERRIDES = {
  taskId: "task_id",
  taskType: "task_type",
  brandName: "brand_name",
  budgetUsdc: "budget_usdc",
  estimatedCostUsdc: "estimated_cost_usdc",
  investmentCostUsdc: "investment_cost_usdc",
  totalSpentUsdc: "total_spent_usdc",
  savingsUsdc: "savings_usdc",
  dnaExists: "dna_exists",
  dnaFileCreated: "dna_file_created",
  planSteps: "plan_steps",
  planSkipped: "plan_skipped",
  errorLog: "error_log",
  completedAt: "completed_at",
  serviceName: "service_name",
  unitName: "unit_name",
  costUsdc: "cost_usdc",
  txHash: "tx_hash",
  arcUrl: "arc_url",
  paymentNetwork: "payment_network",
  paymentNote: "payment_note",
  reusedFromDna: "reused_from_dna",
  dnaSectionKey: "dna_section_key",
  outputJson: "output_json",
  startedAt: "started_at",
  skillName: "skill_name",
  timesApplied: "times_applied",
  totalSavedUsdc: "total_saved_usdc"
};

const SCHEMA_STATEMENTS = [
  "CREATE EXTENSION IF NOT EXISTS pgcrypto",
  `CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prompt TEXT NOT NULL,
    task_type VARCHAR(50),
    brand_name VARCHAR(255),
    status VARCHAR(20) DEFAULT 'running',
    budget_usdc DECIMAL(12,6),
    estimated_cost_usdc DECIMAL(12,6),
    investment_cost_usdc DECIMAL(12,6),
    total_spent_usdc DECIMAL(12,6) DEFAULT 0,
    savings_usdc DECIMAL(12,6) DEFAULT 0,
    dna_exists BOOLEAN DEFAULT FALSE,
    dna_file_created VARCHAR(255),
    plan_steps TEXT[],
    plan_skipped TEXT[],
    result JSONB,
    error_log TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS task_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id),
    service_name VARCHAR(50),
    unit_name VARCHAR(50),
    status VARCHAR(20),
    cost_usdc DECIMAL(12,6),
    tx_hash VARCHAR(255),
    arc_url TEXT,
    payment_network VARCHAR(64),
    payment_note TEXT,
    reused_from_dna BOOLEAN DEFAULT FALSE,
    dna_section_key VARCHAR(100),
    output_json JSONB,
    error_log TEXT,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES tasks(id),
    skill_name VARCHAR(255),
    times_applied INTEGER DEFAULT 0,
    total_saved_usdc DECIMAL(12,6) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `DELETE FROM task_steps a
     USING task_steps b
     WHERE a.ctid < b.ctid
       AND a.task_id = b.task_id
       AND a.service_name = b.service_name
       AND a.unit_name = b.unit_name
       AND NOT EXISTS (
         SELECT 1 FROM pg_indexes WHERE indexname = 'task_steps_task_service_unit_unique'
       )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS task_steps_task_service_unit_unique ON task_steps (task_id, service_name, unit_name)",
  `DELETE FROM skills a
     USING skills b
     WHERE a.ctid < b.ctid
       AND a.task_id = b.task_id
       AND a.skill_name = b.skill_name
       AND NOT EXISTS (
         SELECT 1 FROM pg_indexes WHERE indexname = 'skills_task_skill_name_unique'
       )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS skills_task_skill_name_unique ON skills (task_id, skill_name)",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS prompt TEXT",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type VARCHAR(50)",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS brand_name VARCHAR(255)",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'running'",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_usdc DECIMAL(12,6)",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimated_cost_usdc DECIMAL(12,6)",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS investment_cost_usdc DECIMAL(12,6)",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS total_spent_usdc DECIMAL(12,6) DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS savings_usdc DECIMAL(12,6) DEFAULT 0",
  "ALTER TABLE tasks ALTER COLUMN budget_usdc TYPE DECIMAL(12,6)",
  "ALTER TABLE tasks ALTER COLUMN estimated_cost_usdc TYPE DECIMAL(12,6)",
  "ALTER TABLE tasks ALTER COLUMN investment_cost_usdc TYPE DECIMAL(12,6)",
  "ALTER TABLE tasks ALTER COLUMN total_spent_usdc TYPE DECIMAL(12,6)",
  "ALTER TABLE tasks ALTER COLUMN savings_usdc TYPE DECIMAL(12,6)",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dna_exists BOOLEAN DEFAULT FALSE",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dna_file_created VARCHAR(255)",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_steps TEXT[]",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_skipped TEXT[]",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result JSONB",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS error_log TEXT",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()",
  "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS service_name VARCHAR(50)",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS unit_name VARCHAR(50)",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS status VARCHAR(20)",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS cost_usdc DECIMAL(12,6)",
  "ALTER TABLE task_steps ALTER COLUMN cost_usdc TYPE DECIMAL(12,6)",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS tx_hash VARCHAR(255)",
  "ALTER TABLE task_steps ALTER COLUMN tx_hash TYPE VARCHAR(255)",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS arc_url TEXT",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS payment_network VARCHAR(64)",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS payment_note TEXT",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS reused_from_dna BOOLEAN DEFAULT FALSE",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS dna_section_key VARCHAR(100)",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS output_json JSONB",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS error_log TEXT",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT NOW()",
  "ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ",
  "ALTER TABLE skills ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES tasks(id)",
  "ALTER TABLE skills ADD COLUMN IF NOT EXISTS skill_name VARCHAR(255)",
  "ALTER TABLE skills ADD COLUMN IF NOT EXISTS times_applied INTEGER DEFAULT 0",
  "ALTER TABLE skills ADD COLUMN IF NOT EXISTS total_saved_usdc DECIMAL(12,6) DEFAULT 0",
  "ALTER TABLE skills ALTER COLUMN total_saved_usdc TYPE DECIMAL(12,6)",
  "ALTER TABLE skills ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()",
  // 1:1 persistent mapping of MetaMask main wallet → Circle-managed orchestrator.
  // Keyed on the lowercased main wallet so we always return the same orchestrator
  // for a given user across sessions and restarts.
  `CREATE TABLE IF NOT EXISTS orchestrator_wallets (
    main_wallet TEXT PRIMARY KEY,
    circle_wallet_id TEXT NOT NULL,
    address TEXT NOT NULL,
    mode VARCHAR(24) NOT NULL DEFAULT 'circle',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`
];

function toSnakeCaseKey(key) {
  if (KEY_OVERRIDES[key]) {
    return KEY_OVERRIDES[key];
  }

  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// H1 fix: allow-list of valid column names to prevent SQL injection through column names.
const ALLOWED_COLUMNS = new Set([
  ...Object.values(KEY_OVERRIDES),
  "id", "prompt", "task_type", "brand_name", "status", "budget_usdc",
  "estimated_cost_usdc", "investment_cost_usdc", "total_spent_usdc",
  "savings_usdc", "dna_exists", "dna_file_created", "plan_steps",
  "plan_skipped", "result", "error_log", "created_at", "completed_at",
  "task_id", "service_name", "unit_name", "cost_usdc", "tx_hash",
  "arc_url", "payment_network", "payment_note", "reused_from_dna",
  "dna_section_key", "output_json", "started_at",
  "skill_name", "times_applied", "total_saved_usdc"
]);

function validateColumnName(column) {
  if (!ALLOWED_COLUMNS.has(column)) {
    throw new Error(`Invalid column name: ${column}`);
  }
  return column;
}

function normalizeInput(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      const snakeKey = toSnakeCaseKey(key);
      validateColumnName(snakeKey);
      return [snakeKey, value];
    })
  );
}


function cloneRow(row) {
  return JSON.parse(JSON.stringify(row));
}

function createTimestamp() {
  return new Date().toISOString();
}

function getPendingReplayKey(table, id) {
  return `${table}:${id}`;
}

function loadPendingReplaysFromDisk() {
  if (pendingReplaysLoaded) {
    return;
  }

  pendingReplaysLoaded = true;

  try {
    if (!existsSync(PENDING_REPLAYS_FILE)) {
      return;
    }

    const raw = readFileSync(PENDING_REPLAYS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed : parsed?.entries;

    if (!Array.isArray(entries)) {
      return;
    }

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const table = String(entry.table || "");
      const id = String(entry.id || "");
      const data = entry.data && typeof entry.data === "object" ? entry.data : null;

      if (!table || !id || !data) {
        continue;
      }

      const normalizedData = normalizeInput(data);
      pendingReplays.set(getPendingReplayKey(table, id), {
        op: entry.op === "update" ? "update" : "insert",
        table,
        id,
        data: cloneRow(normalizedData),
        queuedAt: typeof entry.queuedAt === "string" ? entry.queuedAt : createTimestamp()
      });
    }

    if (pendingReplays.size > 0) {
      console.info(`[db] Loaded ${pendingReplays.size} pending replay(s) from ${PENDING_REPLAYS_FILE}.`);
    }
  } catch (error) {
    console.warn(`[db] Failed to load pending replays from ${PENDING_REPLAYS_FILE}: ${error?.message || error}`);
  }
}

function persistPendingReplaysSnapshot() {
  try {
    if (pendingReplays.size === 0) {
      if (existsSync(PENDING_REPLAYS_TMP_FILE)) {
        rmSync(PENDING_REPLAYS_TMP_FILE, { force: true });
      }
      if (existsSync(PENDING_REPLAYS_FILE)) {
        rmSync(PENDING_REPLAYS_FILE, { force: true });
      }
      return;
    }

    mkdirSync(dirname(PENDING_REPLAYS_FILE), { recursive: true });
    const snapshot = Array.from(pendingReplays.values()).map((entry) => cloneRow(entry));
    writeFileSync(PENDING_REPLAYS_TMP_FILE, JSON.stringify(snapshot, null, 2), "utf-8");
    renameSync(PENDING_REPLAYS_TMP_FILE, PENDING_REPLAYS_FILE);
  } catch (error) {
    console.warn(`[db] Failed to persist pending replays to ${PENDING_REPLAYS_FILE}: ${error?.message || error}`);
  }
}

function capturePendingReplay(op, table, row) {
  if (!row || typeof row !== "object" || !row.id) {
    return;
  }

  loadPendingReplaysFromDisk();

  const id = String(row.id);
  const key = getPendingReplayKey(table, id);
  const normalizedRow = normalizeInput(row);
  const existing = pendingReplays.get(key);
  const mergedData = existing
    ? { ...existing.data, ...normalizedRow }
    : normalizedRow;

  pendingReplays.set(key, {
    op: existing?.op === "insert" ? "insert" : op,
    table,
    id,
    data: cloneRow(mergedData),
    queuedAt: existing?.queuedAt || createTimestamp()
  });
}

loadPendingReplaysFromDisk();
process.on("SIGTERM", persistPendingReplaysSnapshot);
process.on("SIGINT", persistPendingReplaysSnapshot);

function isRecoverableDatabaseError(error) {
  const recoverableCodes = new Set([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "57P01"
  ]);

  return Boolean(
    error?.code && recoverableCodes.has(error.code)
  ) || /connect|database|postgres|ECONNREFUSED|terminated/i.test(String(error?.message || ""));
}

function activateMemoryFallback(error) {
  activeDatabaseMode = "memory-fallback";
  memoryFallbackReason = error?.message || "Database unavailable";

  if (!hasLoggedMemoryFallback) {
    console.warn(
      `Postgres unavailable. Falling back to in-memory demo DB temporarily. Reason: ${memoryFallbackReason}`
    );
    hasLoggedMemoryFallback = true;
  }

  // H9 fix: schedule periodic reconnection attempts.
  scheduleReconnect();
}

async function notifyReconnectListeners(context) {
  if (reconnectListeners.size === 0) {
    return;
  }

  const settled = await Promise.allSettled(
    Array.from(reconnectListeners, (listener) => listener(context))
  );

  for (const result of settled) {
    if (result.status === "rejected") {
      console.error("[db] reconnect-listener-failed:", result.reason?.message || result.reason);
    }
  }
}

async function restorePostgresConnection(reason = "reconnect") {
  await pool.query("SELECT 1");
  schemaEnsured = false;
  schemaPromise = null;
  await ensureSchema();
  const replaySummary = await drainPendingReplays();
  activeDatabaseMode = "postgres";
  memoryFallbackReason = null;
  hasLoggedMemoryFallback = false;
  console.info("Postgres reconnected — switching back from memory-fallback mode.");
  await notifyReconnectListeners({ reason, ...replaySummary });
}

function scheduleReconnect() {
  if (reconnectTimer || REQUESTED_DB_MODE === "memory") {
    return;
  }

  reconnectTimer = setInterval(async () => {
    try {
      await restorePostgresConnection("interval");
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    } catch {
      // Still down — try again next interval.
    }
  }, RECONNECT_INTERVAL_MS);

  if (reconnectTimer.unref) {
    reconnectTimer.unref();
  }

  return;

  reconnectTimer = setInterval(async () => {
    try {
      await pool.query("SELECT 1");
      // Postgres is back — reset state and re-run schema migration.
      activeDatabaseMode = "postgres";
      memoryFallbackReason = null;
      schemaEnsured = false;
      schemaPromise = null;
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      console.info("Postgres reconnected — switching back from memory-fallback mode.");
    } catch {
      // Still down — try again next interval.
    }
  }, RECONNECT_INTERVAL_MS);

  // Don't keep the process alive just for this timer.
  if (reconnectTimer.unref) {
    reconnectTimer.unref();
  }
}

pool.on("error", (error) => {
  console.warn(`[db] pg pool error: ${error?.message || error}`);
  schemaEnsured = false;
  schemaPromise = null;

  if (REQUESTED_DB_MODE !== "memory" && activeDatabaseMode !== "memory") {
    activateMemoryFallback(error);
  }
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function ensureSchema() {
  if (REQUESTED_DB_MODE === "memory" || activeDatabaseMode === "memory" || schemaEnsured) {
    return;
  }

  if (!schemaPromise) {
    schemaPromise = (async () => {
      for (const statement of SCHEMA_STATEMENTS) {
        await query(statement);
      }

      schemaEnsured = true;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }

  await schemaPromise;
}

async function withDatabaseFallback(postgresAction, memoryAction, options = {}) {
  const runMemoryAction = () => {
    const result = memoryAction();
    options.onMemoryResult?.(result);
    return result;
  };

  if (
    REQUESTED_DB_MODE === "memory" ||
    activeDatabaseMode === "memory" ||
    activeDatabaseMode === "memory-fallback"
  ) {
    return runMemoryAction();
  }

  try {
    await ensureSchema();
    return await postgresAction();
  } catch (error) {
    if (REQUESTED_DB_MODE === "postgres" || !isRecoverableDatabaseError(error)) {
      throw error;
    }

    activateMemoryFallback(error);
    return runMemoryAction();
  }
}

// M11 fix: table name allow-list to prevent SQL injection through table names.
const ALLOWED_TABLES = new Set(["tasks", "task_steps", "skills"]);

function validateTableName(table) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  return table;
}

async function insertRow(table, data, returning = "*") {
  validateTableName(table);
  const normalized = normalizeInput(data);
  const keys = Object.keys(normalized);
  const values = Object.values(normalized);

  const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
  const columns = keys.join(", ");

  const result = await query(
    `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) RETURNING ${returning}`,
    values
  );

  return result.rows[0];
}

async function upsertTaskStepRow(data) {
  const normalized = normalizeInput(data);
  const keys = Object.keys(normalized);
  const values = Object.values(normalized);
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
  const columns = keys.join(", ");

  const result = await query(
    `INSERT INTO task_steps (${columns}) VALUES (${placeholders})
     ON CONFLICT (task_id, service_name, unit_name) DO UPDATE SET
       status = EXCLUDED.status,
       cost_usdc = EXCLUDED.cost_usdc,
       tx_hash = EXCLUDED.tx_hash,
       arc_url = EXCLUDED.arc_url,
       payment_network = EXCLUDED.payment_network,
       payment_note = EXCLUDED.payment_note,
       reused_from_dna = EXCLUDED.reused_from_dna,
       dna_section_key = EXCLUDED.dna_section_key,
       output_json = EXCLUDED.output_json,
       error_log = EXCLUDED.error_log,
       completed_at = EXCLUDED.completed_at
     RETURNING *`,
    values
  );

  return result.rows[0];
}

async function upsertSkillRow(data) {
  const normalized = normalizeInput(data);
  const keys = Object.keys(normalized);
  const values = Object.values(normalized);
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
  const columns = keys.join(", ");

  const result = await query(
    `INSERT INTO skills (${columns}) VALUES (${placeholders})
     ON CONFLICT (task_id, skill_name) DO UPDATE SET
       skill_name = EXCLUDED.skill_name,
       times_applied = EXCLUDED.times_applied,
       total_saved_usdc = EXCLUDED.total_saved_usdc
     RETURNING *`,
    values
  );

  return result.rows[0];
}

async function updateRow(table, id, data) {
  validateTableName(table);
  const normalized = normalizeInput(data);
  const keys = Object.keys(normalized);

  if (keys.length === 0) {
    return null;
  }

  const assignments = keys.map((key, index) => `${key} = $${index + 1}`).join(", ");
  const values = [...Object.values(normalized), id];

  const result = await query(
    `UPDATE ${table} SET ${assignments} WHERE id = $${keys.length + 1} RETURNING *`,
    values
  );

  return result.rows[0] || null;
}

async function upsertRowById(table, data) {
  validateTableName(table);
  const normalized = normalizeInput(data);
  const keys = Object.keys(normalized);

  if (keys.length === 0) {
    return null;
  }

  const values = Object.values(normalized);
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
  const assignments = keys
    .filter((key) => key !== "id")
    .map((key) => `${key} = EXCLUDED.${key}`)
    .join(", ");
  const conflictUpdate = assignments || "id = EXCLUDED.id";

  const result = await query(
    `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${conflictUpdate}
     RETURNING *`,
    values
  );

  return result.rows[0] || null;
}

async function drainPendingReplays() {
  loadPendingReplaysFromDisk();

  if (pendingReplays.size === 0) {
    return { drained: 0, remaining: 0 };
  }

  let drained = 0;

  for (const [key, entry] of Array.from(pendingReplays.entries())) {
    try {
      if (entry.table === "tasks") {
        await upsertRowById("tasks", entry.data);
      } else if (entry.table === "task_steps") {
        await upsertTaskStepRow(entry.data);
      } else if (entry.table === "skills") {
        await upsertSkillRow(entry.data);
      } else {
        throw new Error(`Unsupported replay table: ${entry.table}`);
      }

      pendingReplays.delete(key);
      drained += 1;
    } catch (error) {
      if (isRecoverableDatabaseError(error)) {
        persistPendingReplaysSnapshot();
        throw error;
      }

      console.error(
        "[db] reconcile-failed:",
        `${entry.table}:${entry.id}`,
        error?.message || error
      );
    }
  }

  persistPendingReplaysSnapshot();

  if (drained > 0) {
    console.info(`[db] Reconciled ${drained} pending replay(s) to Postgres.`);
  }

  return { drained, remaining: pendingReplays.size };
}

function memoryCreateTask(data) {
  const normalized = normalizeInput(data);
  const task = {
    id: randomUUID(),
    status: "running",
    total_spent_usdc: 0,
    savings_usdc: 0,
    dna_exists: false,
    created_at: createTimestamp(),
    completed_at: null,
    ...normalized
  };

  memoryStore.tasks.push(task);
  enforceMemoryCaps();
  return cloneRow(task);
}

function syncMemoryTask(row) {
  const existing = memoryStore.tasks.find((entry) => entry.id === row.id);

  if (existing) {
    Object.assign(existing, cloneRow(row));
    return cloneRow(existing);
  }

  memoryStore.tasks.push(cloneRow(row));
  enforceMemoryCaps();
  return cloneRow(row);
}

function memoryUpdateTask(id, data) {
  const normalized = normalizeInput(data);
  const task = memoryStore.tasks.find((entry) => entry.id === id);

  if (!task) {
    return null;
  }

  Object.assign(task, normalized);
  return cloneRow(task);
}

function memoryFindTask(id) {
  const task = memoryStore.tasks.find((entry) => entry.id === id);
  return task ? cloneRow(task) : null;
}

function memoryFindAllTasks() {
  return memoryStore.tasks
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 20)
    .map(cloneRow);
}

function memoryFindTasksByStatuses(statuses) {
  const statusSet = new Set((statuses || []).map((status) => String(status)));

  return memoryStore.tasks
    .filter((task) => statusSet.has(String(task.status || "")))
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(cloneRow);
}

function memoryFindTaskSummary() {
  return memoryStore.tasks.reduce(
    (summary, task) => {
      if (task.status !== "completed") {
        return summary;
      }

      summary.completedTasks += 1;
      summary.spent += Number(task.total_spent_usdc || 0);
      summary.saved += Number(task.savings_usdc || 0);
      summary.paidUnits += Number(task.result?.metrics?.paidMicroPayments || 0);
      summary.reusedUnits += Number(task.result?.metrics?.reusedUnits || 0);
      return summary;
    },
    {
      completedTasks: 0,
      spent: 0,
      saved: 0,
      paidUnits: 0,
      reusedUnits: 0
    }
  );
}

function memoryCreateStep(data) {
  const normalized = normalizeInput(data);
  const existing = memoryStore.steps.find(
    (entry) =>
      entry.task_id === normalized.task_id &&
      entry.service_name === normalized.service_name &&
      entry.unit_name === normalized.unit_name
  );

  if (existing) {
    Object.assign(existing, normalized, {
      completed_at: normalized.completed_at || existing.completed_at || createTimestamp()
    });
    return cloneRow(existing);
  }

  const step = {
    id: randomUUID(),
    started_at: normalized.started_at || createTimestamp(),
    completed_at: normalized.completed_at || createTimestamp(),
    ...normalized
  };

  memoryStore.steps.push(step);
  enforceMemoryCaps();
  return cloneRow(step);
}

function syncMemoryStep(row) {
  return memoryCreateStep(row);
}

function memoryFindSteps(taskId) {
  return memoryStore.steps
    .filter((step) => step.task_id === taskId)
    .slice()
    .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
    .map(cloneRow);
}

function memoryCreateSkill(data) {
  const normalized = normalizeInput(data);
  const existing = memoryStore.skills.find(
    (entry) =>
      entry.task_id === normalized.task_id &&
      entry.skill_name === normalized.skill_name
  );

  if (existing) {
    Object.assign(existing, normalized);
    return cloneRow(existing);
  }

  const skill = {
    id: randomUUID(),
    times_applied: 0,
    total_saved_usdc: 0,
    created_at: createTimestamp(),
    ...normalized
  };

  memoryStore.skills.push(skill);
  enforceMemoryCaps();
  return cloneRow(skill);
}

function syncMemorySkill(row) {
  return memoryCreateSkill(row);
}

function memoryFindSkills() {
  return memoryStore.skills
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(cloneRow);
}

export const db = {
  async initialize() {
    loadPendingReplaysFromDisk();

    if (REQUESTED_DB_MODE === "memory" || activeDatabaseMode === "memory") {
      return {
        ok: true,
        mode: "memory",
        pendingReplays: pendingReplays.size
      };
    }

    try {
      await restorePostgresConnection("startup");
      return {
        ok: true,
        mode: "postgres",
        pendingReplays: pendingReplays.size
      };
    } catch (error) {
      if (REQUESTED_DB_MODE === "postgres" || !isRecoverableDatabaseError(error)) {
        throw error;
      }

      activateMemoryFallback(error);
      persistPendingReplaysSnapshot();
      return {
        ok: true,
        mode: "memory-fallback",
        pendingReplays: pendingReplays.size
      };
    }
  },

  async healthcheck() {
    if (REQUESTED_DB_MODE === "memory") {
      return {
        ok: true,
        mode: "memory",
        reason: null
      };
    }

    if (activeDatabaseMode === "memory-fallback") {
      return {
        ok: true,
        mode: "memory-fallback",
        reason: memoryFallbackReason
      };
    }

    try {
      await query("SELECT 1");
      await ensureSchema();

      return {
        ok: true,
        mode: "postgres",
        reason: null
      };
    } catch (error) {
      if (REQUESTED_DB_MODE !== "postgres" && isRecoverableDatabaseError(error)) {
        activateMemoryFallback(error);
        return {
          ok: true,
          mode: "memory-fallback",
          reason: memoryFallbackReason
        };
      }

      throw error;
    }
  },

  async close() {
    persistPendingReplaysSnapshot();
    await pool.end();
  },

  onReconnect(listener) {
    reconnectListeners.add(listener);
    return () => reconnectListeners.delete(listener);
  },

  getMode() {
    return activeDatabaseMode;
  },

  tasks: {
    async create(data) {
      return withDatabaseFallback(
        async () => syncMemoryTask(await insertRow("tasks", data)),
        () => memoryCreateTask(data),
        {
          onMemoryResult: (row) => capturePendingReplay("insert", "tasks", row)
        }
      );
    },

    async update(id, data) {
      return withDatabaseFallback(
        async () => {
          const row = await updateRow("tasks", id, data);
          return row ? syncMemoryTask(row) : null;
        },
        () => memoryUpdateTask(id, data),
        {
          onMemoryResult: (row) => capturePendingReplay("update", "tasks", row)
        }
      );
    },

    async findById(id) {
      return withDatabaseFallback(
        async () => {
          const result = await query("SELECT * FROM tasks WHERE id = $1", [id]);
          const row = result.rows[0] || null;
          return row ? syncMemoryTask(row) : null;
        },
        () => memoryFindTask(id)
      );
    },

    async findAll() {
      return withDatabaseFallback(
        async () => {
          const result = await query(
            "SELECT * FROM tasks ORDER BY created_at DESC LIMIT 20"
          );
          return result.rows.map((row) => syncMemoryTask(row));
        },
        () => memoryFindAllTasks()
      );
    },

    async findByStatuses(statuses) {
      return withDatabaseFallback(
        async () => {
          const result = await query(
            "SELECT * FROM tasks WHERE status = ANY($1::text[]) ORDER BY created_at DESC",
            [statuses]
          );

          return result.rows.map((row) => syncMemoryTask(row));
        },
        () => memoryFindTasksByStatuses(statuses)
      );
    },

    async findSummary() {
      return withDatabaseFallback(
        async () => {
          const result = await query(
            `SELECT
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_tasks,
              COALESCE(SUM(total_spent_usdc) FILTER (WHERE status = 'completed'), 0)::float AS spent,
              COALESCE(SUM(savings_usdc) FILTER (WHERE status = 'completed'), 0)::float AS saved,
              COALESCE(SUM(COALESCE((result->'metrics'->>'paidMicroPayments')::int, 0)) FILTER (WHERE status = 'completed'), 0)::int AS paid_units,
              COALESCE(SUM(COALESCE((result->'metrics'->>'reusedUnits')::int, 0)) FILTER (WHERE status = 'completed'), 0)::int AS reused_units
            FROM tasks`
          );

          const row = result.rows[0] || {};
          return {
            completedTasks: Number(row.completed_tasks || 0),
            spent: Number(row.spent || 0),
            saved: Number(row.saved || 0),
            paidUnits: Number(row.paid_units || 0),
            reusedUnits: Number(row.reused_units || 0)
          };
        },
        () => memoryFindTaskSummary()
      );
    }
  },

  steps: {
    async create(data) {
      const payload = {
        ...data,
        completedAt: data.completedAt || createTimestamp()
      };

      return withDatabaseFallback(
        async () => syncMemoryStep(await upsertTaskStepRow(payload)),
        () => memoryCreateStep(payload),
        {
          onMemoryResult: (row) => capturePendingReplay("insert", "task_steps", row)
        }
      );
    },

    async findByTask(taskId) {
      return withDatabaseFallback(
        async () => {
          const result = await query(
            "SELECT * FROM task_steps WHERE task_id = $1 ORDER BY started_at ASC",
            [taskId]
          );

          return result.rows.map((row) => syncMemoryStep(row));
        },
        () => memoryFindSteps(taskId)
      );
    }
  },

  skills: {
    async create(data) {
      return withDatabaseFallback(
        async () => syncMemorySkill(await upsertSkillRow(data)),
        () => memoryCreateSkill(data),
        {
          onMemoryResult: (row) => capturePendingReplay("insert", "skills", row)
        }
      );
    },

    async findAll() {
      return withDatabaseFallback(
        async () => {
          const result = await query(
            "SELECT * FROM skills ORDER BY created_at DESC"
          );

          return result.rows.map((row) => syncMemorySkill(row));
        },
        () => memoryFindSkills()
      );
    }
  }
};
