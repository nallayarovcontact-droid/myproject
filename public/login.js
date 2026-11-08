'use strict';
const form = document.getElementById('login');
const errorEl = document.getElementById('error');

// Only follow same-site relative paths after login (prevents open redirects like ?next=https://evil.example).
function safeNext() {
  const next = new URLSearchParams(location.search).get('next') || '/admin/';
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/admin/';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: form.elements.namedItem('username').value, password: form.elements.namedItem('password').value }),
  });
  if (res.ok) {
    location.assign(safeNext());
  } else {
    const body = await res.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Sign in failed';
    form.elements.namedItem('password').value = '';
  }
});
