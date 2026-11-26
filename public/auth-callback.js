async function handleAuthCallback() {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');
  const accessToken = fragment.get('access_token');
  const refreshToken = fragment.get('refresh_token');
  const error = url.searchParams.get('error_description') || fragment.get('error_description');
  history.replaceState(null, '', '/auth/callback');

  try {
    if (error) throw new Error(error);
    let payload;
    if (code) {
      payload = { code };
    } else if (tokenHash && type) {
      payload = { tokenHash, type };
    } else if (accessToken) {
      payload = { accessToken, refreshToken: refreshToken || '' };
    } else {
      throw new Error('This sign-in link is invalid or expired. Please try signing in again.');
    }
    const response = await fetch('/api/auth/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'include',
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Sign-in could not be completed.');
    }
    window.location.replace('/');
  } catch (err) {
    document.querySelector('.login-subtitle').textContent = 'Sign-in failed';
    document.querySelector('.loading').hidden = true;
    const errorEl = document.querySelector('#auth-error');
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
}

handleAuthCallback();
