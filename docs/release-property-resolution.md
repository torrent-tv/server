# Release property resolution

`parseReleaseName()` returns `release.sources` with unchanged GuessIt and Anitomy
outputs. `release.candidates` retains every observation, its original value,
source and field path. `release.normalized` contains resolved values or `null`.
`release.resolutions` records status, applied rules, rejection reasons,
alternatives and provenance. `release.conflicts` lists incompatible remaining
values. These diagnostics are returned in metadata identification responses.

Configure properties in `services/metadata/release-properties.js`. Each property
declares readers, optional canonicalization, dependencies and an ordered rule
list. The generic engine in `property-resolution.js` orders dependencies and
applies those rules without branches for particular properties or parsers.
Registry cycles and unknown dependencies are errors.

Rules validate observations, reconcile equivalent labels and use explicit
filename context. Disagreement remains unresolved unless a rule has supporting
evidence; there are no confidence weights or implicit parser preferences.
Four-digit years describe syntax rather than an assumed calendar range.
Episode numbers have no arbitrary upper bound. A number explained as a year
needs an explicit episode marker to serve as an episode as well. Unresolved
year evidence preserves that ambiguity. A series year span identifies its start
year rather than the final year.

Add a reader or rule to the property registry to extend resolution. Rules return
filtered candidates with rejected observations and a reason, a selected value,
or an explicit stop preserving uncertainty. Raw parser output is never changed.
