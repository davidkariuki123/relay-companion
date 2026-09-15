function parseStructuredOutput(text) {
  const source = String(text || "").trim();
  if (!source) return null;
  const candidates = [source];
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidates.push(fenced[1]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed?.forHuman === "string" && typeof parsed?.forAgent === "string") return parsed;
    } catch {}
  }
  return null;
}

export function relayCompletion(text) {
  const structured = parseStructuredOutput(text);
  if (structured) {
    const forHuman = structured.forHuman.trim();
    const forAgent = structured.forAgent.trim();
    if (forHuman && forAgent) return { forHuman, forAgent };
  }
  const fallback = String(text || "").trim();
  if (!fallback) return null;
  return { forHuman: fallback, forAgent: fallback };
}
