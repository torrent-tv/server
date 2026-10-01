/** Resolve evidence through declared property rules without mutating sources. */
export function resolveProperties(sources, definitions, context = {}) {
  const candidates = {};
  const normalized = {};
  const resolutions = {};
  const conflicts = {};
  const read = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = property => {
    if (visited.has(property)) return;
    if (!definitions[property]) throw new Error(`Unknown evidence dependency: ${property}`);
    if (visiting.has(property)) throw new Error(`Cyclic evidence dependency: ${property}`);
    visiting.add(property);
    for (const dependency of definitions[property].dependsOn ?? []) visit(dependency);
    visiting.delete(property);
    visited.add(property);
    ordered.push(property);
  };
  Object.keys(definitions).forEach(visit);
  for (const property of ordered) {
    const definition = definitions[property];
    const supplied = definition.readers.flatMap(({ source, path, convert = value => value }) => {
      const raw = read(sources[source] ?? context[source], path);
      return (raw == null ? [] : Array.isArray(raw) ? raw : [raw]).map(rawValue => ({
        source, path, rawValue, value: definition.canonicalize ? definition.canonicalize(convert(rawValue)) : convert(rawValue)
      }));
    });
    candidates[property] = supplied;
    let remaining = supplied;
    let selected = null;
    const steps = [];
    for (const rule of definition.rules) {
      const result = rule.apply({ property, candidates: remaining, normalized, resolutions, context });
      if (!result) continue;
      steps.push({ rule: rule.id, reason: result.reason, rejected: result.rejected ?? [] });
      remaining = result.candidates ?? remaining;
      if (result.stop) break;
      if (Object.hasOwn(result, "value")) {
        selected = result.value;
        break;
      }
    }
    normalized[property] = selected;
    const distinct = [...new Set(remaining.map(candidate => candidate.value))];
    if (selected === null && distinct.length > 1) conflicts[property] = distinct;
    resolutions[property] = {
      status: selected !== null ? "resolved" : remaining.length ? "unresolved" : supplied.length ? "rejected" : "absent",
      steps,
      alternatives: distinct,
      provenance: selected === null ? [] : remaining.filter(candidate => candidate.value === selected)
        .map(({ source, path }) => ({ source, path }))
    };
  }
  return { sources, candidates, normalized, resolutions, conflicts };
}

export function filterEvidence(id, predicate, reason) {
  return { id, apply: state => {
    const rejected = state.candidates.filter(candidate => !predicate(candidate, state));
    return rejected.length ? { candidates: state.candidates.filter(candidate => predicate(candidate, state)), rejected, reason } : null;
  } };
}

export const uniqueEvidence = {
  id: "unique-evidence",
  apply: ({ candidates }) => {
    const values = [...new Set(candidates.map(candidate => candidate.value))];
    return values.length === 1 ? { value: values[0], reason: "All remaining observations name one value." } : null;
  }
};

export function excludeOtherProperty(property, unless = () => false) {
  const rule = filterEvidence(`exclude-${property}-evidence`, (candidate, state) =>
    state.normalized[property] == null || candidate.value !== state.normalized[property] || unless(candidate, state),
  `An observation already explained by ${property} needs independent evidence for this property.`);
  return { id: rule.id, apply: state => {
    if (state.resolutions[property]?.status === "unresolved" && state.candidates.some(candidate =>
      state.resolutions[property].alternatives.includes(candidate.value) && !unless(candidate, state))) {
      return { stop: true, reason: `This observation may describe ${property}, whose value remains unresolved.` };
    }
    return rule.apply(state);
  } };
}

export function preferContextEvidence(source, id, when, reason) {
  return { id, apply: state => {
    if (!when(state.context)) return null;
    const preferred = [...new Set(state.candidates.filter(candidate => candidate.source === source).map(candidate => candidate.value))];
    if (preferred.length !== 1) return null;
    const rejected = state.candidates.filter(candidate => candidate.value !== preferred[0]);
    return { candidates: state.candidates.filter(candidate => candidate.value === preferred[0]), rejected, reason };
  } };
}

export function aliasCanonicalizer(groups) {
  const aliases = new Map(Object.entries(groups).flatMap(([canonical, values]) =>
    [canonical, ...values].map(value => [String(value).toLowerCase(), canonical])));
  return value => aliases.get(String(value).toLowerCase()) ?? value;
}
