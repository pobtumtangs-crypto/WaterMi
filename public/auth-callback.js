async function handleAuthCallback() {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error_description') || fragment.get('error_description');
  history.replaceState(null, '', '/auth/callback');

  try {
    if (error) throw new Error(error);
    if (!code) {
      throw new Error('This sign-in link is invalid or expired. Please try signing in again.');
    }
    const response = await fetch('/api/auth/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Sign-in could not be completed.');
    }
    window.location.replace('/');
  } catch (err) {
    document.querySelector('.login-subtitle').textContent = 'Sign-in failed';
    document.querySelector('.loading').hidden = true;
    const error = document.querySelector('#auth-error');
    error.textContent = err.message;
    error.hidden = false;
  }
}

handleAuthCallback();
