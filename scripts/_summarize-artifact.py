import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)

print("=== HACKATHON PROOF ===")
hp = d["hackathonProof"]
print(f"  actualTransactions:        {hp['actualTransactions']}")
print(f"  passedRequirement:         {hp['passedTransactionRequirement']}")
print(f"  totalTaskRevenueUsdc:      {hp['totalTaskRevenueUsdc']}")
print(f"  averageUnitPriceUsdc:      {hp['averageUnitPriceUsdc']}")
print(f"  maxUnitPriceUsdc:          {hp['maxUnitPriceUsdc']}")

print()
print("=== TASK ===")
t = d["task"]
print(f"  status:           {t['status']}")
print(f"  paidMicroPayments: {t['paidMicroPayments']}")
print(f"  failedUnits:       {t['failedUnits']}")
print(f"  reusedUnits:       {t['reusedUnits']}")

print()
print("=== TX HASH ANALYSIS ===")
txs = d["transactions"]
real = sum(1 for tx in txs if tx['tx'].startswith('0x') and len(tx['tx']) == 66)
uuids = sum(1 for tx in txs if '-' in tx['tx'])
with_url = sum(1 for tx in txs if tx.get('arcUrl'))
print(f"  Total records:        {len(txs)}")
print(f"  Real Arc 0x hashes:   {real}")
print(f"  Gateway UUIDs:        {uuids}")
print(f"  With arcUrl link:     {with_url}")

print()
print("=== FUNDING ===")
dr = d["funding"].get("depositResult")
if dr:
    print(f"  approvalTxHash:  {dr.get('approvalTxHash') or '(skipped)'}")
    print(f"  depositTxHash:   {dr.get('depositTxHash')}")
    print(f"  formattedAmount: {dr.get('formattedAmount')}")
else:
    print("  (no deposit needed — Gateway already had sufficient balance)")
    print(f"  payerGatewayAvailableBefore: {d['funding'].get('payerGatewayAvailableBefore')}")
    print(f"  payerGatewayAvailableAfterTask: {d['funding'].get('payerGatewayAvailableAfterTask')}")

print()
print("=== AGENTS ===")
for name, info in d["agents"].items():
    print(f"  {name:10s} count={info['count']:2d}  spent={info['spentUsdc']:.4f} USDC  wallet={info['wallet'][:10]}...")

print()
print("=== FIRST 3 TX SAMPLES ===")
for tx in txs[:3]:
    arc = tx.get('arcUrl') or 'NONE'
    print(f"  [{tx['service']:8s}] {tx['unit']:20s} ${tx['amountUsdc']}  tx={tx['tx'][:24]}...  url={arc[:55]}")
