/**
 * The whole of the application, before you are let into it.
 *
 * This studio is private. A visitor who is not signed in sees this page and
 * nothing else — no navigation, no tools, no transport, not even the offline
 * engine, which runs in the browser and would otherwise be a way in.
 *
 * There is one action here on purpose. The password is typed on Hugging Face's
 * own login page and never on this origin: this page opens that one, and the
 * only thing that comes back is an authorization code exchanged with PKCE.
 * There is no form here to fill in, and there never will be one.
 *
 * What this page is not: a security boundary. It is a static site, so anyone
 * determined can read its JavaScript and render the shell without signing in.
 * What that gets them is the offline tools running in their own browser at
 * their own expense. Everything that costs anything — the Space, the GPU, the
 * account — is refused on the server by `poc/zerogpu-space/guard.py`, which
 * verifies the token against Hugging Face and checks the allowlist on every
 * request, and cannot be talked out of it from here.
 */

import { Icon } from '../components/Icon'
import type { Auth } from '../useAuth'

/** Shown to someone who signed in successfully and still may not come in. */
function NotApproved({ auth }: { auth: Auth }) {
  return (
    <>
      <p className="t-label">Signed in, not approved</p>
      <h1 className="t-display">This studio is not yours to use</h1>
      <p className="text-[13px] leading-relaxed text-[var(--text-dim)]">
        You are signed in to Hugging Face as <strong>{auth.identity?.username}</strong>, and that
        account is not the one this studio belongs to. Nothing here is available to it — signing in
        again with the same account will end in the same place.
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" className="btn btn-primary" onClick={auth.signOut}>
          Sign out
        </button>
      </div>
    </>
  )
}

export default function LoginPage({ auth }: { auth: Auth }) {
  const signedInElsewhere = auth.status === 'signed-in'

  return (
    <div className="grid min-h-full place-items-center px-4 py-12" data-testid="login-page">
      <main className="grid w-full max-w-[440px] gap-4 rounded-[14px] border border-[var(--line)]
                       bg-[var(--bg-panel)] p-6 sm:p-8">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-[var(--accent)]
                           text-[var(--on-accent,#fff)]">
            <Icon name="wave" size={17} />
          </span>
          <span className="t-display text-[19px]">Resonant Studio</span>
        </div>

        {signedInElsewhere ? <NotApproved auth={auth} /> : (
          <>
            <p className="t-label">Private studio</p>
            <h1 className="t-display">Sign in to continue</h1>
            <p className="text-[13px] leading-relaxed text-[var(--text-dim)]">
              This studio is private. Sign in with the Hugging Face account it belongs to, and the
              tools appear.
            </p>

            {auth.configured ? (
              <button
                type="button"
                className="btn btn-primary w-full justify-center"
                onClick={auth.signIn}
                disabled={auth.status === 'signing-in'}
              >
                {auth.status === 'signing-in' ? 'Signing in…' : 'Sign in with Hugging Face'}
              </button>
            ) : (
              <p className="text-[13px] text-[var(--bad,#f87171)]" role="alert">
                Signing in is not configured in this build, so there is no way in. Whoever deployed
                it needs to set <code>VITE_HF_CLIENT_ID</code>.
              </p>
            )}

            <p className="text-[12px] leading-relaxed text-[var(--text-dim)]">
              Your password is typed on huggingface.co and is never seen by this site. It asks only
              for your username — nothing about your repositories, and nothing it could write.
            </p>
          </>
        )}

        {auth.problem && (
          <p className="text-[12px] text-[var(--bad,#f87171)]" role="alert" data-testid="login-problem">
            {auth.problem}
          </p>
        )}
      </main>
    </div>
  )
}
