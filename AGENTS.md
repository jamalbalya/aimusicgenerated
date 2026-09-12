# Project instructions

## Git identity — not negotiable

Every commit in this repository is the owner's. No tool, assistant or bot is
credited anywhere in the history.

**Before committing, and before every push:**

1. Author and committer must both be `jamalbalya`. Check with
   `git var GIT_AUTHOR_IDENT` — that is what the commit will actually record,
   and it accounts for environment overrides a config file does not show.
2. The repository-local config is the authority:
   `git config --local user.name "jamalbalya"`. A global config inherited from
   the machine must never reach a commit; this has happened before and is the
   reason the hooks exist.
3. Confirm the push is authenticated as the GitHub user `jamalbalya`.

**Never, in a commit message, a pull request, a code comment, a document or a
file committed to this repository:**

- a `Co-authored-by`, `Generated-by`, `Assisted-by` or `Created-by` trailer
- an assistant, model, vendor or bot named as having written the change
- a "generated with" line, or a robot emoji used as a credit
- any attribution footer of any kind

**Never create a branch named after a tool, assistant or vendor**, or prefixed
with one. The canonical branch is `free-music-generation-tools-fy4esb`. Push
there unless the owner asks otherwise, and never to a differently named branch
without being asked.

Two version-controlled hooks in `.githooks/` enforce this — `pre-commit` checks
the identity, `commit-msg` checks the text. Do not weaken, bypass, disable or
`--no-verify` past them. If one blocks a commit, the commit is wrong, not the
hook. The full policy, including how to install the hooks in a fresh clone, is
`docs/GIT_IDENTITY_POLICY.md`.

## Working on this project

- `npm run verify` runs typecheck, lint, unit tests and both builds.
- End-to-end tests need a build first; the neural specs need
  `ACE_STEP_BACKEND=zerogpu ACE_STEP_SPACE_URL=… VITE_HF_CLIENT_ID=…` or they
  skip themselves.
- The Hugging Face Space under `poc/zerogpu-space/` is the security boundary for
  neural generation. Its gate is tested by `live_boundary_test.py`; a test that
  cannot prove what it claims must report UNVERIFIED rather than pass.
- Do not weaken a security control to make a test pass.
