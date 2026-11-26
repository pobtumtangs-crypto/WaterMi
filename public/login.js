const $ = (selector) => document.querySelector(selector);

async function handleLogin(event) {
  event.preventDefault();

  const submitBtn = $('#login-submit');
  const errorEl = $('#login-error');
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;

  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include',
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }

    window.location.replace('/');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in with Email';
  }
}

async function handleGoogleAuth(event) {
  const btn = event.currentTarget;
  btn.disabled = true;
  const errorEl = $('#login-error');
  errorEl.hidden = true;
  btn.setAttribute('aria-busy', 'true');

  try {
    const res = await fetch('/api/auth/google', { method: 'POST', credentials: 'include' });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || 'Google auth failed');
    }

    if (!data.url) throw new Error('Google sign-in could not be started.');
    window.location.assign(data.url);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

// Initialize
$('#login-form').addEventListener('submit', handleLogin);
$('#google-signin').addEventListener('click', handleGoogleAuth);
// Focus email field on load
$('#login-email').focus();
