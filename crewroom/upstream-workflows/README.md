# Inactive upstream workflow and automation source

These Paperclip workflows are preserved verbatim as source provenance. GitHub only discovers workflows under `.github/workflows`, so this copy cannot run release, package publication, schedules, deployment, or upstream-specific CI in the Crewroom fork. Any future Crewroom CI must be added explicitly and reviewed for its destinations and credentials. `manifest.json` preserves original paths.

The original `.github/dependabot.yml` is also retained verbatim here as an inactive **Dependabot configuration**, separate from the 23 workflow files. It was removed from its active GitHub location so the fork does not inherit upstream dependency-update PR schedules and limits. This is not a new update schedule and does not change repository security-alert settings.
