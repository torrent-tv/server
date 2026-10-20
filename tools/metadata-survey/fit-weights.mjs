import fs from "node:fs";
import path from "node:path";

const BASE_WEIGHTS = Object.freeze({ title: 8, year: 32, runtime: 24, episodes: 2, russianTitle: 1, releaseCount: 1, episodeTitles: 1, language: 1 });
const FEATURES = Object.keys(BASE_WEIGHTS);
const OPTIONS = Object.freeze({
  title: [1, 2, 4, 8, 12, 16],
  year: [32, 40, 48, 64],
  runtime: [24, 32, 40, 48, 64],
  episodes: [0, 1, 2, 4, 8, 12, 16],
  russianTitle: [0, 1, 2, 4, 8, 12, 16],
  releaseCount: [0, 1, 2, 4, 8, 12, 16],
  episodeTitles: [0, 1, 2, 4, 8, 12, 16],
  language: [0, 1, 2, 4, 8, 12, 16]
});

function keyOf(row) {
  return `${row.label.site}/${row.label.kind}/${row.label.sourceId}`;
}

function hashOf(value) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash;
}

function splitOf(row) {
  return hashOf(row.label.imdbId) % 5 === 0 ? "test" : "train";
}

function usableCandidates(row) {
  return (row.response?.ranked ?? []).filter((candidate) => candidate.contradiction === null);
}

function labeledRows(baselineFile, durationFile) {
  const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  const byKey = new Map(baseline.filter((row) => row.label).map((row) => [keyOf(row), row]));
  if (durationFile) {
    const duration = JSON.parse(fs.readFileSync(durationFile, "utf8"));
    for (const row of duration) {
      if (row.label && row.response) byKey.set(keyOf(row), row);
    }
  }
  return [...byKey.values()].filter((row) => row.label?.tmdb?.tmdbId);
}

function truthIn(candidates, row) {
  return candidates.some((candidate) => candidate.kind === row.label.tmdb.kind && candidate.tmdbId === row.label.tmdb.tmdbId);
}

function ordered(candidates, weights) {
  return [...candidates].sort((left, right) => {
    const score = (candidate) => FEATURES.reduce((sum, feature) => sum + weights[feature] * (candidate.shares?.[feature] ?? 0), 0);
    return score(right) - score(left) || left.order - right.order;
  });
}

function distance(weights) {
  return FEATURES.reduce((sum, feature) => sum + Math.abs(weights[feature] - BASE_WEIGHTS[feature]), 0);
}

function evaluate(rows, weights) {
  const metrics = { total: rows.length, hasRanked: 0, truthRanked: 0, truthAllowed: 0, evaluated: 0, correct: 0 };
  for (const row of rows) {
    const all = row.response?.ranked ?? [];
    if (all.length) metrics.hasRanked++;
    if (truthIn(all, row)) metrics.truthRanked++;
    const candidates = usableCandidates(row);
    if (truthIn(candidates, row)) metrics.truthAllowed++;
    if (!candidates.length) continue;
    metrics.evaluated++;
    const [winner] = ordered(candidates, weights);
    if (winner.kind === row.label.tmdb.kind && winner.tmdbId === row.label.tmdb.tmdbId) metrics.correct++;
  }
  metrics.candidateCoverage = metrics.total ? metrics.truthRanked / metrics.total : 0;
  metrics.allowedCoverage = metrics.total ? metrics.truthAllowed / metrics.total : 0;
  metrics.accuracyAmongAllowed = metrics.truthAllowed ? metrics.correct / metrics.truthAllowed : 0;
  metrics.correctAmongAll = metrics.total ? metrics.correct / metrics.total : 0;
  return metrics;
}

function trainingCases(rows) {
  return rows.filter((row) => truthIn(usableCandidates(row), row));
}

function train(rows) {
  const starts = [
    { ...BASE_WEIGHTS },
    { ...BASE_WEIGHTS, title: 4, year: 48, runtime: 40 },
    { ...BASE_WEIGHTS, title: 12, year: 64, runtime: 64 },
    { ...BASE_WEIGHTS, episodes: 8, russianTitle: 8, releaseCount: 4, episodeTitles: 8, language: 4 }
  ];
  let best = null;
  for (const start of starts) {
    const weights = { ...start };
    let changed = true;
    for (let pass = 0; pass < 16 && changed; pass++) {
      changed = false;
      for (const feature of FEATURES) {
        let featureBest = { weight: weights[feature], correct: evaluate(rows, weights).correct, distance: distance(weights) };
        for (const weight of OPTIONS[feature]) {
          const candidate = { ...weights, [feature]: weight };
          const correct = evaluate(rows, candidate).correct;
          const candidateDistance = distance(candidate);
          if (correct > featureBest.correct || (correct === featureBest.correct && candidateDistance < featureBest.distance)) {
            featureBest = { weight, correct, distance: candidateDistance };
          }
        }
        if (weights[feature] !== featureBest.weight) {
          weights[feature] = featureBest.weight;
          changed = true;
        }
      }
    }
    const result = { weights: { ...weights }, correct: evaluate(rows, weights).correct, distance: distance(weights) };
    if (!best || result.correct > best.correct || (result.correct === best.correct && result.distance < best.distance)) best = result;
  }
  return best;
}

function featureCoverage(rows) {
  return Object.fromEntries(FEATURES.map((feature) => [feature, rows.filter((row) => {
    const candidates = usableCandidates(row);
    const values = new Set(candidates.map((candidate) => candidate.shares?.[feature] ?? 0));
    return values.size > 1;
  }).length]));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 3) {
    console.error("usage: node tools/metadata-survey/fit-weights.mjs <survey-results.json> [duration-results.json] [report.json]");
    process.exit(2);
  }
  const baselinePath = path.resolve(args[0]);
  const durationPath = args[1] ? path.resolve(args[1]) : null;
  const reportPath = args[2] ? path.resolve(args[2]) : null;
  const rows = labeledRows(baselinePath, durationPath);
  const trainRows = trainingCases(rows.filter((row) => splitOf(row) === "train"));
  const testRows = rows.filter((row) => splitOf(row) === "test");
  const fitted = train(trainRows);
  const report = {
    records: rows.length,
    uniqueImdb: new Set(rows.map((row) => row.label.imdbId)).size,
    split: { train: rows.filter((row) => splitOf(row) === "train").length, test: testRows.length, fittedTrainRows: trainRows.length },
    featureVariationRows: featureCoverage(rows),
    baselineWeights: BASE_WEIGHTS,
    fittedWeights: fitted.weights,
    baseline: { train: evaluate(rows.filter((row) => splitOf(row) === "train"), BASE_WEIGHTS), test: evaluate(testRows, BASE_WEIGHTS), all: evaluate(rows, BASE_WEIGHTS) },
    fitted: { train: evaluate(rows.filter((row) => splitOf(row) === "train"), fitted.weights), test: evaluate(testRows, fitted.weights), all: evaluate(rows, fitted.weights) }
  };
  const json = JSON.stringify(report, null, 2);
  if (reportPath) fs.writeFileSync(reportPath, `${json}\n`);
  console.log(json);
}

main();
