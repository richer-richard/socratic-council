/**
 * Settings › Preferences cards for the engine policies: budget, tools and
 * protocol. Each card edits one slice of the config through a patch callback.
 */

import type {
  EngineProtocolPolicy,
  EngineReasoningTier,
  EngineToolPolicy,
} from "@socratic-council/shared";
import { useEffect, useState } from "react";

import { engineShellSupport, type ShellSupport } from "../../services/engine";
import {
  POLICY_LIMITS,
  REASONING_TIER_OPTIONS,
  type BudgetAction,
  type BudgetPolicy,
} from "../../stores/config";
import { Dropdown } from "../Dropdown";

import { UNSANDBOXED_HINT, shellControls } from "./shellControls";

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 ${disabled ? "opacity-50" : ""}`}>
      <div>
        <div className="text-sm text-white">{label}</div>
        <div className="text-xs text-gray-400">{hint}</div>
      </div>
      <label className="toggle-switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => onChange(e.target.checked)}
        />
        <div className="toggle-slider" />
      </label>
    </div>
  );
}

function NumberField({
  label,
  value,
  range,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  range: readonly [number, number];
  onChange: (next: number) => void;
  suffix?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wider text-gray-400 mb-1">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          min={range[0]}
          max={range[1]}
          aria-label={label}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n)) onChange(n);
          }}
          className="w-28 bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-white
            focus:outline-none focus:border-primary transition-all"
        />
        {suffix && <span className="text-xs text-gray-500">{suffix}</span>}
      </span>
    </label>
  );
}

const TIER_OPTIONS = REASONING_TIER_OPTIONS.map((tier) => ({
  value: tier.value,
  label: tier.label,
}));

export function BudgetCard({
  budget,
  onChange,
}: {
  budget: BudgetPolicy;
  onChange: (patch: Partial<BudgetPolicy>) => void;
}) {
  const money = (raw: string) => {
    const n = parseFloat(raw);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
  };
  return (
    <div className="settings-card">
      <h3 className="font-medium text-white mb-1">Budget</h3>
      <p className="text-xs text-gray-400 mb-4">
        Every run shows an estimate before the first position. Caps are in USD; 0 means no cap. The
        daily cap counts every session on this machine.
      </p>
      <div className="grid sm:grid-cols-3 gap-4">
        <label className="block">
          <span className="block text-xs uppercase tracking-wider text-gray-400 mb-1">
            Per session
          </span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={budget.perSession}
            aria-label="Per-session budget (USD)"
            onChange={(e) => onChange({ perSession: money(e.target.value) })}
            className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-white
              focus:outline-none focus:border-primary transition-all"
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wider text-gray-400 mb-1">Per day</span>
          <input
            type="number"
            min={0}
            step={1}
            value={budget.perDay}
            aria-label="Per-day budget (USD)"
            onChange={(e) => onChange({ perDay: money(e.target.value) })}
            className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-white
              focus:outline-none focus:border-primary transition-all"
          />
        </label>
        <div>
          <span className="block text-xs uppercase tracking-wider text-gray-400 mb-1">
            At the cap
          </span>
          <Dropdown<BudgetAction>
            value={budget.action === "pause" ? "stop" : budget.action}
            ariaLabel="Budget action"
            onChange={(action) => onChange({ action })}
            options={[
              { value: "warn", label: "Warn and continue" },
              { value: "stop", label: "Stop the session" },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

export function ToolsCard({
  tools,
  onChange,
}: {
  tools: EngineToolPolicy;
  onChange: (patch: Partial<EngineToolPolicy>) => void;
}) {
  const [support, setSupport] = useState<ShellSupport | null>(null);
  useEffect(() => {
    let live = true;
    void engineShellSupport().then((s) => {
      if (live) setSupport(s);
    });
    return () => {
      live = false;
    };
  }, []);
  const shell = shellControls(support, tools.shell);
  return (
    <div className="settings-card">
      <h3 className="font-medium text-white mb-1">Tools</h3>
      <p className="text-xs text-gray-400 mb-4">
        What a seat may do while it argues. Tool output is fenced as untrusted text.
      </p>
      <div className="space-y-4">
        <Toggle
          label="Read attachments"
          hint="Search and quote the files attached to the session"
          checked={tools.attachments}
          onChange={(attachments) => onChange({ attachments })}
        />
        <Toggle
          label="Web search"
          hint="Keyless DuckDuckGo / Bing lookups, listings kept off the board"
          checked={tools.web}
          onChange={(web) => onChange({ web })}
        />
        <Toggle
          label="Verify claims"
          hint="A seat may check a factual claim against the web before asserting it"
          checked={tools.verify}
          onChange={(verify) => onChange({ verify })}
        />
        <Toggle
          label="Workspace files"
          hint="Read and write files in the session's own workspace folder"
          checked={tools.workspace_files}
          onChange={(workspace_files) => onChange({ workspace_files })}
        />
        <Toggle
          label="Shell commands"
          hint={shell.hint}
          checked={shell.checked}
          disabled={shell.disabled}
          onChange={(enabled) => onChange({ shell: { ...tools.shell, enabled } })}
        />
        {shell.showOptions && (
          <div className="pl-4 border-l border-gray-700 space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <NumberField
                label="Timeout"
                value={tools.shell.timeout_secs}
                range={POLICY_LIMITS.shellTimeoutSecs}
                suffix="seconds"
                onChange={(timeout_secs) => onChange({ shell: { ...tools.shell, timeout_secs } })}
              />
              <NumberField
                label="Output cap"
                value={tools.shell.max_output_bytes}
                range={POLICY_LIMITS.shellOutputBytes}
                suffix="bytes"
                onChange={(max_output_bytes) =>
                  onChange({ shell: { ...tools.shell, max_output_bytes } })
                }
              />
            </div>
            {shell.showUnsandboxed && (
              <Toggle
                label="Unsandboxed"
                hint={UNSANDBOXED_HINT}
                checked={tools.shell.unsandboxed}
                onChange={(unsandboxed) => onChange({ shell: { ...tools.shell, unsandboxed } })}
              />
            )}
          </div>
        )}
        <div className="grid sm:grid-cols-3 gap-4 pt-2">
          <NumberField
            label="Calls per turn"
            value={tools.max_calls_per_turn}
            range={POLICY_LIMITS.callsPerTurn}
            onChange={(max_calls_per_turn) => onChange({ max_calls_per_turn })}
          />
          <NumberField
            label="Tool rounds per turn"
            value={tools.max_iterations}
            range={POLICY_LIMITS.iterations}
            onChange={(max_iterations) => onChange({ max_iterations })}
          />
          <div>
            <span className="block text-xs uppercase tracking-wider text-gray-400 mb-1">
              Approval
            </span>
            <Dropdown<EngineToolPolicy["approval"]>
              value={tools.approval}
              ariaLabel="Tool approval"
              onChange={(approval) => onChange({ approval })}
              options={[
                { value: "auto", label: "Run without asking" },
                { value: "ask", label: "Ask before each call" },
              ]}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const ROUND_TIERS: { key: keyof EngineProtocolPolicy["tiers"]; label: string; hint: string }[] = [
  { key: "positions", label: "Positions", hint: "independent opening positions" },
  { key: "cross", label: "Cross-examination", hint: "seats challenge each other with tools" },
  { key: "revision", label: "Revision", hint: "final positions and votes" },
  { key: "subtask", label: "Prep subtasks", hint: "research the moderator assigns" },
  { key: "utility", label: "Utility", hint: "board rewrites, summaries" },
  { key: "record", label: "Record", hint: "the moderator writes the decision record" },
];

export function ProtocolCard({
  protocol,
  onChange,
}: {
  protocol: EngineProtocolPolicy;
  onChange: (patch: Partial<EngineProtocolPolicy>) => void;
}) {
  return (
    <div className="settings-card">
      <h3 className="font-medium text-white mb-1">Protocol</h3>
      <p className="text-xs text-gray-400 mb-4">
        Framing, positions, cross-examination rounds until the moderator sees convergence, a
        revision with votes, then the record. Quick and Full presets on the home page override the
        round cap per session.
      </p>
      <div className="grid sm:grid-cols-3 gap-4 mb-4">
        <NumberField
          label="Cross-examination rounds"
          value={protocol.max_rounds}
          range={POLICY_LIMITS.rounds}
          onChange={(max_rounds) => onChange({ max_rounds })}
        />
        <NumberField
          label="Principals at most"
          value={protocol.max_principals}
          range={POLICY_LIMITS.principals}
          onChange={(max_principals) => onChange({ max_principals })}
        />
        <NumberField
          label="Parallel seats"
          value={protocol.concurrency}
          range={POLICY_LIMITS.concurrency}
          onChange={(concurrency) => onChange({ concurrency })}
        />
      </div>
      <div className="mb-4 space-y-3">
        <Toggle
          label="Let the moderator ask me first"
          hint="When the framing is ambiguous, the run pauses for one clarifying question"
          checked={protocol.interactive}
          onChange={(interactive) => onChange({ interactive })}
        />
        <Toggle
          label="Review the council afterwards"
          hint="Every seat scores the others and the argument gets mapped, on the utility model. Adds one call per seat plus one per round. Off still gives you the vote and the convergence chart."
          checked={protocol.review}
          onChange={(review) => onChange({ review })}
        />
      </div>
      <div>
        <span className="block text-xs uppercase tracking-wider text-gray-400 mb-2">
          Reasoning level per round
        </span>
        <div className="grid sm:grid-cols-2 gap-3">
          {ROUND_TIERS.map((round) => (
            <div key={round.key} className="flex items-center gap-3">
              <div className="w-40 shrink-0">
                <div className="text-sm text-gray-200">{round.label}</div>
                <div className="text-[11px] text-gray-500">{round.hint}</div>
              </div>
              <div className="flex-1 min-w-0">
                <Dropdown<EngineReasoningTier>
                  value={protocol.tiers[round.key]}
                  ariaLabel={`${round.label} reasoning level`}
                  onChange={(tier) => onChange({ tiers: { ...protocol.tiers, [round.key]: tier } })}
                  options={TIER_OPTIONS}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
