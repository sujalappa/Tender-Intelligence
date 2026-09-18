import { useEffect, useState } from "react";
import { api } from "../api.js";

/**
 * Provider + model selector. value = { provider, model, verify }
 */
export default function ModelPicker({ value, onChange }) {
  const [meta, setMeta] = useState(null);

  useEffect(() => {
    api.models().then((m) => {
      setMeta(m);
      if (!value.provider) onChange({ ...value, provider: m.defaultProvider, model: m[m.defaultProvider]?.default || "" });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!meta) return <span className="muted small">loading models…</span>;

  const provider = value.provider || meta.defaultProvider;
  const providerMeta = meta[provider] || {};
  const setProvider = (p) => onChange({ ...value, provider: p, model: meta[p]?.default || "" });

  return (
    <div className="model-picker">
      <label>
        Provider
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="gemini" disabled={!meta.gemini.configured}>Gemini (direct){meta.gemini.configured ? "" : " – no key"}</option>
          <option value="openrouter" disabled={!meta.openrouter.configured}>OpenRouter{meta.openrouter.configured ? "" : " – no key"}</option>
        </select>
      </label>
      <label>
        Model
        {provider === "gemini" ? (
          <select value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
            {providerMeta.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : (
          <input
            list="or-models"
            value={value.model}
            placeholder="deepseek/deepseek-v4-flash"
            onChange={(e) => onChange({ ...value, model: e.target.value })}
          />
        )}
        {provider === "openrouter" && (
          <datalist id="or-models">
            {(providerMeta.models || []).map((m) => (
              <option key={m.id} value={m.id}>{`${m.name} · ${Math.round(m.contextLength / 1000)}k ctx · $${(m.pricing?.prompt * 1e6).toFixed(2)}/M in`}</option>
            ))}
          </datalist>
        )}
      </label>
      <label className="inline">
        <input type="checkbox" checked={value.verify} onChange={(e) => onChange({ ...value, verify: e.target.checked })} />
        Run "what did we miss?" verification pass (2× cost, higher recall)
      </label>
      {providerMeta.error && <span className="error small">{providerMeta.error}</span>}
    </div>
  );
}
