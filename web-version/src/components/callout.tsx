interface CalloutConfig {
  emoji: string;
  label: string;
  colorVar: string;
  bgVar: string;
}

const CALLOUT_MAP: Record<string, CalloutConfig> = {
  "\u{1F4A1}": { emoji: "💡", label: "Tip", colorVar: "var(--cal-tip)", bgVar: "var(--cal-tip-bg)" },
  "⚠️": { emoji: "⚠️", label: "Gotcha", colorVar: "var(--cal-warn)", bgVar: "var(--cal-warn-bg)" },
  "✅": { emoji: "✅", label: "Key Insight", colorVar: "var(--cal-ok)", bgVar: "var(--cal-ok-bg)" },
  "\u{1F3AF}": { emoji: "🎯", label: "Key Point", colorVar: "var(--cal-goal)", bgVar: "var(--cal-goal-bg)" },
  "⚡": { emoji: "⚡", label: "Complexity", colorVar: "var(--cal-note)", bgVar: "var(--cal-note-bg)" },
  "\u{1F336}️": { emoji: "🌶️", label: "Bonus", colorVar: "var(--cal-bonus)", bgVar: "var(--cal-bonus-bg)" },
  "\u{1F7E2}": { emoji: "🟢", label: "Follow-up", colorVar: "var(--cal-ok)", bgVar: "var(--cal-ok-bg)" },
  "\u{1F9E9}": { emoji: "🧩", label: "Key Idea", colorVar: "var(--cal-goal)", bgVar: "var(--cal-goal-bg)" },
  "\u{1F525}": { emoji: "🔥", label: "Important", colorVar: "var(--cal-bonus)", bgVar: "var(--cal-bonus-bg)" },
  "\u{1F4AA}": { emoji: "💪", label: "Pro Tip", colorVar: "var(--cal-note)", bgVar: "var(--cal-note-bg)" },
  "\u{1F6A8}": { emoji: "🚨", label: "Warning", colorVar: "var(--cal-warn)", bgVar: "var(--cal-warn-bg)" },
};

export function detectCallout(text: string): CalloutConfig | null {
  const trimmed = text.trimStart();
  for (const [codepoint, config] of Object.entries(CALLOUT_MAP)) {
    if (trimmed.startsWith(codepoint) || trimmed.startsWith(config.emoji)) {
      return config;
    }
  }
  return null;
}

export function Callout({
  config,
  children,
}: {
  config: CalloutConfig;
  children: React.ReactNode;
}) {
  return (
    <div
      className="callout"
      style={{
        borderLeftColor: config.colorVar,
        background: config.bgVar,
      }}
    >
      <span className="callout-icon" aria-hidden="true">
        {config.emoji}
      </span>
      <div className="callout-body">
        <div
          className="callout-label"
          style={{ color: config.colorVar }}
        >
          {config.label}
        </div>
        <div className="callout-content">{children}</div>
      </div>
    </div>
  );
}
