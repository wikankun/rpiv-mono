---
title: "Release notes: v1.8.2"
description: "Pipeline artifacts move from thoughts/shared/ to .rpiv/artifacts/, and rpiv-site clears its W3C HTML/CSS validation errors."
pubDate: 2026-05-17T22:00:00Z
author: juicesharp
tags: ["release", "rpiv-pi", "rpiv-site"]
draft: false
---

## rpiv-pi

### Changed
- Pipeline artifacts migrated from `thoughts/shared/` to `.rpiv/artifacts/`, with automatic migration of existing content on session start.

## rpiv-site

### Changed
- Site content updated to reflect the artifact path migration to `.rpiv/artifacts/`.

### Fixed
- Resolved W3C HTML and CSS validation errors, including heading-level skips, invalid ARIA attributes, and redundant landmark roles.
