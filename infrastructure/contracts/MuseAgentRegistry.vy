# @version 0.4.0
"""
@title  Muse Agent Registry (ERC-8004 inspired trust layer)
@notice On-chain identity + reputation for Muse DNA sub-agents.
@dev    Written in Vyper for deployment on Arc Testnet. Each Muse sub-agent
        (strategy / fast-search / copy / image) registers itself once and then
        every settled x402 micro-payment bumps its reputation counter. This is
        how a buyer knows they're paying a live, authenticated agent and not a
        random address. Bridges the hackathon's Agent-to-Agent Payment Loop
        track to the ERC-8004 "trust layer for autonomous agents" reference
        pattern.

        Interfaces are a subset of the ERC-8004 draft (identity + reputation).
        Validation aspects are out of scope for the MVP.
"""

# -------------------- Storage --------------------

struct Agent:
    operator: address            # who may update this agent
    service: String[32]          # "strategy" | "search" | "copy" | "image"
    label: String[64]            # human-readable label shown in the UI
    metadata_uri: String[256]    # optional pointer (e.g. IPFS / HTTPS DNA url)
    registered_at: uint256       # block timestamp at registration
    active: bool

agents: public(HashMap[address, Agent])

# Counter of settled micro-payments received by each agent address.
tx_count: public(HashMap[address, uint256])

# Cumulative USDC settled to each agent, in micro-USDC (6 decimals).
total_settled_micro: public(HashMap[address, uint256])

# Agent addresses in registration order, so we can enumerate.
agent_list: public(DynArray[address, 256])

# Who can register new agents? The deployer.
owner: public(address)

# -------------------- Events --------------------

event AgentRegistered:
    agent: indexed(address)
    operator: indexed(address)
    service: String[32]
    label: String[64]

event AgentDeactivated:
    agent: indexed(address)

event PaymentRecorded:
    agent: indexed(address)
    amount_micro: uint256
    total_tx: uint256
    total_settled_micro: uint256

# -------------------- Constructor --------------------

@deploy
def __init__():
    self.owner = msg.sender

# -------------------- Mutations --------------------

@external
def register_agent(
    agent: address,
    service: String[32],
    label: String[64],
    metadata_uri: String[256]
):
    """
    @notice Register (or re-register) an agent. Only the owner may call.
    @dev    Re-registration updates metadata and keeps the counters intact.
    """
    assert msg.sender == self.owner, "not owner"
    assert agent != empty(address), "bad agent"

    prior: Agent = self.agents[agent]
    is_new: bool = prior.registered_at == 0

    # Preserve an earlier registered_at / active flag across metadata updates.
    # Without this a re-registration of a deactivated agent silently
    # resurrects it (active=True) and shifts registered_at forward, which
    # would let an owner erase an audit record of a retired agent just by
    # re-calling register_agent().
    registered_at: uint256 = block.timestamp if is_new else prior.registered_at
    active_flag: bool = True if is_new else prior.active

    self.agents[agent] = Agent(
        operator=msg.sender,
        service=service,
        label=label,
        metadata_uri=metadata_uri,
        registered_at=registered_at,
        active=active_flag
    )

    if is_new:
        self.agent_list.append(agent)

    log AgentRegistered(agent, msg.sender, service, label)

@external
def deactivate_agent(agent: address):
    """Retire an agent; counters stay visible but active=False."""
    assert msg.sender == self.owner, "not owner"
    existing: Agent = self.agents[agent]
    assert existing.registered_at != 0, "not registered"
    existing.active = False
    self.agents[agent] = existing
    log AgentDeactivated(agent)

@external
def record_payment(agent: address, amount_micro: uint256):
    """
    @notice Book a settled micro-payment against an agent. Only the owner
            (the Muse orchestrator wallet) can record payments — this keeps
            reputation inflation attack-proof.
    """
    assert msg.sender == self.owner, "not owner"
    existing: Agent = self.agents[agent]
    assert existing.registered_at != 0, "agent not registered"
    assert existing.active, "agent inactive"

    new_count: uint256 = self.tx_count[agent] + 1
    new_total: uint256 = self.total_settled_micro[agent] + amount_micro
    self.tx_count[agent] = new_count
    self.total_settled_micro[agent] = new_total

    log PaymentRecorded(agent, amount_micro, new_count, new_total)

# -------------------- Views --------------------

@view
@external
def agent_count() -> uint256:
    return len(self.agent_list)

@view
@external
def agent_at(index: uint256) -> address:
    assert index < len(self.agent_list), "oob"
    return self.agent_list[index]

@view
@external
def reputation(agent: address) -> (uint256, uint256, bool):
    """
    @notice Returns (tx_count, total_settled_micro_usdc, active).
    @dev    Callers convert total_settled_micro_usdc / 1e6 for USDC.
    """
    return (self.tx_count[agent], self.total_settled_micro[agent], self.agents[agent].active)
