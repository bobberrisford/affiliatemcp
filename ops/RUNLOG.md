# Company operations run log

Append-only. One line per `company-ops` daily run. The last timestamp here is
the "since" boundary for the next run's feedback sweep. Never rewrite history;
only append. This file is the durable trail for a prepare-and-approve operation
where the outward-facing state lives in Buffer, Gmail, and GitHub.

Format:

    <ISO-8601 UTC> | approvals:<n> feedback:<n> drafts(support:<n> onboarding:<n> marketing:<n>) | blocked:<n> | note

Example:

    2026-07-21T08:00:00Z | approvals:3 feedback:5 drafts(support:2 onboarding:1 marketing:1) | blocked:0 | first run

<!-- runs below, newest last -->
