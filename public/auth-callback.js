const ERROR_MESSAGES = {
  access_denied: 'Sign-in was cancelled or denied. Please try again.',
  otp_expired: 'This verification link has expired. Please request a new one.',
  invalid_request: 'This sign-in link is invalid. Please try signing in again.',
  server_error: 'Authentication service is temporarily unavailable. Please try again.',
};

function showFailure(message) {
  document.querySelector('.login-subtitle').textContent = 'Sign-in failed';
  document.querySelector('.loading').hidden = true;
  const confirmBtn = document.querySelector('#confirm-btn');
  if (confirmBtn) confirmBtn.hidden = true;
  const errorEl = document.querySelector('#auth-error');
  errorEl.textContent = message;
  errorEl.hidden = false;
}

async function submitCallback(payload) {
  const response = await fetch('/api/auth/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: JSON.stringify(payload),
    credentials: 'include',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Sign-in could not be completed.');
  }
  window.location.replace('/');
}

async function handleAuthCallback() {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');
  const errorCode = url.searchParams.get('error') || fragment.get('error');
  const hasErrorDescription = Boolean(url.searchParams.get('error_description') || fragment.get('error_description'));
  history.replaceState(null, '', '/auth/callback');

  try {
    if (errorCode || hasErrorDescription) {
      throw new Error(ERROR_MESSAGES[errorCode] || 'This sign-in link could not be verified. Please try signing in again.');
    }
    if (code) {
      await submitCallback({ code });
      return;
    }
    if (tokenHash && type) {
      // Require an explicit user click so email security scanners cannot consume single-use tokens
      // and cross-site GET navigations cannot force Login CSRF silently.
      document.querySelector('.login-subtitle').textContent = 'Confirm your email to sign in';
      document.querySelector('.loading').hidden = true;
      const confirmBtn = document.querySelector('#confirm-btn');
      confirmBtn.hidden = false;
      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Confirming...';
        try {
          await submitCallback({ tokenHash, type });
        } catch (err) {
          showFailure(err.message);
        }
      });
      return;
    }
    throw new Error('This sign-in link is invalid or expired. Please try signing in again.');
  } catch (err) {
    showFailure(err.message);
  }
}

handleAuthCallback();
