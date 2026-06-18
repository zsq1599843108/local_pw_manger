let sessionKey = null;
let passwords = [];

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    
    if (data.status === 'ok') {
      document.getElementById('setup-form').style.display = 'none';
      document.getElementById('login-form').style.display = 'block';
    }
  } catch (err) {
    console.error('Auth check failed:', err);
  }
}

async function setupMasterPassword() {
  const password = document.getElementById('setup-password').value;
  const confirm = document.getElementById('setup-password-confirm').value;
  
  if (password.length < 8) {
    showToast('Master password must be at least 8 characters');
    return;
  }
  
  if (password !== confirm) {
    showToast('Passwords do not match');
    return;
  }
  
  try {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterPassword: password })
    });
    
    const data = await res.json();
    
    if (data.success) {
      showToast('Master password set successfully');
      document.getElementById('setup-form').style.display = 'none';
      document.getElementById('login-form').style.display = 'block';
    } else {
      showToast(data.error || 'Setup failed');
    }
  } catch (err) {
    showToast('Network error');
  }
}

let pendingSessionKey = null;

async function login() {
  const password = document.getElementById('login-password').value;
  
  if (!password) {
    showToast('Please enter master password');
    return;
  }
  
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ masterPassword: password })
    });
    
    const data = await res.json();
    
    if (data.success) {
      if (document.getElementById('use-phone-verify').checked) {
        pendingSessionKey = data.sessionKey;
        document.getElementById('phone-verify-modal').classList.add('active');
        document.getElementById('phone-code-input').focus();
      } else {
        sessionKey = data.sessionKey;
        document.getElementById('auth-screen').classList.remove('active');
        document.getElementById('main-screen').classList.add('active');
        loadPasswords();
      }
    } else {
      showToast(data.error || 'Verification failed');
    }
  } catch (err) {
    showToast('Network error');
  }
}

function closePhoneVerifyModal() {
  document.getElementById('phone-verify-modal').classList.remove('active');
  pendingSessionKey = null;
  document.getElementById('phone-code-input').value = '';
}

async function verifyPhoneCode() {
  const code = document.getElementById('phone-code-input').value.trim();
  
  if (!code || code.length !== 4) {
    showToast('Please enter a 4-digit code');
    return;
  }
  
  try {
    const res = await fetch('/api/phone/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, sessionKey: pendingSessionKey })
    });
    
    const data = await res.json();
    
    if (data.success) {
      sessionKey = pendingSessionKey;
      pendingSessionKey = null;
      closePhoneVerifyModal();
      document.getElementById('auth-screen').classList.remove('active');
      document.getElementById('main-screen').classList.add('active');
      loadPasswords();
      showToast('Phone verified successfully');
    } else {
      showToast(data.error || 'Invalid code');
    }
  } catch (err) {
    showToast('Verification failed');
  }
}

function logout() {
  sessionKey = null;
  passwords = [];
  document.getElementById('main-screen').classList.remove('active');
  document.getElementById('auth-screen').classList.add('active');
  document.getElementById('login-password').value = '';
}

async function loadPasswords() {
  if (!sessionKey) return;
  
  try {
    const res = await fetch(`/api/passwords?sessionKey=${sessionKey}`);
    passwords = await res.json();
    renderPasswords();
  } catch (err) {
    showToast('Failed to load');
  }
}

function renderPasswords(filter = '') {
  const container = document.getElementById('password-list');
  const filtered = passwords.filter(p => 
    p.title.toLowerCase().includes(filter.toLowerCase()) ||
    (p.username && p.username.toLowerCase().includes(filter.toLowerCase())) ||
    (p.url && p.url.toLowerCase().includes(filter.toLowerCase()))
  );
  
  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>No passwords yet</h2>
        <p>Click "Add Password" to get started</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = filtered.map(p => `
    <div class="password-card" data-id="${p.id}">
      <h3>
        <span>${escapeHtml(p.title)}</span>
        <span class="category">${escapeHtml(p.category)}</span>
      </h3>
      ${p.username ? `
        <div class="field">
          <label>Username</label>
          <input type="text" value="${escapeHtml(p.username)}" readonly>
          <button onclick="copyToClipboard('${escapeHtml(p.username)}')" class="btn-icon">📋</button>
        </div>
      ` : ''}
      <div class="field">
        <label>Password</label>
        <input type="password" value="${escapeHtml(p.password)}" readonly id="pwd-${p.id}">
        <button onclick="togglePasswordVisibility('pwd-${p.id}')" class="btn-icon">👁</button>
        <button onclick="copyToClipboard('${escapeHtml(p.password)}')" class="btn-icon">📋</button>
      </div>
      ${p.url ? `
        <div class="field">
          <label>URL</label>
          <input type="text" value="${escapeHtml(p.url)}" readonly>
          <button onclick="window.open('${escapeHtml(p.url)}', '_blank')" class="btn-icon">🔗</button>
        </div>
      ` : ''}
      ${p.notes ? `
        <div class="field">
          <label>Notes</label>
          <span>${escapeHtml(p.notes)}</span>
        </div>
      ` : ''}
      <div class="actions">
        <button onclick="editEntry(${p.id})" class="btn-secondary">Edit</button>
        <button onclick="deleteEntry(${p.id})" class="btn-secondary" style="background:rgba(255,100,100,0.3)">Delete</button>
      </div>
    </div>
  `).join('');
}

