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
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
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

// Initialize
$('#login-form').addEventListener('submit', handleLogin);
// Focus email field on load
$('#login-email').focus();
