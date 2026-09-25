/**
 * The council roster: one row per seat with its name, provider, model and
 * reasoning override. Any number of seats per provider, up to MAX_SEATS.
 * Seats whose provider has no key stay in the roster but are marked; the
 * engine skips them at start time.
 */

import type {
  DiscoveredModel,
  EngineCatalogRow,
  EngineExtraEffort,
  EngineSeat,
} from "@socratic-council/shared";
import { useState } from "react";

import { PROVIDER_INFO, type AppConfig, type Provider } from "../stores/config";

import { Dropdown } from "./Dropdown";
import { ProviderIcon } from "./icons/ProviderIcons";
import { AUTO_CHOICES, ModelPicker, autoPreview } from "./ModelPicker";
import {
  MAX_SEATS,
  addSeat,
  defaultRoster,
  reasoningOptions,
  reasoningPatch,
  reasoningValue,
  removeSeat,
  renameSeat,
  updateSeat,
  type ReasoningChoice,
} from "./rosterHelpers";

const PROVIDERS = Object.keys(PROVIDER_INFO) as Provider[];

const PROVIDER_OPTIONS = PROVIDERS.map((provider) => ({
  value: provider,
  label: PROVIDER_INFO[provider].name,
}));

/** The levels above High the model a seat resolves to takes, per the catalog. */
function seatExtras(
  seat: EngineSeat,
  available: DiscoveredModel[],
  rows: EngineCatalogRow[] | undefined,
  selection: AppConfig["modelSelection"][Provider] | undefined,
): EngineExtraEffort[] {
  const auto = AUTO_CHOICES.find((choice) => choice.value === seat.model);
  const id = auto
    ? autoPreview(seat.provider, auto.tier, available, selection?.[auto.tier], rows)
    : seat.model;
  return rows?.find((row) => row.id === id)?.extraEfforts ?? [];
}

export interface RosterEditorProps {
  roster: EngineSeat[];
  onChange: (roster: EngineSeat[]) => void;
  /** Providers with a saved API key. */
  keyedProviders: readonly Provider[];
  availableByProvider: Record<Provider, DiscoveredModel[]>;
  engineRows: Partial<Record<Provider, EngineCatalogRow[]>>;
  modelSelection: AppConfig["modelSelection"];
}

export function RosterEditor({
  roster,
  onChange,
  keyedProviders,
  availableByProvider,
  engineRows,
  modelSelection,
}: RosterEditorProps) {
  const [addProvider, setAddProvider] = useState<Provider>("openai");
  const keyed = new Set(keyedProviders);
  const active = roster.filter((seat) => keyed.has(seat.provider)).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-gray-400">
          {active} of {roster.length} seats have a key and will sit. The moderator picks who leads
          each question from this list.
        </p>
        <button
          type="button"
          onClick={() => onChange(defaultRoster())}
          className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-gray-700 transition-colors"
        >
          Reset to the eight
        </button>
      </div>

      <ul className="space-y-2">
        {roster.map((seat, index) => {
          const info = PROVIDER_INFO[seat.provider];
          const hasKey = keyed.has(seat.provider);
          const extras = seatExtras(
            seat,
            availableByProvider[seat.provider],
            engineRows[seat.provider],
            modelSelection[seat.provider],
          );
          return (
            // Earlier rows stack above later ones so an open model panel is not
            // painted over by the row beneath it. The row itself keeps full
            // opacity (a dimmed row would dim its open panel too); a keyless
            // seat dims its name instead.
            <li
              key={seat.id}
              className="settings-card relative !p-3"
              style={{ zIndex: roster.length - index }}
              data-seat-id={seat.id}
            >
              <div className="grid gap-2 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,2fr)_minmax(0,1.1fr)_auto] items-center">
                <div className={`flex items-center gap-2 min-w-0 ${hasKey ? "" : "opacity-60"}`}>
                  <ProviderIcon provider={seat.provider} size={22} />
                  <input
                    type="text"
                    value={seat.name}
                    aria-label={`Seat ${seat.id} name`}
                    maxLength={40}
                    onChange={(e) => onChange(renameSeat(roster, seat.id, e.target.value))}
                    className={`min-w-0 flex-1 bg-transparent border-b border-transparent focus:border-primary
                      focus:outline-none text-sm font-semibold ${info.color}`}
                  />
                </div>
                <Dropdown<Provider>
                  value={seat.provider}
                  ariaLabel={`Seat ${seat.name} provider`}
                  options={PROVIDER_OPTIONS}
                  onChange={(provider) =>
                    onChange(updateSeat(roster, seat.id, { provider, model: "auto" }))
                  }
                />
                <ModelPicker
                  provider={seat.provider}
                  value={seat.model}
                  onChange={(model) => onChange(updateSeat(roster, seat.id, { model }))}
                  available={availableByProvider[seat.provider]}
                  rows={engineRows[seat.provider]}
                  selection={modelSelection[seat.provider]}
                  ariaLabel={`Seat ${seat.name} model`}
                />
                <Dropdown<ReasoningChoice>
                  value={reasoningValue(seat, extras)}
                  ariaLabel={`Seat ${seat.name} reasoning`}
                  options={reasoningOptions(extras)}
                  onChange={(choice) =>
                    onChange(updateSeat(roster, seat.id, reasoningPatch(choice)))
                  }
                />
                <div className="flex items-center gap-2 justify-end">
                  {!hasKey && (
                    <span className="text-[10px] uppercase tracking-wider text-yellow-400/80 whitespace-nowrap">
                      no key
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => onChange(removeSeat(roster, seat.id))}
                    disabled={roster.length <= 1}
                    aria-label={`Remove seat ${seat.name}`}
                    className="text-gray-500 hover:text-red-400 disabled:opacity-30 px-2 py-1 rounded-lg
                      hover:bg-red-500/10 transition-colors text-sm"
                  >
                    ×
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="w-44">
          <Dropdown<Provider>
            value={addProvider}
            ariaLabel="Provider for the new seat"
            options={PROVIDER_OPTIONS}
            onChange={setAddProvider}
          />
        </div>
        <button
          type="button"
          onClick={() => onChange(addSeat(roster, addProvider))}
          disabled={roster.length >= MAX_SEATS}
          className="bg-primary/10 hover:bg-primary/20 disabled:opacity-40 text-primary
            px-4 py-2 rounded-lg text-sm transition-colors"
        >
          + Add seat
        </button>
        <span className="text-xs text-gray-500">
          {roster.length}/{MAX_SEATS}
        </span>
      </div>
    </div>
  );
}
