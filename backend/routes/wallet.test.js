import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGatewayBurnIntent,
  buildSessionWalletsResponse,
  createMockSessionWallets
} from "./wallet.js";

test("createMockSessionWallets is deterministic and keeps agent receiver wallets aligned", () => {
  process.env.STRATEGY_AGENT_WALLET = "0xAAA0000000000000000000000000000000000000";
  process.env.FAST_SEARCH_WALLET = "0xBBB0000000000000000000000000000000000000";
  process.env.COPY_AGENT_WALLET = "0xCCC0000000000000000000000000000000000000";
  process.env.IMAGE_AGENT_WALLET = "0xDDD0000000000000000000000000000000000000";

  const first = createMockSessionWallets("0x9bD9000000000000000000000000000000008367");
  const second = createMockSessionWallets("0x9bd9000000000000000000000000000000008367");

  assert.equal(first.mode, "mock");
  assert.equal(first.fundingDisabled, true);
  assert.equal(first.payer.id, second.payer.id);
  assert.equal(first.payer.address, second.payer.address);
  assert.equal(first.strategy.address, process.env.STRATEGY_AGENT_WALLET);
  assert.equal(first.search.address, process.env.FAST_SEARCH_WALLET);
  assert.equal(first.copy.address, process.env.COPY_AGENT_WALLET);
  assert.equal(first.image.address, process.env.IMAGE_AGENT_WALLET);
});

test("buildSessionWalletsResponse keeps configured seller wallets while only payer is user-specific", () => {
  process.env.STRATEGY_AGENT_WALLET = "0xAAA0000000000000000000000000000000000001";
  process.env.FAST_SEARCH_WALLET = "0xBBB0000000000000000000000000000000000002";
  process.env.COPY_AGENT_WALLET = "0xCCC0000000000000000000000000000000000003";
  process.env.IMAGE_AGENT_WALLET = "0xDDD0000000000000000000000000000000000000004".slice(0, 42);

  const session = buildSessionWalletsResponse({
    payerId: "payer-123",
    payerAddress: "0x1111111111111111111111111111111111111111"
  });

  assert.equal(session.mode, "circle");
  assert.equal(session.fundingDisabled, false);
  assert.equal(session.payer.id, "payer-123");
  assert.equal(session.payer.address, "0x1111111111111111111111111111111111111111");
  assert.equal(session.strategy.address, process.env.STRATEGY_AGENT_WALLET);
  assert.equal(session.search.address, process.env.FAST_SEARCH_WALLET);
  assert.equal(session.copy.address, process.env.COPY_AGENT_WALLET);
  assert.equal(session.image.address, process.env.IMAGE_AGENT_WALLET);
});

test("buildGatewayBurnIntent keeps same-chain Arc withdraw fields aligned", () => {
  const arcConfig = {
    domain: 26,
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    usdc: "0x3600000000000000000000000000000000000000"
  };

  const burnIntent = buildGatewayBurnIntent({
    sourceChainConfig: arcConfig,
    destinationChainConfig: arcConfig,
    sourceDepositor: "0x1111111111111111111111111111111111111111",
    sourceSigner: "0x1111111111111111111111111111111111111111",
    destinationRecipient: "0x2222222222222222222222222222222222222222",
    value: 123_000n,
    maxFee: 50_000n,
    salt: `0x${"ab".repeat(32)}`
  });

  assert.equal(burnIntent.maxFee, 50_000n);
  assert.equal(burnIntent.spec.sourceDomain, 26);
  assert.equal(burnIntent.spec.destinationDomain, 26);
  assert.equal(
    burnIntent.spec.sourceContract,
    "0x0000000000000000000000000077777d7eba4688bdef3e311b846f25870a19b9"
  );
  assert.equal(
    burnIntent.spec.destinationContract,
    "0x0000000000000000000000000022222abe238cc2c7bb1f21003f0a260052475b"
  );
  assert.equal(
    burnIntent.spec.destinationRecipient,
    "0x0000000000000000000000002222222222222222222222222222222222222222"
  );
  assert.equal(
    burnIntent.spec.destinationCaller,
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  );
  assert.equal(burnIntent.spec.value, 123_000n);
});
