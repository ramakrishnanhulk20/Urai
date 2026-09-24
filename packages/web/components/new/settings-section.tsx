"use client";

import type { ServMode } from "@urai/engine";
import type { ModelEntry, ModelListView } from "./api";
import { MODES, type FormLimits } from "./draft";
import s from "./new.module.css";
import { Section } from "./parts";

export type ModelsState = { kind: "loading" } | { kind: "failed" } | { kind: "loaded"; list: ModelListView };

export interface SettingsSectionProps {
  models: ModelsState;
  model: string;
  modes: ServMode[];
  limits: FormLimits;
  /** The setup check's own notes for the slow and costly modes, keyed by mode, when it has given one. */
  notes: Partial<Record<ServMode, string>>;
  onModel: (id: string) => void;
  onToggle: (mode: ServMode) => void;
}

function when(iso: string | null): string {
  if (iso === null) return "an unknown time";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "an unknown time" : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function price(m: ModelEntry): string {
  return `$${m.inputUsdPerM} in, $${m.outputUsdPerM} out per million tokens`;
}

export function SettingsSection({ models, model, modes, limits, notes, onModel, onToggle }: SettingsSectionProps) {
  const list = models.kind === "loaded" ? models.list : null;
  const picked = list?.models.find((m) => m.id === model) ?? null;
  const typed = list === null || list.models.length === 0;

  return (
    <Section
      id="settings"
      index={6}
      marker="Settings to compare"
      title={
        <>
          SERV off,
          <br />
          SERV on.
        </>
      }
      lede="Pick the model your agent runs on and the SERV settings to put side by side. Every case runs once under each setting you tick."
    >
      <div className={s.fields}>
        <div className={s.field}>
          <span className={s.labelRow}>
            <label className={s.label} htmlFor="model">
              Model
            </label>
          </span>
          {typed ? (
            <input
              id="model"
              className={s.input}
              value={model}
              onChange={(e) => onModel(e.target.value)}
              placeholder="The model id exactly as SERV names it"
              autoComplete="off"
              spellCheck={false}
            />
          ) : (
            <select id="model" className={s.select} value={model} onChange={(e) => onModel(e.target.value)}>
              {model === "" && <option value="">Pick a model</option>}
              {(list?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          )}
          <p className={s.modelMeta} role="status">
            {models.kind === "loading" && <span>Reading SERV&apos;s model list</span>}
            {models.kind === "failed" && (
              <span className={s.unverified}>Could not load the model list. Type the model id, or reload to try again</span>
            )}
            {list !== null && list.verified && (
              <span className={s.verified}>Live list from SERV, read {when(list.fetchedAt)}</span>
            )}
            {list !== null && !list.verified && list.models.length > 0 && (
              <span className={s.unverified}>
                Not verified: SERV could not be reached, so this is the last list we saved, from {when(list.fetchedAt)}
              </span>
            )}
            {list !== null && list.models.length === 0 && (
              <span className={s.unverified}>No model list right now. Type the model id exactly as SERV names it</span>
            )}
            {picked !== null && <span>{price(picked)}</span>}
          </p>
        </div>

        <fieldset className={s.modes}>
          <legend className={s.srOnly}>SERV settings to compare, at most {limits.configsPerRunMax}</legend>
          {MODES.map((m) => {
            const on = modes.includes(m.mode);
            const note = notes[m.mode];
            return (
              <label key={m.mode} className={s.mode}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onToggle(m.mode)}
                  disabled={!on && modes.length >= limits.configsPerRunMax}
                />
                <span className={s.box} aria-hidden="true" />
                <span className={s.modeName}>{m.label}</span>
                <span className={s.modeLine}>{m.line}</span>
                {on && note !== undefined && <span className={s.modeNote}>{note}</span>}
              </label>
            );
          })}
        </fieldset>
        {modes.length === 0 && (
          <p className={s.feedback} data-tone="bad">
            Tick at least one setting. SERV off and SERV plain side by side is the fair first test.
          </p>
        )}
      </div>
    </Section>
  );
}
