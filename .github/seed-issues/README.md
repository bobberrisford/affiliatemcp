# Seed issues

Pre-drafted issue bodies that the maintainer can file once the GitHub repo is
public. Each markdown file in this directory is the body of one issue,
structured to mirror the corresponding form template under
`.github/ISSUE_TEMPLATE/`.

These are not auto-filed. They live in the repo so the issue tracker can be
seeded deliberately, in a sensible order, after public launch.

## Convention

Filename prefix indicates the template the issue maps to:

- `network-request-<slug>.md` — file with `--label new-network,needs-triage`.
- `network-broken-<slug>.md` — file with `--label broken,needs-triage`.
- `skill-idea-<slug>.md` — file with `--label skill-idea,discussion`.
- `docs-<topic>.md` — file with `--label docs`.
- `setup-stuck-<slug>.md` — file with `--label docs,setup`.
- `correction-<topic>.md` — file with `--label correction`.
- `discussion-<topic>.md` — file with `--label discussion`.

The title of each issue is the first H1 of the file. The body is everything
after that first H1.

## Filing

Use `seed.sh` from this directory once `gh` is authenticated:

```
cd .github/seed-issues
./seed.sh
```

The script reads each file, derives labels from the filename prefix, and
shells out to `gh issue create`. Review the output before merging the seed
batch; nothing in this directory is filed automatically by CI.
