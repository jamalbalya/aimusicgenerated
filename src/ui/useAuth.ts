/**
 * The sign-in, as React sees it.
 *
 * A thin subscription over `auth/hfOAuth`, which holds the session in module
 * memory. Nothing is mirrored into component state or into the store: there is
 * one copy of the truth, it lives in one place, and it disappears when the page
 * does.
 */

import { useSyncExternalStore } from 'react'

import { getAuthState, isConfigured, signIn, signOut, subscribe, type AuthState } from '../auth/hfOAuth'

export interface Auth extends AuthState {
  /** Whether this build was given the public client id sign-in needs. */
  configured: boolean
  signIn: () => void
  signOut: () => void
}

export function useAuth(): Auth {
  const state = useSyncExternalStore(subscribe, getAuthState, getAuthState)
  return {
    ...state,
    configured: isConfigured(),
    // Called straight from the click handler, because a popup opened after an
    // await is a popup the browser blocks.
    signIn: () => { void signIn() },
    signOut,
  }
}
