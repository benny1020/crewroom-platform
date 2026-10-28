# License scope for original Crewroom materials

The [BSD Zero Clause license](LICENSE) applies to original Crewroom contributions at the following paths. References below are relative to the repository root. This scope does not replace the licenses of copied or derived third-party material.

- `README.md`, `PRODUCT.md`, `THIRD_PARTY_NOTICES.md`
- `.github/workflows/crewroom-image.yml`
- `doc/crewroom/**`
- `doc/plans/2026-10-28-crewroom-paperclip-foundation.md`
- `deploy/crewroom/**`, excluding credentials, environment files, runtime state and private snapshots
- `scripts/crewroom-bootstrap.mjs`, `scripts/crewroom-dev.mjs`, `scripts/setup-impeccable.py`
- `ui/src/pages/Crewroom.tsx`
- `ui/src/components/crewroom/**`
- `ui/src/api/crewroom.ts`, `ui/src/api/heartbeats.crewroom.test.ts`
- `ui/src/hooks/useCrewroomCapabilities.ts`
- `ui/src/lib/crewroom.ts`, `ui/src/lib/crewroom.test.ts`
- `server/src/routes/crewroom.ts`, `server/src/__tests__/crewroom-capabilities.test.ts`
- Original generated character bitmaps in `ui/public/crewroom/**`; copied third-party resources retain their own notices
- `crewroom/CLAUDE-ENDPOINT.md`, `crewroom/IMPECCABLE.md`, `crewroom/SOURCE-PROVENANCE.md`, `crewroom/UPSTREAM.json`, `crewroom/impeccable-manifest.json`, `crewroom/LICENSE-SCOPE.md`
- The original explanatory `crewroom/upstream-workflows/README.md` and receipt `crewroom/upstream-workflows/manifest.json`; this does not license the copied workflow definitions

Original materials preserved under `crewroom/legacy-assets/` retain their existing scoped license and third-party notices.

All Paperclip-derived source, including modified upstream files, remains under the root [MIT license](../LICENSE). This includes upstream service, route, hook and UI changes outside the original file scope above, `crewroom/UPSTREAM-README.md`, and the copied workflow YAML definitions in `crewroom/upstream-workflows/`. Root package metadata retains MIT.

Impeccable skill source and its copied license under `crewroom/licenses/impeccable/` remain Apache-2.0. Lucide resources retain their ISC notices. Other dependencies and third-party assets retain their respective licenses. A directory containing Crewroom files does not by itself grant 0BSD rights to third-party contents.
