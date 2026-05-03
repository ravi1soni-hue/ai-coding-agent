import React from 'react';

export default function AuthPage({ mode, setMode, form, setForm, busy, error, onSubmit }) {
  const isSignup = mode === 'signup';

  return (
    <div className="mainBg authPageBg">
      <div className="authShell">
        <section className="authFormPane">
          <h1 className="authTitle">Sign into your account</h1>
          <p className="authSubtitle">Access your builder workspace and continue your projects.</p>

          <div className="authTabs" role="tablist" aria-label="Authentication mode">
            <button
              className={`authTab ${isSignup ? 'active' : ''}`}
              type="button"
              onClick={() => setMode('signup')}
            >
              Sign up
            </button>
            <button
              className={`authTab ${!isSignup ? 'active' : ''}`}
              type="button"
              onClick={() => setMode('login')}
            >
              Log in
            </button>
          </div>

          <form className="authForm" onSubmit={onSubmit}>
            {isSignup ? (
              <label className="authLabel">
                Full name
                <input
                  className="authInput"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="Enter your name"
                  autoComplete="name"
                  required
                />
              </label>
            ) : null}

            <label className="authLabel">
              Email
              <input
                className="authInput"
                type="email"
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                placeholder="Enter your email"
                autoComplete="email"
                required
              />
            </label>

            <label className="authLabel">
              Password
              <input
                className="authInput"
                type="password"
                value={form.password}
                onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                placeholder="Enter your password"
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                required
                minLength={8}
              />
            </label>

            {isSignup ? (
              <label className="authLabel">
                Repeat the password
                <input
                  className="authInput"
                  type="password"
                  value={form.confirmPassword}
                  onChange={(e) => setForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
                  placeholder="Repeat your password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </label>
            ) : null}

            {error ? <div className="authError">{error}</div> : null}

            <button className="authSubmit" type="submit" disabled={busy}>
              {busy ? 'Please wait...' : isSignup ? 'Create account' : 'Log in'}
            </button>
          </form>
        </section>

        <section className="authVisualPane" aria-hidden="true">
          <img
            className="authVisualImg"
            src="https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1200&q=80"
            alt=""
          />
          <div className="authVisualOverlay">
            <p>
              Build faster with guided sessions, saved project IDs, and authenticated workspaces made for
              iterative shipping.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
