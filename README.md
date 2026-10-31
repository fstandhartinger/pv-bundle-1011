Private preview bundle; encrypted.

## Artifact identifiers

`artifacts.manifest.json` maps stable UI sections to IDs allocated by the artifact registry.
The muted `a#` badges copy their identifier by click, Enter or Space. Local badge code
uses no external requests and preserves the existing access controls and content policy.
`server.mjs` copies `artifact-assets/` into the private decrypted runtime and stamps
its HTML at startup. The encrypted bundle is unchanged. Assets remain under the existing
private prefix; read-only external share pages are deliberately unchanged. The observer
reattaches section badges after planner navigation or editor rendering.
