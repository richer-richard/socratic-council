/**
 * Settings › Council: the roster, then the moderator and utility slots. The
 * engine's verified catalog (class labels) is fetched once per opening when
 * the backend is reachable; the Vite shell falls back to the shared registry.
 */

import type {
  DiscoveredModel,
  EngineCatalogRow,
  EngineSeat,
  EngineSlot,
} from "@socratic-council/shared";
import { useEffect, useState } from "react";

import { catalog as engineCatalog, isEngineAvailable } from "../../services/engine";
import { PROVIDER_INFO, type AppConfig, type Provider } from "../../stores/config";
import { Dropdown } from "../Dropdown";
import { ModelPicker } from "../ModelPicker";
import { RosterEditor } from "../RosterEditor";

const PROVIDERS = Object.keys(PROVIDER_INFO) as Provider[];

const PROVIDER_OPTIONS = PROVIDERS.map((provider) => ({
  value: provider,
  label: PROVIDER_INFO[provider].name,
}));

export interface CouncilTabProps {
  config: AppConfig;
  keyedProviders: readonly Provider[];
  availableByProvider: Record<Provider, DiscoveredModel[]>;
  onUpdateRoster: (roster: EngineSeat[]) => void;
  onUpdateModerator: (slot: EngineSlot) => void;
  onUpdateUtility: (slot: EngineSlot) => void;
}

function SlotCard({
  title,
  hint,
  slot,
  onChange,
  keyed,
  availableByProvider,
  engineRows,
  modelSelection,
}: {
  title: string;
  hint: string;
  slot: EngineSlot;
  onChange: (slot: EngineSlot) => void;
  keyed: ReadonlySet<Provider>;
  availableByProvider: Record<Provider, DiscoveredModel[]>;
  engineRows: Partial<Record<Provider, EngineCatalogRow[]>>;
  modelSelection: AppConfig["modelSelection"];
}) {
  const hasKey = keyed.has(slot.provider);
  return (
    <div className="settings-card">
      <h3 className="font-medium text-white mb-1">{title}</h3>
      <p className="text-xs text-gray-400 mb-3">{hint}</p>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center">
        <Dropdown<Provider>
          value={slot.provider}
          ariaLabel={`${title} provider`}
          options={PROVIDER_OPTIONS}
          onChange={(provider) => onChange({ provider, model: "auto" })}
        />
        <ModelPicker
          provider={slot.provider}
          value={slot.model}
          onChange={(model) => onChange({ ...slot, model })}
          available={availableByProvider[slot.provider]}
          rows={engineRows[slot.provider]}
          selection={modelSelection[slot.provider]}
          ariaLabel={`${title} model`}
        />
      </div>
      {!hasKey && (
        <p className="text-xs text-yellow-400/90 mt-2">
          No key for {PROVIDER_INFO[slot.provider].name}: the engine falls back to the first seated
          provider.
        </p>
      )}
    </div>
  );
}

export function CouncilTab({
  config,
  keyedProviders,
  availableByProvider,
  onUpdateRoster,
  onUpdateModerator,
  onUpdateUtility,
}: CouncilTabProps) {
  const [engineRows, setEngineRows] = useState<Partial<Record<Provider, EngineCatalogRow[]>>>({});

  useEffect(() => {
    if (!isEngineAvailable()) return;
    let cancelled = false;
    void Promise.all(
      PROVIDERS.map(async (provider) => [provider, await engineCatalog(provider)] as const),
    )
      .then((entries) => {
        if (cancelled) return;
        const next: Partial<Record<Provider, EngineCatalogRow[]>> = {};
        for (const [provider, rows] of entries) next[provider] = rows;
        setEngineRows(next);
      })
      .catch((error) => console.error("[settings] engine catalog unavailable:", error));
    return () => {
      cancelled = true;
    };
  }, []);

  const keyed = new Set(keyedProviders);

  return (
    <div className="space-y-4 scale-in">
      <div className="settings-card">
        <h3 className="font-medium text-white mb-1">Council roster</h3>
        <p className="text-xs text-gray-400 mb-4">
          Any model of any provider, more than one seat per provider if you like. Auto follows the
          levels on the Models tab; a reasoning override pins one seat to a level for every round.
        </p>
        <RosterEditor
          roster={config.roster}
          onChange={onUpdateRoster}
          keyedProviders={keyedProviders}
          availableByProvider={availableByProvider}
          engineRows={engineRows}
          modelSelection={config.modelSelection}
        />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <SlotCard
          title="Moderator"
          hint="Frames the question, routes hard work to strong seats and small tasks to fast ones, judges convergence, writes the record."
          slot={config.moderator}
          onChange={onUpdateModerator}
          keyed={keyed}
          availableByProvider={availableByProvider}
          engineRows={engineRows}
          modelSelection={config.modelSelection}
        />
        <SlotCard
          title="Utility"
          hint="Rewrites the board and summarises tool output between rounds; a fast, cheap model does this well."
          slot={config.utility}
          onChange={onUpdateUtility}
          keyed={keyed}
          availableByProvider={availableByProvider}
          engineRows={engineRows}
          modelSelection={config.modelSelection}
        />
      </div>
    </div>
  );
}
