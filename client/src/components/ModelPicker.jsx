import { useEffect, useState } from "react";
import { api } from "../api.js";

// The OpenRouter models offered for analysis. The first is the default.
// All three read ~1M tokens, return schema-checked JSON and cost a few cents
// per tender; add a model here only after trying it on a real tender.
export const OPENROUTER_MODELS = [
  { id: "deepseek/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash (recommended)" },
  { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash" },
  { id: "minimax/minimax-m3.1-flash", label: "MiniMax M3.1 Flash" },
];

/**
 * Provider + model selector. value = { provider, model }
 */
export default function ModelPicker({ value, onChange }) {
  const [meta, setMeta] = useState(null);

  useEffect(() => {
    api.models().then((m) => {
      setMeta(m);
      if (!value.provider) onChange({ ...value, provider: m.defaultProvider, model: defaultModel(m, m.defaultProvider) });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!meta) return <span className="muted small">Loading models…</span>;

  const provider = value.provider || meta.defaultProvider;
  const providerMeta = meta[provider] || {};
  const setProvider = (p) => onChange({ ...value, provider: p, model: defaultModel(meta, p) });
  // A tender analysed with a model that's no longer in the list keeps it as
  // an option, so re-running it doesn't silently switch models.
  const options = value.model && !OPENROUTER_MODELS.some((m) => m.id === value.model)
    ? [...OPENROUTER_MODELS, { id: value.model, label: `${value.model} (used last time)` }]
    : OPENROUTER_MODELS;

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
          <select value={value.model || OPENROUTER_MODELS[0].id} onChange={(e) => onChange({ ...value, model: e.target.value })}>
            {options.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
      </label>
      {providerMeta.error && <span className="error small">{providerMeta.error}</span>}
    </div>
  );
}

function defaultModel(meta, provider) {
  if (provider === "openrouter") return OPENROUTER_MODELS[0].id;
  return meta[provider]?.default || "";
}
