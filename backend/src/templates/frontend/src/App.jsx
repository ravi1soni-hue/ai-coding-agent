import React from 'react';

export default function App() {
  return (
    <main style={{
      fontFamily: 'system-ui, sans-serif',
      minHeight: '100vh',
      margin: 0,
      padding: '3rem',
      background: '#f5f7fb',
      color: '#111827',
    }}>
      <div style={{
        maxWidth: 900,
        margin: '0 auto',
        padding: '2rem',
        background: '#ffffff',
        borderRadius: '24px',
        boxShadow: '0 24px 80px rgba(15, 23, 42, 0.08)',
      }}>
        <h1 style={{ fontSize: 'clamp(2rem, 4vw, 3rem)', marginBottom: '1rem' }}>
          Welcome to your generated app
        </h1>
        <p style={{ fontSize: '1.05rem', lineHeight: 1.8, marginBottom: '1.75rem' }}>
          This starter page is the default template for new generated projects. Replace this content with your own app code and redeploy.
        </p>
        <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <section style={{ padding: '1.5rem', borderRadius: '18px', background: '#f8fafc' }}>
            <h2 style={{ margin: 0, marginBottom: '0.75rem', fontSize: '1.1rem' }}>Ready to customize</h2>
            <p style={{ margin: 0, color: '#4b5563' }}>
              Edit <code style={{ background: '#e5e7eb', padding: '0.15rem 0.35rem', borderRadius: '0.35rem' }}>src/App.jsx</code> to start building your app.
            </p>
          </section>
          <section style={{ padding: '1.5rem', borderRadius: '18px', background: '#eff6ff' }}>
            <h2 style={{ margin: 0, marginBottom: '0.75rem', fontSize: '1.1rem' }}>Instant deployment</h2>
            <p style={{ margin: 0, color: '#2563eb' }}>
              Your generated app is ready to deploy. This page is intentionally simple so your own UI can take over.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
