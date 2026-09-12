# Git identity policy

Every commit in this repository is authored and committed by the repository
owner. Nothing else is credited — not a tool, not an assistant, not a bot, and
not in a trailer, a co-author line or the prose of a message.

## The identity

| field | value |
| --- | --- |
| author name | `jamalbalya` |
| committer name | `jamalbalya` |
| author / committer email | the owner's GitHub-verified address |
| GitHub owner | `jamalbalya` |
| canonical branch | `free-music-generation-tools-fy4esb` |

## Rules

1. **Commits use the `jamalbalya` identity.** Both author and committer, on
   every commit, with no exceptions.
2. **No assistant, bot or tool attribution.** Not as an author, not as a
   co-author, not as a generator, and not mentioned in the message body as
   having written the change.
3. **No `Co-authored-by` trailers.** Nor `Generated-by`, `Assisted-by`,
   `Created-by` or any equivalent.
4. **No branch named after a tool, assistant or vendor**, or prefixed with
   one. The canonical branch is the one named above.
5. **Every push is authenticated as `jamalbalya`.** Check before pushing;
   see below.
6. **Verify your identity before you push**, not after. A wrong identity is
   cheap to prevent and expensive to remove, because removing it means
   rewriting history and force-pushing.

### Where the specific names live

The repository does not spell out the vendor and product names it rejects.
Writing them into a tracked file to ban them would put them back in exactly the
place this policy is clearing. So `commit-msg` carries only the generic rules —
attribution trailers, "generated with" lines, a robot emoji used as a credit —
and reads any specific names from an untracked local list at
`.git/attribution-blocklist`, one name or extended-regex pattern per line.

That list is per clone and is not version controlled. Without it the generic
rules still stand, and `pre-commit` still refuses any identity but the owner's,
which is the mechanical guarantee; the list only adds name matching on top.

The message hook matches text, so it cannot tell a credit from a description of
one: a message quoting a banned trailer verbatim is refused even when explaining
the rule. Describe the pattern instead of reproducing it.

## How this is enforced

Two hooks in `.githooks/`, version controlled so the policy travels with the
repository rather than living in one person's `.git/hooks`:

| hook | refuses |
| --- | --- |
| `pre-commit` | a commit whose author or committer name is not `jamalbalya` |
| `commit-msg` | a message containing an attribution trailer, an assistant or vendor name used as a credit, or a "generated with" line |

`pre-commit` reads `git var GIT_AUTHOR_IDENT`, which is what the commit will
actually record — config precedence and environment overrides included — so it
checks the real value rather than one particular config file.

### Enabling them in a fresh clone

Hooks are not copied by `git clone`. Once per clone:

```sh
git config --local core.hooksPath .githooks
git config --local user.name  "jamalbalya"
git config --local user.email "<your GitHub-verified address>"

# Optional, and untracked by design: names to reject in a commit message.
printf '%s\n' 'name-to-reject' 'another-name' > "$(git rev-parse --git-dir)/attribution-blocklist"
```

Verify all four with:

```sh
git config --local core.hooksPath                       # .githooks
git var GIT_AUTHOR_IDENT                                # jamalbalya <...>
printf 'test\n\nCo-authored-by: x <y@z>\n' > /tmp/m && .githooks/commit-msg /tmp/m   # must fail
printf 'fix: an ordinary message\n' > /tmp/m && .githooks/commit-msg /tmp/m            # must pass
```

The repository-local settings override any global ones. That matters: a global
`user.name` belonging to a tool or a shared machine is exactly how the wrong
identity gets onto a commit, and the local value is what stops it.

### Checking before you push

```sh
git config --local user.name              # jamalbalya
git var GIT_AUTHOR_IDENT                  # what the next commit will record
git log -5 --format='%an <%ae> | %cn <%ce> | %s'
git log origin/main..HEAD --format='%B' | grep -iE 'co-authored-by|generated-by'
```

The last command should print nothing.

## If a wrong identity gets in anyway

Do not push it. If it is only local, `git commit --amend --reset-author` fixes
the most recent commit and an interactive rebase fixes older ones.

If it has already been pushed, the history has to be rewritten and force-pushed,
which changes every subsequent commit hash and breaks anyone else's clone. Take
a backup bundle first (`git bundle create <path> --all`), rewrite, then push
with `--force-with-lease` so the push refuses if the remote moved unexpectedly.

Note that GitHub's Contributors panel is cached and derived from the default
branch. Removing an identity from history does not remove it from that panel
immediately, and unreachable commits can stay reachable by hash for a while
until GitHub garbage-collects them.
