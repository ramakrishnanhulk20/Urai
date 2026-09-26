"use client";

import type { ServMode } from "@urai/engine";
import { AnimatePresence, motion } from "motion/react";
import { Slash } from "../brand/slash";
import type { ModelEntry, ModelListView } from "./api";
import { MODES, mainModesMax, type Compare, type FormLimits } from "./draft";
import s from "./new.module.css";
import { EASE_OUT, Section } from "./parts";

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
  /** The optional second model and its one setting. */
  compare: Compare;
  /** Why the second model cannot join the run as it stands, or null. */
  compareProblem: string | null;
  onCompare: (next: Compare) => void;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Built by hand because Intl's en-GB short month is "Sept" on some runtimes and "Sep" on others.
function when(iso: string | null): string {
  if (iso === null) return "an unknown time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unknown time";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function price(m: ModelEntry): string {
  return `$${m.inputUsdPerM} in, $${m.outputUsdPerM} out per million tokens`;
}

export function SettingsSection(p: SettingsSectionProps) {
  const { models, model, modes, limits, notes, onModel, onToggle, compare, compareProblem, onCompare } = p;
  // The second model takes one of the run's settings, so the first model's cap drops by one when it is set.
  const most = mainModesMax(compare, limits);
  const list = models.kind === "loaded" ? models.list : null;
  const picked = list?.models.find((m) => m.id === model) ?? null;
  const typed = list === null || list.models.length === 0;
  const comparing = compare.model.trim() !== "";
  const comparePicked = list?.models.find((m) => m.id === compare.model) ?? null;
  const compareNote = comparing ? notes[compare.mode] : undefined;

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
          <legend className={s.srOnly}>SERV settings to compare, up to {most}</legend>
          {MODES.map((m) => {
            const on = modes.includes(m.mode);
            const note = notes[m.mode];
            return (
              <label key={m.mode} className={s.mode}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onToggle(m.mode)}
                  disabled={!on && modes.length >= most}
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

        <div className={s.compare} data-on={comparing} role="group" aria-labelledby="compare-title" aria-describedby="compare-line">
          <div className={s.compareHead}>
            <p id="compare-title" className={s.compareTitle}>
              <Slash className={s.markerSlash} />
              <span>
                Compare with another model <span className={s.optional}>Optional</span>
              </span>
            </p>
            <p id="compare-line" className={s.hint}>
              Run the same cases on a second model as well, for example your current large model with SERV off against a
              smaller one with SERV on. It adds one more setting to the run, {limits.configsPerRunMax} settings at most in all.
            </p>
          </div>
          <div className={s.pair}>
            <div className={s.field}>
              <label className={s.label} htmlFor="compare-model">
                Second model
              </label>
              {typed ? (
                <input
                  id="compare-model"
                  className={s.input}
                  value={compare.model}
                  onChange={(e) => onCompare({ ...compare, model: e.target.value })}
                  placeholder="Leave empty for none"
                  autoComplete="off"
                  spellCheck={false}
                />
              ) : (
                <select
                  id="compare-model"
                  className={s.select}
                  value={compare.model}
                  onChange={(e) => onCompare({ ...compare, model: e.target.value })}
                >
                  <option value="">None</option>
                  {/* A typed id from a reload that is not on today's list stays visible, so it is never swapped silently. */}
                  {comparing && comparePicked === null && <option value={compare.model}>{compare.model}</option>}
                  {(list?.models ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
                </select>
              )}
              {comparePicked !== null ? (
                <p className={s.modelMeta}>
                  <span>{price(comparePicked)}</span>
                </p>
              ) : (
                !typed && (
                  <p className={s.modelMeta}>
                    <span>{comparing ? "Not on today's model list" : "Same live list as above"}</span>
                  </p>
                )
              )}
            </div>
            <div className={s.field}>
              <label className={s.label} htmlFor="compare-mode">
                Its setting
              </label>
              <select
                id="compare-mode"
                className={s.select}
                value={compare.mode}
                disabled={!comparing}
                onChange={(e) => onCompare({ ...compare, mode: e.target.value as ServMode })}
              >
                {MODES.map((m) => (
                  <option key={m.mode} value={m.mode}>
                    {m.label}
                  </option>
                ))}
              </select>
              <p className={s.hint}>{MODES.find((m) => m.mode === compare.mode)?.line}</p>
            </div>
          </div>
          {compareNote !== undefined && <p className={s.modeNote}>{compareNote}</p>}
          <AnimatePresence initial={false}>
            {compareProblem !== null && (
              <motion.p
                key="problem"
                className={s.feedback}
                data-tone="bad"
                role="alert"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.35, ease: EASE_OUT }}
              >
                {compareProblem}
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </div>
    </Section>
  );
}