function filterPasswords() {
  const filter = document.getElementById('search-input').value;
  renderPasswords(filter);
}

function showAddModal() {
  document.getElementById('modal-title').textContent = 'Add Password';
  document.getElementById('edit-id').value = '';
  document.getElementById('entry-title').value = '';
  document.getElementById('entry-username').value = '';
  document.getElementById('entry-password').value = '';
  document.getElementById('entry-url').value = '';
  document.getElementById('entry-notes').value = '';
  document.getElementById('entry-category').value = 'default';
  document.getElementById('add-modal').classList.add('active');
}

function editEntry(id) {
  const entry = passwords.find(p => p.id === id);
  if (!entry) return;
  
  document.getElementById('modal-title').textContent = 'Edit Password';
  document.getElementById('edit-id').value = id;
  document.getElementById('entry-title').value = entry.title;
  document.getElementById('entry-username').value = entry.username || '';
  document.getElementById('entry-password').value = entry.password;
  document.getElementById('entry-url').value = entry.url || '';
  document.getElementById('entry-notes').value = entry.notes || '';
  document.getElementById('entry-category').value = entry.category;
  document.getElementById('add-modal').classList.add('active');
}

function closeModal() {
  document.getElementById('add-modal').classList.remove('active');
}

async function saveEntry() {
  const id = document.getElementById('edit-id').value;
  const title = document.getElementById('entry-title').value;
  const username = document.getElementById('entry-username').value;
  const password = document.getElementById('entry-password').value;
  const url = document.getElementById('entry-url').value;
  const notes = document.getElementById('entry-notes').value;
  const category = document.getElementById('entry-category').value;
  
  if (!title || !password) {
    showToast('Title and password are required');
    return;
  }
  
  const body = { sessionKey, title, username, password, url, notes, category };
  
  try {
    const url_endpoint = id ? `/api/passwords/${id}` : '/api/passwords';
    const method = id ? 'PUT' : 'POST';
    
    const res = await fetch(url_endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    const data = await res.json();
    
    if (data.success) {
      showToast(id ? 'Updated successfully' : 'Added successfully');
      closeModal();
      loadPasswords();
    } else {
      showToast(data.error || 'Operation failed');
    }
  } catch (err) {
    showToast('Network error');
  }
}

async function deleteEntry(id) {
  if (!confirm('Are you sure you want to delete this entry?')) return;
  
  try {
    const res = await fetch(`/api/passwords/${id}`, {
      method: 'DELETE'
    });
    
    const data = await res.json();
    
    if (data.success) {
      showToast('Deleted successfully');
      loadPasswords();
    }
  } catch (err) {
    showToast('Delete failed');
  }
}

function showGenerateModal() {
  document.getElementById('generate-modal').classList.add('active');
  generateNewPassword();
}

function closeGenerateModal() {
  document.getElementById('generate-modal').classList.remove('active');
}

async function generateNewPassword() {
  const length = document.getElementById('gen-length').value;
  const uppercase = document.getElementById('gen-uppercase').checked;
  const lowercase = document.getElementById('gen-lowercase').checked;
  const numbers = document.getElementById('gen-numbers').checked;
  const symbols = document.getElementById('gen-symbols').checked;
  
  try {
    const res = await fetch(`/api/generate?length=${length}&uppercase=${uppercase}&lowercase=${lowercase}&numbers=${numbers}&symbols=${symbols}`);
    const data = await res.json();
    document.getElementById('generated-password').value = data.password;
  } catch (err) {
    showToast('Generation failed');
  }
}

function copyGeneratedPassword() {
  const password = document.getElementById('generated-password').value;
  copyToClipboard(password);
}

function fillGeneratedPassword() {
  const password = document.getElementById('generated-password').value;
  if (password) {
    document.getElementById('entry-password').value = password;
    closeGenerateModal();
  } else {
    generateNewPassword().then(() => {
      const password = document.getElementById('generated-password').value;
      document.getElementById('entry-password').value = password;
      closeGenerateModal();
    });
  }
}

function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  input.type = input.type === 'password' ? 'text' : 'password';
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('Copied to clipboard');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

async function exportPasswords() {
  if (!sessionKey) return;
  
  try {
    const res = await fetch(`/api/export?sessionKey=${sessionKey}`);
    const data = await res.json();
    
    if (data.error) {
      showToast(data.error);
      return;
    }
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `passwords_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast(`Exported ${data.count} entries`);
  } catch (err) {
    showToast('Export failed');
  }
}

async function importPasswords(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  if (!sessionKey) {
    showToast('Please login first');
    return;
  }
  
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    
    if (!data.entries || !Array.isArray(data.entries)) {
      showToast('Invalid import file format');
      return;
    }
    
    if (!confirm(`Import ${data.entries.length} password entries?`)) {
      event.target.value = '';
      return;
    }
    
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey, entries: data.entries })
    });
    
    const result = await res.json();
    
    if (result.success) {
      showToast(`Imported ${result.imported} entries, skipped ${result.skipped}`);
      loadPasswords();
    } else {
      showToast(result.error || 'Import failed');
    }
  } catch (err) {
    showToast('Failed to parse import file');
  }
  
  event.target.value = '';
}

document.addEventListener('DOMContentLoaded', () => {
  checkAuthStatus();
  
  document.getElementById('login-password').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') login();
  });
  
  document.getElementById('setup-password-confirm').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') setupMasterPassword();
  });
});
