"use client";

/**
 * AgentAvatar — deterministic procedural identicon for Muse sub-agents.
 *
 * Given a wallet address + service name, derives a small DNA-themed mark:
 *   - base colour from the service family (strategy/search/copy/image)
 *   - accent row pattern derived from address bytes (no network calls)
 *   - a letter glyph in the centre so it still reads fast
 *
 * Consistent visual identity → each sub-agent feels like a distinct "person"
 * in the ledger and reputation panel. Zero deps.
 */

const SERVICE_ACCENTS: Record<string, string> = {
  strategy: "#C6F51F",
  search: "#5FA8FF",
  copy: "#FFD21A",
  image: "#FF6B9D",
  orchestrator: "#F2F1EC"
};

function hash32(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function toCells(seed: number, size = 5) {
  const cells: boolean[] = [];
  // Pick bits from the seed; mirror horizontally so the avatar is symmetric.
  const half = Math.ceil(size / 2);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < half; x += 1) {
      const bit = (seed >> ((y * half + x) % 30)) & 1;
      cells[y * size + x] = Boolean(bit);
      cells[y * size + (size - 1 - x)] = Boolean(bit);
    }
  }
  return cells;
}

export default function AgentAvatar({
  address,
  service,
  letter,
  size = 28,
  title
}: {
  address?: string | null;
  service?: string;
  letter?: string;
  size?: number;
  title?: string;
}) {
  const seed = hash32(String(address || service || "muse").toLowerCase());
  const accent = SERVICE_ACCENTS[String(service || "").toLowerCase()] || "#C6F51F";
  const cells = toCells(seed, 5);
  const glyph = (letter || String(service || "?").slice(0, 1)).toUpperCase();
  const cellSize = size / 5;

  return (
    <span
      role="img"
      aria-label={title || `Agent avatar ${address || service || ""}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        position: "relative",
        background: "#0A0A0A",
        border: `1px solid ${accent}66`,
        boxShadow: `inset 0 0 10px ${accent}22`,
        flexShrink: 0
      }}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        aria-hidden="true"
        style={{ position: "absolute", inset: 0 }}
      >
        {cells.map((filled, i) => {
          if (!filled) return null;
          const x = (i % 5) * cellSize;
          const y = Math.floor(i / 5) * cellSize;
          return <rect key={i} x={x} y={y} width={cellSize} height={cellSize} fill={accent} opacity={0.32} />;
        })}
      </svg>
      <span
        style={{
          fontFamily: "var(--font-display-brand, var(--font-display))",
          fontWeight: 900,
          fontSize: size * 0.55,
          color: accent,
          textShadow: `0 0 4px ${accent}`,
          lineHeight: 1,
          position: "relative",
          zIndex: 1
        }}
      >
        {glyph}
      </span>
    </span>
  );
}
