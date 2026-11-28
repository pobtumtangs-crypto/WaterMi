const $ = (selector) => document.querySelector(selector);

// Simple toast notification
let toastTimer;
function toast(message) {
  const node = $('#toast');
  (document.querySelector('dialog[open]') ?? document.body).append(node);
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3500);
}

async function handleRegister(event) {
  event.preventDefault();

  const submitBtn = $('#register-submit');
  const errorEl = $('#register-error');
  const name = $('#register-name').value.trim();
  const email = $('#register-email').value.trim();
  const password = $('#register-password').value;
  const confirm = $('#register-confirm').value;

  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating account...';

  try {
    if (password !== confirm) {
      throw new Error('Passwords do not match');
    }

    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
      body: JSON.stringify({ name, email, password }),
      credentials: 'include',
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || 'Registration failed');
    }

    if (data.needsConfirmation) {
      toast('Account created. Check your email for the confirmation link.');
      $('#register-form').hidden = true;
    } else {
      window.location.replace('/');
    }
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Account';
  }
}

// Initialize
$('#register-form').addEventListener('submit', handleRegister);
// Focus first field on load
$('#register-name').focus();
