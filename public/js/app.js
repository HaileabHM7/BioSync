// BioSync Context Engine - App Logic
const state = {
  token: localStorage.getItem('biosync_token') || null,
  user: null,
  activeView: 'login',
  
  // Biometrics & hardware state
  heartRate: null,
  simulatedBpmInterval: null,
  bluetoothDevice: null,
  isBluetoothSimulated: false,
  
  // Webcam state
  webcamStream: null,
  capturedSnapshot: null,
  fatigueScore: 0,
  blinkFrequency: 0,
  
  // Websocket telemetry client
  ws: null,
  
  // Latest report
  latestReport: null,
  
  // Chart.js instances
  charts: {
    trends: null,
    activity: null,
    sleep: null
  }
};

// Selection data configuration
const wellnessGoalsOptions = [
  { id: 'lose_weight', label: 'Lose Weight' },
  { id: 'focus', label: 'Improve Focus' },
  { id: 'reduce_stress', label: 'Reduce Stress' },
  { id: 'build_muscle', label: 'Build Muscle' }
];

const hobbiesOptions = [
  { id: 'guitar', label: 'Guitar / Music' },
  { id: 'coding', label: 'Coding / Building' },
  { id: 'basketball', label: 'Basketball / Sports' },
  { id: 'reading', label: 'Reading Books' },
  { id: 'cooking', label: 'Cooking Recipes' },
  { id: 'gaming', label: 'Gaming' }
];

const selectedGoals = new Set();
const selectedHobbies = new Set();

const profileSelectedGoals = new Set();
const profileSelectedHobbies = new Set();

// --- ROUTER ---
const routes = {
  'landing': { requireAuth: false },
  'login': { requireAuth: false },
  'signup': { requireAuth: false },
  'dashboard': { requireAuth: true },
  'connect': { requireAuth: true },
  'webcam': { requireAuth: true },
  'analysis': { requireAuth: true },
  'report': { requireAuth: true },
  'profile': { requireAuth: true },
  'admin': { requireAuth: true, requireAdmin: true }
};

function navigateTo(viewId) {
  const route = routes[viewId];
  if (!route) return;

  // Authentication redirects
  if (route.requireAuth && !state.token) {
    return navigateTo('login');
  }
  if (route.requireAuth && route.requireAdmin && state.user?.role !== 'admin') {
    return navigateTo('dashboard');
  }

  // Update nav sidebar links active highlights
  document.querySelectorAll('.nav-link').forEach(item => {
    if (item.dataset.view === viewId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Clean up webcam stream if moving away from it
  if (state.activeView === 'webcam' && viewId !== 'webcam') {
    stopWebcam();
  }

  // Hide all views, show active
  document.querySelectorAll('.view-segment').forEach(segment => {
    segment.classList.add('hidden');
  });

  const targetSegment = document.getElementById(`view-${viewId}`);
  if (targetSegment) {
    targetSegment.classList.remove('hidden');
  }

  state.activeView = viewId;
  window.location.hash = viewId;

  // Toggle layout margins depending on auth state
  const isAuthView = route.requireAuth;
  updateSidebarVisibility(isAuthView);

  // View-specific initializers
  if (viewId === 'dashboard') {
    loadDashboard();
  } else if (viewId === 'report') {
    loadReportPage();
  } else if (viewId === 'admin') {
    loadAdminDashboard();
  } else if (viewId === 'profile') {
    loadProfileSettingsPage();
  }

  // Close dropdowns
  const dropdown = document.getElementById('profile-dropdown-menu');
  if (dropdown) dropdown.classList.remove('show');
}

function updateSidebarVisibility(visible) {
  const wrapper = document.getElementById('main-layout-wrapper');
  const sidebar = document.querySelector('.app-sidebar');
  const header = document.getElementById('app-top-header');

  if (visible) {
    sidebar.classList.remove('hidden');
    header.classList.remove('hidden');
    // Align margin-left of content panel depending on screen width
    wrapper.style.marginLeft = window.innerWidth > 968 ? '260px' : '80px';
  } else {
    sidebar.classList.add('hidden');
    header.classList.add('hidden');
    wrapper.style.marginLeft = '0';
  }
}

// Handle window resizing to keep layout margins aligned
window.addEventListener('resize', () => {
  const route = routes[state.activeView];
  if (route && route.requireAuth) {
    updateSidebarVisibility(true);
  }
});

// Window load and hash-change listeners
window.addEventListener('load', async () => {
  setupEventListeners();
  
  if (state.token) {
    const success = await fetchUserProfile();
    if (!success) {
      logout();
      return;
    }
    setupWebSocket();
  }
  
  const hash = window.location.hash.replace('#', '');
  if (hash && routes[hash]) {
    navigateTo(hash);
  } else {
    navigateTo(state.token ? 'dashboard' : 'landing');
  }

  // Set language preference on start
  const storedLang = localStorage.getItem('biosync_lang') || 'en';
  state.lang = storedLang;
  const langBtn = document.getElementById('lang-selector-btn');
  if (langBtn) {
    langBtn.textContent = storedLang === 'en' ? 'EN' : 'አ';
  }
  applyLanguage(storedLang);
});

window.addEventListener('hashchange', () => {
  const hash = window.location.hash.replace('#', '');
  if (hash && routes[hash] && hash !== state.activeView) {
    navigateTo(hash);
  }
});

// --- API COMMUNICATIONS ---
async function fetchUserProfile() {
  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    if (!res.ok) throw new Error('Failed to fetch profile');
    const data = await res.json();
    state.user = data;
    updateUserUI();
    return true;
  } catch (err) {
    console.error('Profile fetch failed:', err.message);
    return false;
  }
}

function updateUserUI() {
  if (state.user) {
    document.querySelectorAll('.auth-only').forEach(el => el.classList.remove('hidden'));
    document.querySelectorAll('.guest-only').forEach(el => el.classList.add('hidden'));
    
    // Set headers
    document.getElementById('avatar-circle-icon').textContent = state.user.email[0].toUpperCase();
    document.getElementById('dropdown-header-email').textContent = state.user.email;
    document.getElementById('dropdown-header-role').textContent = state.user.role;

    if (state.user.role === 'admin') {
      document.getElementById('sid-admin-link').classList.remove('hidden');
    } else {
      document.getElementById('sid-admin-link').classList.add('hidden');
    }
  } else {
    document.querySelectorAll('.auth-only').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.guest-only').forEach(el => el.classList.remove('hidden'));
    document.getElementById('sid-admin-link').classList.add('hidden');
  }
}

// --- TELEMETRY WEBSOCKET ---
function setupWebSocket() {
  if (state.ws) {
    state.ws.close();
  }

  // Prevent connection attempts when run locally via file:// protocol
  const host = window.location.host;
  if (!host) {
    console.warn('Running locally via file:// protocol. WebSocket disabled.');
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${host}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    state.ws.send(JSON.stringify({
      type: 'auth',
      token: state.token
    }));
    console.log('Telemetry WebSocket connected.');
  };

  state.ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleWebSocketMessage(message);
    } catch (e) {
      console.error('WS client parse error:', e.message);
    }
  };

  state.ws.onclose = () => {
    console.log('Telemetry WebSocket closed. Reconnecting in 5s...');
    setTimeout(() => {
      if (state.token) setupWebSocket();
    }, 5000);
  };
}

function handleWebSocketMessage(message) {
  if (state.activeView !== 'admin') return;

  const matrixGrid = document.getElementById('live-matrix-grid');
  
  if (message.type === 'matrix_init') {
    matrixGrid.innerHTML = '';
    message.matrix.forEach(u => renderMatrixCard(u));
  } else if (message.type === 'user_connected' || message.type === 'user_telemetry') {
    const user = message.user || message;
    renderMatrixCard(user);
  } else if (message.type === 'user_disconnected') {
    const card = document.getElementById(`matrix-card-${message.userId}`);
    if (card) {
      card.remove();
      if (matrixGrid.children.length === 0) {
        matrixGrid.innerHTML = '<div class="glass-panel text-center" style="grid-column: 1/-1;">No users streaming telemetry right now.</div>';
      }
    }
  }
}

function renderMatrixCard(user) {
  const matrixGrid = document.getElementById('live-matrix-grid');
  const placeholder = matrixGrid.querySelector('.text-center');
  if (placeholder) placeholder.remove();

  let card = document.getElementById(`matrix-card-${user.userId}`);
  if (!card) {
    card = document.createElement('div');
    card.id = `matrix-card-${user.userId}`;
    card.className = 'matrix-card';
    matrixGrid.appendChild(card);
  }

  const isSyncing = user.status === 'Syncing Smartwatch';
  const statusDotClass = isSyncing ? 'matrix-status-dot syncing' : 'matrix-status-dot active';
  const bpmDisplay = user.heartRate ? `${user.heartRate} <span class="matrix-label">BPM</span>` : 'N/A';

  card.innerHTML = `
    <div class="matrix-user-header">
      <span class="matrix-email">${user.email.split('@')[0]}</span>
      <span class="${statusDotClass}"></span>
    </div>
    <div class="matrix-bpm-num" style="color: ${user.heartRate > 100 ? 'var(--accent-pink)' : 'var(--accent-cyan)'}">
      ${bpmDisplay}
    </div>
    <div class="matrix-label">${user.status}</div>
    <div class="matrix-label" style="font-size:0.65rem; margin-top:0.25rem;">
      Last update: ${new Date(user.lastUpdate).toLocaleTimeString()}
    </div>
  `;
}

function sendTelemetryUpdate(bpm, status) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'telemetry',
      heartRate: bpm,
      status: status
    }));
  }
}

// --- GOALS AND HOBBIES UI BINDERS ---
function initGoalHobbySelectors() {
  // Clear previous cache to ensure multi-account state separation
  selectedGoals.clear();
  selectedHobbies.clear();

  const goalsGrid = document.getElementById('goals-selection-grid');
  goalsGrid.innerHTML = '';
  wellnessGoalsOptions.forEach(opt => {
    const card = document.createElement('div');
    card.className = 'selection-card';
    card.dataset.id = opt.id;
    card.innerHTML = `
      <span class="selection-label">${opt.label}</span>
    `;
    card.addEventListener('click', () => {
      if (selectedGoals.has(opt.id)) {
        selectedGoals.delete(opt.id);
        card.classList.remove('selected');
      } else {
        selectedGoals.add(opt.id);
        card.classList.add('selected');
      }
    });
    goalsGrid.appendChild(card);
  });

  const hobbiesGrid = document.getElementById('hobbies-selection-grid');
  hobbiesGrid.innerHTML = '';
  hobbiesOptions.forEach(opt => {
    const card = document.createElement('div');
    card.className = 'selection-card';
    card.dataset.id = opt.id;
    card.innerHTML = `
      <span class="selection-label">${opt.label}</span>
    `;
    card.addEventListener('click', () => {
      if (selectedHobbies.has(opt.id)) {
        selectedHobbies.delete(opt.id);
        card.classList.remove('selected');
      } else {
        selectedHobbies.add(opt.id);
        card.classList.add('selected');
      }
    });
    hobbiesGrid.appendChild(card);
  });
}

// --- SETUP ALL FRONTEND LISTENERS ---
function setupEventListeners() {
  // Navigation elements
  document.querySelectorAll('[data-view]').forEach(el => {
    el.addEventListener('click', (e) => {
      const view = el.dataset.view;
      if (view) {
        navigateTo(view);
      }
    });
  });

  // Profile dropdown menu toggle
  const profileMenuBtn = document.getElementById('header-profile-menu-btn');
  const dropdownMenu = document.getElementById('profile-dropdown-menu');
  if (profileMenuBtn && dropdownMenu) {
    profileMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownMenu.classList.toggle('show');
    });

    document.addEventListener('click', () => {
      dropdownMenu.classList.remove('show');
    });
  }

  const dropdownLogoutBtn = document.getElementById('dropdown-logout-btn');
  if (dropdownLogoutBtn) {
    dropdownLogoutBtn.addEventListener('click', logout);
  }

  // Sidebar logout button
  const sidebarLogoutBtn = document.getElementById('sidebar-logout-btn');
  if (sidebarLogoutBtn) {
    sidebarLogoutBtn.addEventListener('click', logout);
  }

  // Language selector
  const langBtn = document.getElementById('lang-selector-btn');
  const langMenu = document.getElementById('language-menu');
  if (langBtn && langMenu) {
    langBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      langMenu.classList.toggle('show');
    });

    document.querySelectorAll('.language-option').forEach(option => {
      option.addEventListener('click', (e) => {
        const lang = option.dataset.lang;
        langBtn.textContent = lang === 'en' ? 'EN' : 'አ';
        langMenu.classList.remove('show');
        // Store language preference
        localStorage.setItem('biosync_lang', lang);
        state.lang = lang;
        applyLanguage(lang);
      });
    });

    document.addEventListener('click', () => {
      langMenu.classList.remove('show');
    });
  }

  // Authentication Forms
  document.getElementById('login-form').addEventListener('submit', handleLoginSubmit);
  document.getElementById('signup-form').addEventListener('submit', handleSignupSubmit);

  // Onboarding Wizard bindings
  bindWizardEvents();

  // Telegram Link binds
  const telegramConnectBtn = document.getElementById('telegram-connect-btn');
  if (telegramConnectBtn) {
    telegramConnectBtn.addEventListener('click', generateTelegramPin);
  }
  const telegramCancelPinBtn = document.getElementById('telegram-cancel-pin-btn');
  if (telegramCancelPinBtn) {
    telegramCancelPinBtn.addEventListener('click', cancelTelegramPinGeneration);
  }

  // Bluetooth Pairing
  document.getElementById('ble-pair-btn').addEventListener('click', connectSmartwatch);
  document.getElementById('ble-sim-btn').addEventListener('click', simulateSmartwatch);
  document.getElementById('ble-disconnect-btn').addEventListener('click', disconnectSmartwatch);

  // Webcam Scanning
  document.getElementById('camera-start-btn').addEventListener('click', startWebcam);
  document.getElementById('camera-capture-btn').addEventListener('click', captureWebcamSnapshot);
  document.getElementById('camera-reset-btn').addEventListener('click', resetWebcamScanner);
  document.getElementById('camera-stop-btn').addEventListener('click', stopWebcam);

  // Sliders for Daily input
  const sleepSlider = document.getElementById('sleep-slider');
  const sleepValue = document.getElementById('sleep-value');
  sleepSlider.addEventListener('input', () => {
    sleepValue.textContent = `${sleepSlider.value} hrs`;
  });

  const stressSlider = document.getElementById('stress-slider');
  const stressValue = document.getElementById('stress-value');
  stressSlider.addEventListener('input', () => {
    stressValue.textContent = `${stressSlider.value}/10`;
  });

  const stepsSlider = document.getElementById('steps-slider');
  const stepsValue = document.getElementById('steps-value');
  stepsSlider.addEventListener('input', () => {
    stepsValue.textContent = Number(stepsSlider.value).toLocaleString();
  });

  const activeSlider = document.getElementById('active-slider');
  const activeValue = document.getElementById('active-value');
  activeSlider.addEventListener('input', () => {
    activeValue.textContent = `${activeSlider.value} mins`;
  });

  const waterCupsSlider = document.getElementById('water-cups-slider');
  const waterCupsValue = document.getElementById('water-cups-value');
  waterCupsSlider.addEventListener('input', () => {
    waterCupsValue.textContent = `${waterCupsSlider.value}/8 cups`;
  });

  // Aggregate Submission
  document.getElementById('analysis-submit-btn').addEventListener('click', submitSessionAnalysis);

  // Profile Save
  document.getElementById('profile-update-form').addEventListener('submit', handleProfileUpdateSubmit);

  // PDF Report Actions
  document.getElementById('report-pdf-btn').addEventListener('click', downloadReportPDF);
  document.getElementById('report-share-btn').addEventListener('click', shareReportPDF);
  document.getElementById('report-back-btn').addEventListener('click', () => navigateTo('dashboard'));
  document.getElementById('profile-back-btn').addEventListener('click', () => navigateTo('dashboard'));

  // Share Modal Closes
  document.getElementById('share-modal-close').addEventListener('click', () => {
    document.getElementById('share-modal-overlay').classList.remove('show');
  });
  document.getElementById('share-copy-link-btn').addEventListener('click', copyShareLinkToClipboard);
  document.getElementById('share-native-btn').addEventListener('click', triggerNativeShare);

  // Admin Fine-Tuning Settings
  document.getElementById('admin-settings-form').addEventListener('submit', submitAdminSettings);

  // Onboarding switcher links
  document.getElementById('to-signup-link').addEventListener('click', (e) => {
    e.preventDefault();
    initOnboardingWizard();
    navigateTo('signup');
  });

  document.getElementById('to-login-link').addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo('login');
  });
}

// --- USER AUTHENTICATION ---
async function handleLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');

  errorEl.classList.add('hidden');

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    state.token = data.token;
    localStorage.setItem('biosync_token', data.token);
    state.user = data.user;
    
    // Clear old state from previous account
    resetLocalBiometricState();

    updateUserUI();
    setupWebSocket();
    navigateTo('dashboard');
    document.getElementById('login-form').reset();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

async function handleSignupSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('signup-email').value;
  const password = document.getElementById('signup-password').value;
  const errorEl = document.getElementById('signup-error');

  errorEl.classList.add('hidden');

  // Validate Step 3 questions (Q6 to Q10)
  for (let i = 6; i <= 10; i++) {
    const question = document.querySelector(`.wizard-question[data-qid="q${i}"]`);
    const selected = question.querySelectorAll('.selection-card.selected');
    if (selected.length === 0) {
      errorEl.textContent = `Please answer question ${i} before creating your account.`;
      errorEl.classList.remove('hidden');
      return;
    }
  }

  // Collect answers
  const onboardingAnswers = {};
  document.querySelectorAll('.wizard-question').forEach(q => {
    const qid = q.dataset.qid;
    const type = q.dataset.type;
    const selected = Array.from(q.querySelectorAll('.selection-card.selected')).map(el => el.dataset.val);
    onboardingAnswers[qid] = type === 'single' ? (selected[0] || '') : selected;
  });

  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        onboardingAnswers
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');

    state.token = data.token;
    localStorage.setItem('biosync_token', data.token);
    state.user = data.user;

    resetLocalBiometricState();

    updateUserUI();
    setupWebSocket();
    navigateTo('dashboard');
    document.getElementById('signup-form').reset();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('biosync_token');
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  disconnectSmartwatch();
  stopWebcam();
  resetLocalBiometricState();
  updateUserUI();
  navigateTo('login');
}

function resetLocalBiometricState() {
  state.heartRate = null;
  state.capturedSnapshot = null;
  state.fatigueScore = 0;
  state.blinkFrequency = 0;
  state.latestReport = null;
  
  // Clear selected sets
  selectedGoals.clear();
  selectedHobbies.clear();
  profileSelectedGoals.clear();
  profileSelectedHobbies.clear();

  // Reset slider UI displays to default values
  document.getElementById('sleep-slider').value = 6.5;
  document.getElementById('sleep-value').textContent = '6.5 hrs';
  document.getElementById('stress-slider').value = 3;
  document.getElementById('stress-value').textContent = '3/10';
  document.getElementById('steps-slider').value = 4250;
  document.getElementById('steps-value').textContent = '4,250';
  document.getElementById('active-slider').value = 45;
  document.getElementById('active-value').textContent = '45 mins';
  document.getElementById('water-cups-slider').value = 6;
  document.getElementById('water-cups-value').textContent = '6/8 cups';

  // Reset webcam preview tag
  const snapPreview = document.getElementById('snapshot-preview');
  snapPreview.src = '';
  snapPreview.style.display = 'none';

  const video = document.getElementById('camera-stream');
  video.style.display = 'none';
  video.classList.add('hidden');

  document.getElementById('camera-start-btn').style.display = 'inline-flex';
  document.getElementById('camera-capture-btn').style.display = 'none';
  document.getElementById('camera-reset-btn').style.display = 'none';
  document.getElementById('camera-stop-btn').style.display = 'none';
  document.getElementById('scan-results-box').classList.add('hidden');
}

// --- PROFILE SETTINGS MANAGEMENT ---
function loadProfileSettingsPage() {
  if (!state.user) return;

  document.getElementById('profile-email').value = state.user.email;
  document.getElementById('profile-password').value = '';
  document.getElementById('profile-status-message').classList.add('hidden');

  profileSelectedGoals.clear();
  state.user.wellnessGoals.forEach(g => profileSelectedGoals.add(g));

  profileSelectedHobbies.clear();
  state.user.hobbies.forEach(h => profileSelectedHobbies.add(h));

  // Render wellness goals selection
  const goalsGrid = document.getElementById('profile-goals-grid');
  goalsGrid.innerHTML = '';
  wellnessGoalsOptions.forEach(opt => {
    const card = document.createElement('div');
    card.className = 'selection-card';
    if (profileSelectedGoals.has(opt.id)) card.classList.add('selected');
    card.innerHTML = `
      <span class="selection-label">${opt.label}</span>
    `;
    card.addEventListener('click', () => {
      if (profileSelectedGoals.has(opt.id)) {
        profileSelectedGoals.delete(opt.id);
        card.classList.remove('selected');
      } else {
        profileSelectedGoals.add(opt.id);
        card.classList.add('selected');
      }
    });
    goalsGrid.appendChild(card);
  });

  // Render hobbies selection
  const hobbiesGrid = document.getElementById('profile-hobbies-grid');
  hobbiesGrid.innerHTML = '';
  hobbiesOptions.forEach(opt => {
    const card = document.createElement('div');
    card.className = 'selection-card';
    if (profileSelectedHobbies.has(opt.id)) card.classList.add('selected');
    card.innerHTML = `
      <span class="selection-label">${opt.label}</span>
    `;
    card.addEventListener('click', () => {
      if (profileSelectedHobbies.has(opt.id)) {
        profileSelectedHobbies.delete(opt.id);
        card.classList.remove('selected');
      } else {
        profileSelectedHobbies.add(opt.id);
        card.classList.add('selected');
      }
    });
    hobbiesGrid.appendChild(card);
  });

  // Fetch Telegram link status
  fetchTelegramLinkingStatus();
}

async function handleProfileUpdateSubmit(e) {
  e.preventDefault();
  const password = document.getElementById('profile-password').value;
  const statusEl = document.getElementById('profile-status-message');

  statusEl.classList.add('hidden');

  if (profileSelectedGoals.size === 0 || profileSelectedHobbies.size === 0) {
    statusEl.textContent = 'Please select at least one goal and one hobby.';
    statusEl.className = 'badge badge-pink mb-1';
    statusEl.classList.remove('hidden');
    return;
  }

  const payload = {
    wellnessGoals: Array.from(profileSelectedGoals),
    hobbies: Array.from(profileSelectedHobbies)
  };

  if (password) {
    payload.password = password;
  }

  try {
    const res = await fetch('/api/auth/profile', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update profile');

    state.user = data.user;
    updateUserUI();

    statusEl.textContent = 'Profile updated successfully!';
    statusEl.className = 'badge badge-green mb-1';
    statusEl.classList.remove('hidden');
    document.getElementById('profile-password').value = '';
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'badge badge-pink mb-1';
    statusEl.classList.remove('hidden');
  }
}

// --- SMARTWATCH CONNECTION LAYER (GATT FIXES) ---
async function connectSmartwatch() {
  const statusEl = document.getElementById('ble-status-text');
  const detailsEl = document.getElementById('ble-details');
  const actionContainer = document.getElementById('ble-action-container');
  const disconnectBtn = document.getElementById('ble-disconnect-btn');

  statusEl.textContent = "Searching for Bluetooth heart rate monitors...";
  
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }]
    });

    statusEl.textContent = `Connecting to ${device.name}...`;
    state.bluetoothDevice = device;
    state.isBluetoothSimulated = false;

    // Use standard Web Bluetooth gatt property
    const gattServer = device.gatt;
    const gattConnectedServer = await gattServer.connect();
    
    const service = await gattConnectedServer.getPrimaryService('heart_rate');
    const characteristic = await service.getCharacteristic('heart_rate_measurement');
    
    await characteristic.startNotifications();
    
    statusEl.textContent = "Connected";
    statusEl.classList.add('connected');
    detailsEl.textContent = `Device Name: ${device.name} | Live pulse sync active`;

    characteristic.addEventListener('characteristicvaluechanged', (event) => {
      const value = event.target.value;
      const bpm = value.getUint8(1);
      state.heartRate = bpm;
      updateBpmUI(bpm);
      sendTelemetryUpdate(bpm, 'Syncing Smartwatch');
    });

    actionContainer.classList.add('hidden');
    disconnectBtn.classList.remove('hidden');
    document.getElementById('pulse-vis-container').classList.add('pulse-active');
    startEcgVisualizer();

  } catch (err) {
    console.error('Web Bluetooth connection failed:', err.message);
    statusEl.textContent = "Not Connected";
    statusEl.classList.remove('connected');
    detailsEl.textContent = `Standard BLE device not found. Try launching the simulator to test features.`;
  }
}

function simulateSmartwatch() {
  const statusEl = document.getElementById('ble-status-text');
  const detailsEl = document.getElementById('ble-details');
  const actionContainer = document.getElementById('ble-action-container');
  const disconnectBtn = document.getElementById('ble-disconnect-btn');

  statusEl.textContent = "Connecting to BioSync Virtual Band X-1...";
  
  setTimeout(() => {
    state.isBluetoothSimulated = true;
    state.heartRate = 72;
    updateBpmUI(72);
    
    statusEl.textContent = "Connected";
    statusEl.classList.add('connected');
    detailsEl.textContent = "Device Name: BioSync Virtual Band X-1 | Telemetry Simulation Active";
    
    actionContainer.classList.add('hidden');
    disconnectBtn.classList.remove('hidden');
    document.getElementById('pulse-vis-container').classList.add('pulse-active');
    
    // Heartbeat simulation
    state.simulatedBpmInterval = setInterval(() => {
      const stressInput = parseInt(document.getElementById('stress-slider').value);
      const baseHr = 65 + (stressInput * 3.5);
      const fluctuation = Math.floor(Math.random() * 7) - 3;
      state.heartRate = Math.round(baseHr + fluctuation);
      
      updateBpmUI(state.heartRate);
      sendTelemetryUpdate(state.heartRate, 'Syncing Smartwatch');
    }, 1500);

    startEcgVisualizer();
  }, 1000);
}

function disconnectSmartwatch() {
  if (state.bluetoothDevice && !state.isBluetoothSimulated) {
    if (state.bluetoothDevice.gatt && state.bluetoothDevice.gatt.connected) {
      state.bluetoothDevice.gatt.disconnect();
    }
  }

  if (state.simulatedBpmInterval) {
    clearInterval(state.simulatedBpmInterval);
    state.simulatedBpmInterval = null;
  }

  state.heartRate = null;
  state.bluetoothDevice = null;
  state.isBluetoothSimulated = false;

  const statusEl = document.getElementById('ble-status-text');
  statusEl.textContent = "Not Connected";
  statusEl.classList.remove('connected');
  
  document.getElementById('ble-details').textContent = "Click the button below to open the native Bluetooth selector";
  document.getElementById('ble-action-container').classList.remove('hidden');
  document.getElementById('ble-disconnect-btn').classList.add('hidden');
  document.getElementById('pulse-vis-container').classList.remove('pulse-active');
  
  document.getElementById('dash-widget-hr').textContent = '72'; // reset to default
  document.getElementById('live-bpm-value').innerHTML = '-- <span class="live-bpm-unit">BPM</span>';

  const canvas = document.getElementById('ecg-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  sendTelemetryUpdate(null, 'Disconnected');
}

function updateBpmUI(bpm) {
  document.getElementById('live-bpm-value').innerHTML = `${bpm} <span class="live-bpm-unit">BPM</span>`;
  document.getElementById('dash-widget-hr').textContent = bpm;
}

// ECG Canvas pulse wave
function startEcgVisualizer() {
  const canvas = document.getElementById('ecg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight;

  let points = [];
  const maxPoints = canvas.width;

  function draw() {
    if (!state.heartRate) return;
    
    requestAnimationFrame(draw);
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#4f46e5'; // indigo
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 8;
    ctx.shadowColor = 'rgba(79, 70, 229, 0.4)';
    ctx.beginPath();

    const heartRatePeriod = 60 / state.heartRate;
    const timeFactor = (Date.now() / 1000) % heartRatePeriod;
    const waveProgress = timeFactor / heartRatePeriod;

    let y = canvas.height / 2;

    if (waveProgress > 0.1 && waveProgress < 0.15) {
      y -= Math.sin((waveProgress - 0.1) / 0.05 * Math.PI) * 7;
    } else if (waveProgress >= 0.18 && waveProgress < 0.2) {
      y += ((waveProgress - 0.18) / 0.02) * 10;
    } else if (waveProgress >= 0.2 && waveProgress < 0.24) {
      y -= ((waveProgress - 0.2) / 0.04) * 35;
    } else if (waveProgress >= 0.24 && waveProgress < 0.28) {
      y += 18 - ((waveProgress - 0.24) / 0.04) * 35;
    } else if (waveProgress >= 0.35 && waveProgress < 0.45) {
      y -= Math.sin((waveProgress - 0.35) / 0.1 * Math.PI) * 12;
    }

    points.push(y);
    if (points.length > maxPoints) {
      points.shift();
    }

    for (let i = 0; i < points.length; i++) {
      if (i === 0) {
        ctx.moveTo(i, points[i]);
      } else {
        ctx.lineTo(i, points[i]);
      }
    }
    ctx.stroke();
  }

  draw();
}

// --- WEBCAM SCANNER (Visibility Toggles & Reset fixes) ---
async function startWebcam() {
  const video = document.getElementById('camera-stream');
  const snapPreview = document.getElementById('snapshot-preview');
  
  const startBtn = document.getElementById('camera-start-btn');
  const captureBtn = document.getElementById('camera-capture-btn');
  const resetBtn = document.getElementById('camera-reset-btn');
  const stopBtn = document.getElementById('camera-stop-btn');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false
    });

    state.webcamStream = stream;
    video.srcObject = stream;
    
    // Clear styles and show elements cleanly
    video.style.display = 'block';
    video.classList.remove('hidden');
    snapPreview.style.display = 'none';
    snapPreview.classList.add('hidden');
    video.play();

    startBtn.style.display = 'none';
    captureBtn.style.display = 'inline-flex';
    resetBtn.style.display = 'none';
    stopBtn.style.display = 'inline-flex';

    document.getElementById('scanner-guide').classList.add('scanner-active');

  } catch (err) {
    alert('Failed to access webcam. Please verify camera permissions. ' + err.message);
  }
}

function captureWebcamSnapshot() {
  const video = document.getElementById('camera-stream');
  const canvas = document.getElementById('snapshot-canvas');
  const snapPreview = document.getElementById('snapshot-preview');
  
  const captureBtn = document.getElementById('camera-capture-btn');
  const resetBtn = document.getElementById('camera-reset-btn');
  const stopBtn = document.getElementById('camera-stop-btn');
  
  if (!state.webcamStream) return;

  const ctx = canvas.getContext('2d');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;

  // Mirror image capture
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const dataUrl = canvas.toDataURL('image/jpeg');
  state.capturedSnapshot = dataUrl;

  // Clean DOM elements visibility toggles
  snapPreview.src = dataUrl;
  snapPreview.style.display = 'block';
  snapPreview.classList.remove('hidden');
  
  video.style.display = 'none';
  video.classList.add('hidden');

  captureBtn.style.display = 'none';
  resetBtn.style.display = 'inline-flex';
  stopBtn.style.display = 'none';
  
  document.getElementById('scanner-guide').classList.remove('scanner-active');

  // Fatigue score calculation based on sliders
  const stressSliderVal = parseInt(document.getElementById('stress-slider').value);
  const sleepSliderVal = parseFloat(document.getElementById('sleep-slider').value);
  
  const fatigueBase = Math.min(10, Math.max(0, 10 - (sleepSliderVal * 1.1) + (stressSliderVal * 0.4)));
  state.fatigueScore = Math.round(fatigueBase * 10); // e.g. 28%
  state.blinkFrequency = Math.round(14 + (fatigueBase * 1.8));

  document.getElementById('scan-results-box').classList.remove('hidden');
  document.getElementById('scan-fatigue-val').textContent = `${state.fatigueScore}%`;
  
  let rateLabel = 'Normal';
  if (state.blinkFrequency > 22) rateLabel = 'High (Fatigued)';
  else if (state.blinkFrequency < 10) rateLabel = 'Low (Staring)';
  document.getElementById('scan-blink-val').textContent = `${state.blinkFrequency} bpm (${rateLabel})`;
}

function stopWebcam() {
  if (state.webcamStream) {
    state.webcamStream.getTracks().forEach(track => track.stop());
    state.webcamStream = null;
  }

  const video = document.getElementById('camera-stream');
  const snapPreview = document.getElementById('snapshot-preview');
  
  video.style.display = 'none';
  video.classList.add('hidden');
  snapPreview.style.display = 'none';
  snapPreview.classList.add('hidden');

  document.getElementById('camera-start-btn').style.display = 'inline-flex';
  document.getElementById('camera-capture-btn').style.display = 'none';
  document.getElementById('camera-reset-btn').style.display = 'none';
  document.getElementById('camera-stop-btn').style.display = 'none';
  document.getElementById('scanner-guide').classList.remove('scanner-active');
}

function resetWebcamScanner() {
  const video = document.getElementById('camera-stream');
  const snapPreview = document.getElementById('snapshot-preview');
  
  const captureBtn = document.getElementById('camera-capture-btn');
  const resetBtn = document.getElementById('camera-reset-btn');
  const stopBtn = document.getElementById('camera-stop-btn');

  video.style.display = 'block';
  video.classList.remove('hidden');
  
  snapPreview.style.display = 'none';
  snapPreview.classList.add('hidden');
  
  captureBtn.style.display = 'inline-flex';
  resetBtn.style.display = 'none';
  stopBtn.style.display = 'inline-flex';

  document.getElementById('scan-results-box').classList.add('hidden');
  document.getElementById('scanner-guide').classList.add('scanner-active');
  
  state.capturedSnapshot = null;
}

// --- ANALYSIS AGGREGATOR VIEW ---
function loadDashboard() {
  if (!state.token) return;

  const nudgeBanner = document.getElementById('dash-nudge-box');
  const welcomeText = document.getElementById('dash-welcome-text');
  
  welcomeText.innerHTML = `Welcome back, <span style="color: var(--accent-blue)">${state.user.email.split('@')[0]}</span>!`;

  fetch('/api/sessions/history', {
    headers: { 'Authorization': `Bearer ${state.token}` }
  })
  .then(res => res.json())
  .then(sessions => {
    if (sessions.length > 0) {
      const latest = sessions[sessions.length - 1];
      
      // Update widgets on dashboard
      document.getElementById('dash-widget-hr').textContent = latest.heart_rate;
      
      // Calculate steps percentage (e.g. 4250/10000 = 42%)
      const stepsGoal = 10000;
      const pct = Math.min(100, Math.round((latest.steps / stepsGoal) * 100));
      document.getElementById('dash-widget-activity').textContent = `${pct}%`;
      document.getElementById('dash-widget-steps').textContent = `Steps: ${Number(latest.steps).toLocaleString()} / ${Number(stepsGoal).toLocaleString()}`;
      
      // Sleep
      const sleepHours = latest.sleep_hours;
      const hoursInt = Math.floor(sleepHours);
      const minsInt = Math.round((sleepHours - hoursInt) * 60);
      const sleepStr = minsInt > 0 ? `${hoursInt}h ${minsInt}m` : `${hoursInt}h`;
      document.getElementById('dash-widget-sleep').textContent = sleepStr;

      // Hydration
      const waterMl = latest.water_ml;
      const cupsCount = Math.round(waterMl / 250);
      document.getElementById('dash-widget-water').textContent = `${cupsCount}/8`;

      // Nudge Suggestion
      if (latest.nudge_text) {
        document.getElementById('dash-nudge-text').textContent = `"${latest.nudge_text}"`;
        nudgeBanner.style.borderLeftColor = 'var(--sidebar-active)';
      }
    }
    // Render dashboard charts with database sessions
    renderDashboardCharts(sessions);
  })
  .catch(err => {
    console.error('Error loading dashboard stats:', err);
    renderDashboardCharts([]);
  });
}

function renderDashboardCharts(sessions = []) {
  // Extract real telemetry from sessions history
  let heartRateData = [65, 68, 70, 72, 71, 69, 72, 75, 73, 72, 71, 70];
  let heartRateLabels = ['12:00', '1:00', '2:00', '3:00', '4:00', '5:00', '6:00', '7:00', '8:00', '9:00', '10:00', '11:00'];
  let activityData = [2500, 4250, 3800, 5200, 4100, 3500, 2900];
  let activityLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let sleepData = [7, 6.5, 8, 7.5, 7, 6, 8.5];
  let sleepLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  
  let weeklyData = [85, 65, 75, 70, 80, 72];

  if (sessions.length > 0) {
    // Map last 12 sessions for heart rate trends
    const last12 = sessions.slice(-12);
    heartRateData = last12.map(s => s.heart_rate);
    heartRateLabels = last12.map(s => {
      const d = new Date(s.created_at);
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    });

    // Map last 7 sessions for activity & sleep
    const last7 = sessions.slice(-7);
    activityData = last7.map(s => s.steps || 0);
    activityLabels = last7.map((s, idx) => `S-${idx + 1}`);
    
    sleepData = last7.map(s => s.sleep_hours);
    sleepLabels = last7.map((s, idx) => `S-${idx + 1}`);

    // Calculate weekly health score metrics
    const avgHr = sessions.reduce((sum, s) => sum + s.heart_rate, 0) / sessions.length;
    const cardioScore = Math.max(10, Math.min(100, Math.round(100 - Math.abs(avgHr - 70) * 1.5)));

    const avgSteps = sessions.reduce((sum, s) => sum + (s.steps || 0), 0) / sessions.length;
    const stepsScore = Math.max(10, Math.min(100, Math.round((avgSteps / 10000) * 100)));

    const avgSleep = sessions.reduce((sum, s) => sum + s.sleep_hours, 0) / sessions.length;
    const sleepScore = Math.max(10, Math.min(100, Math.round((avgSleep / 8) * 100)));

    const avgWater = sessions.reduce((sum, s) => sum + s.water_ml, 0) / sessions.length;
    const hydrationScore = Math.max(10, Math.min(100, Math.round((avgWater / 2000) * 100)));

    const avgStress = sessions.reduce((sum, s) => sum + s.stress_level, 0) / sessions.length;
    const stressScore = Math.max(10, Math.min(100, Math.round(100 - (avgStress * 9))));

    const avgFatigue = sessions.reduce((sum, s) => sum + s.fatigue_score, 0) / sessions.length;
    const recoveryScore = Math.round((sleepScore + stressScore + (100 - avgFatigue)) / 3);

    weeklyData = [cardioScore, stepsScore, sleepScore, hydrationScore, stressScore, recoveryScore];
  }
  
  const ctx1 = document.getElementById('dash-chart-heart-rate');
  if (ctx1 && !window.dashCharts) window.dashCharts = {};
  if (ctx1) {
    if (window.dashCharts.heartRate) window.dashCharts.heartRate.destroy();
    window.dashCharts.heartRate = new Chart(ctx1, {
      type: 'line',
      data: {
        labels: heartRateLabels,
        datasets: [{
          label: 'Heart Rate (bpm)',
          data: heartRateData,
          borderColor: '#f43f5e',
          backgroundColor: 'rgba(244, 63, 94, 0.1)',
          tension: 0.4,
          fill: true,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { display: false },
          filler: { propagate: true }
        },
        scales: {
          y: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: '#94a3b8' }
          },
          x: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: '#94a3b8' }
          }
        }
      }
    });
  }

  const ctx2 = document.getElementById('dash-chart-activity');
  if (ctx2 && !window.dashCharts) window.dashCharts = {};
  if (ctx2) {
    if (window.dashCharts.activity) window.dashCharts.activity.destroy();
    window.dashCharts.activity = new Chart(ctx2, {
      type: 'bar',
      data: {
        labels: activityLabels,
        datasets: [{
          label: 'Steps',
          data: activityData,
          backgroundColor: '#06b6d4',
          borderRadius: 6,
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: '#94a3b8' }
          },
          x: {
            grid: { display: false },
            ticks: { color: '#94a3b8' }
          }
        }
      }
    });
  }

  const ctx3 = document.getElementById('dash-chart-sleep');
  if (ctx3 && !window.dashCharts) window.dashCharts = {};
  if (ctx3) {
    if (window.dashCharts.sleep) window.dashCharts.sleep.destroy();
    window.dashCharts.sleep = new Chart(ctx3, {
      type: 'line',
      data: {
        labels: sleepLabels,
        datasets: [{
          label: 'Sleep Hours',
          data: sleepData,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          tension: 0.4,
          fill: true,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: '#94a3b8' }
          },
          x: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: '#94a3b8' }
          }
        }
      }
    });
  }

  const ctx4 = document.getElementById('dash-chart-weekly');
  if (ctx4 && !window.dashCharts) window.dashCharts = {};
  if (ctx4) {
    if (window.dashCharts.weekly) window.dashCharts.weekly.destroy();
    window.dashCharts.weekly = new Chart(ctx4, {
      type: 'radar',
      data: {
        labels: ['Cardio', 'Steps', 'Sleep', 'Hydration', 'Stress', 'Recovery'],
        datasets: [{
          label: 'Weekly Score',
          data: weeklyData,
          borderColor: '#4f46e5',
          backgroundColor: 'rgba(79, 70, 229, 0.2)',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          r: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: '#94a3b8' }
          }
        }
      }
    });
  }
}

async function submitSessionAnalysis() {
  if (!state.token) return;

  const hrValue = state.heartRate || 72; // default simulated hr if disconnected
  const sleepVal = parseFloat(document.getElementById('sleep-slider').value);
  const waterCups = parseInt(document.getElementById('water-cups-slider').value);
  const waterVal = waterCups * 250; // convert cups to ml (250ml per cup)
  const stressVal = parseInt(document.getElementById('stress-slider').value);
  const stepsVal = state.heartRate ? parseInt(document.getElementById('steps-slider').value) : null;
  const activeVal = parseInt(document.getElementById('active-slider').value);

  const errorEl = document.getElementById('analysis-error');
  errorEl.classList.add('hidden');

  // Steps data must come from smartwatch (state.heartRate indicates smartwatch connection)
  if (!state.heartRate) {
    errorEl.textContent = 'Steps data must be entered from smartwatch. Please connect your smartwatch first.';
    errorEl.classList.remove('hidden');
    return;
  }

  const payload = {
    heartRate: hrValue,
    sleepHours: sleepVal,
    waterMl: waterVal,
    stressLevel: stressVal,
    fatigueBlinkRate: state.blinkFrequency || 16,
    fatigueScore: state.fatigueScore || 28,
    faceSnapshotUrl: state.capturedSnapshot || '',
    steps: stepsVal,
    activeMinutes: activeVal
  };

  try {
    const res = await fetch('/api/sessions/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify(payload)
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submission failed');

    state.latestReport = {
      nudge: data.nudge,
      assessment: data.assessment,
      insights: data.insights,
      hobbyTargeted: data.hobbyTargeted,
      anomalies: data.anomalies
    };

    navigateTo('report');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

// --- REPORTS VIEW (CHART RENDERS & PDF ACTIONS) ---
async function loadReportPage() {
  if (!state.token) return;

  const nudgeTextEl = document.getElementById('report-nudge-text');
  const nudgeTagEl = document.getElementById('report-nudge-tag');
  const assessTextEl = document.getElementById('report-assess-text');
  const insightsContainer = document.getElementById('report-insights-container');

  // Load history to build graphs & weekly summary list
  try {
    const res = await fetch('/api/sessions/history', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const history = await res.json();

    if (history.length > 0) {
      const latest = history[history.length - 1];
      
      // If we don't have latestReport in memory (e.g. reload or just logged in), load from latest DB row
      if (!state.latestReport && latest.nudge_text) {
        let parsedAssess = latest.assessment_text || '';
        let parsedInsights = null;
        if (parsedAssess.startsWith('{')) {
          try {
            const parsedObj = JSON.parse(parsedAssess);
            parsedAssess = parsedObj.assessment;
            parsedInsights = parsedObj.insights;
          } catch (e) {
            console.error('Failed to parse assessment JSON:', e);
          }
        }
        state.latestReport = {
          nudge: latest.nudge_text,
          hobbyTargeted: latest.hobby_targeted,
          assessment: parsedAssess,
          insights: parsedInsights
        };
      }

      renderCharts(history);
      calculateWeeklySummary(history);
    }

    if (state.latestReport) {
      nudgeTextEl.textContent = `"${state.latestReport.nudge}"`;
      nudgeTagEl.textContent = `AI Insights: ${state.latestReport.hobbyTargeted}`;
      assessTextEl.innerHTML = `AI Analysis: ${state.latestReport.assessment}`;

      if (state.latestReport.insights) {
        insightsContainer.classList.remove('hidden');
        document.getElementById('insight-sleep-val').textContent = state.latestReport.insights.sleep || '--';
        document.getElementById('insight-hydration-val').textContent = state.latestReport.insights.hydration || '--';
        document.getElementById('insight-stress-val').textContent = state.latestReport.insights.stress || '--';
        document.getElementById('insight-heartrate-val').textContent = state.latestReport.insights.heartRate || '--';
        document.getElementById('insight-fatigue-val').textContent = state.latestReport.insights.fatigue || '--';
      } else {
        insightsContainer.classList.add('hidden');
      }
    } else {
      nudgeTextEl.textContent = "No analysis submitted yet. Ingest your biometrics to synchronize.";
      assessTextEl.textContent = "Navigate to the Analysis tab to run your daily session analysis and receive AI-powered insights.";
      insightsContainer.classList.add('hidden');
    }

  } catch (err) {
    console.error('Error rendering report logs:', err);
  }
}

function calculateWeeklySummary(history) {
  // Calculate average heart rate
  const avgHr = Math.round(history.reduce((sum, s) => sum + s.heart_rate, 0) / history.length);
  document.getElementById('sum-avg-hr').textContent = `${avgHr} bpm`;

  // Total active minutes
  const totalActive = history.reduce((sum, s) => sum + (s.active_minutes || 0), 0);
  document.getElementById('sum-total-active').textContent = `${totalActive} mins`;

  // Average sleep
  const avgSleep = (history.reduce((sum, s) => sum + s.sleep_hours, 0) / history.length).toFixed(1);
  document.getElementById('sum-avg-sleep').textContent = `${avgSleep} hrs`;

  // Average hydration (in cups)
  const avgWaterMl = history.reduce((sum, s) => sum + s.water_ml, 0) / history.length;
  const avgCups = (avgWaterMl / 250).toFixed(1);
  document.getElementById('sum-avg-water').textContent = `${avgCups} cups`;

  // Anomalies count
  const anomalyRes = history.filter(s => s.heart_rate > 100 || s.stress_level > 7);
  const countBadge = document.getElementById('sum-anomalies-count');
  countBadge.textContent = `${anomalyRes.length} Alerts`;
  if (anomalyRes.length > 0) {
    countBadge.className = 'badge badge-pink';
  } else {
    countBadge.className = 'badge badge-green';
  }
}

function renderCharts(history) {
  const ChartClass = window.Chart;
  if (!ChartClass) return;

  const labels = history.map((s, idx) => `Session ${idx + 1}`);
  const heartRates = history.map(s => s.heart_rate);
  const stepsData = history.map(s => s.steps);
  const sleepHours = history.map(s => s.sleep_hours);
  const stressLevels = history.map(s => s.stress_level);

  // 1. Heart Rate Trends Line Chart
  if (state.charts.trends) state.charts.trends.destroy();
  const trendsCtx = document.getElementById('chart-trends').getContext('2d');
  state.charts.trends = new ChartClass(trendsCtx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Heart Rate (bpm)',
        data: heartRates,
        borderColor: '#f43f5e',
        backgroundColor: 'rgba(244, 63, 94, 0.05)',
        tension: 0.35,
        fill: true,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false } },
        y: { min: 40, max: 140 }
      }
    }
  });

  // 2. Activity Level Bar Chart
  if (state.charts.activity) state.charts.activity.destroy();
  const activityCtx = document.getElementById('chart-activity').getContext('2d');
  state.charts.activity = new ChartClass(activityCtx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Steps Taken',
        data: stepsData,
        backgroundColor: '#4f46e5',
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false } },
        y: { max: 15000 }
      }
    }
  });

  // 3. Sleep Patterns Combo Chart
  if (state.charts.sleep) state.charts.sleep.destroy();
  const sleepCtx = document.getElementById('chart-sleep-patterns').getContext('2d');
  state.charts.sleep = new ChartClass(sleepCtx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Sleep Hours',
          data: sleepHours,
          borderColor: '#10b981',
          tension: 0.3,
          borderWidth: 2,
          fill: false
        },
        {
          label: 'Stress Index',
          data: stressLevels,
          borderColor: '#f59e0b',
          tension: 0.3,
          borderWidth: 2,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false } }
      }
    }
  });
}

// --- PDF COMPILER GENERATOR (using jsPDF CDN) ---
async function downloadReportPDF() {
  const { jsPDF } = window.jspdf;
  if (!jsPDF) {
    alert("jsPDF library failed to load from CDN.");
    return;
  }

  const doc = new jsPDF();
  
  // Title
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(79, 70, 229); // indigo
  doc.text("BioSync Context Engine", 20, 25);
  
  doc.setFontSize(11);
  doc.setFont("Helvetica", "normal");
  doc.setTextColor(100, 116, 139);
  doc.text("Autonomic Recovery & Biometric Analysis Report", 20, 32);
  
  doc.setLineWidth(0.5);
  doc.setDrawColor(226, 232, 240);
  doc.line(20, 36, 190, 36);

  // Profile
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text("User Profile Context", 20, 47);

  doc.setFont("Helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(51, 65, 85);
  doc.text(`Email: ${state.user.email}`, 20, 55);
  doc.text(`Core Wellness Goals: ${state.user.wellnessGoals.join(', ')}`, 20, 61);
  doc.text(`Favorite Hobbies: ${state.user.hobbies.join(', ')}`, 20, 67);

  // Latest Session Biometrics
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text("Daily Biometrics Telemetry", 20, 81);

  const sleepHours = document.getElementById('sleep-slider').value;
  const stressIndex = document.getElementById('stress-slider').value;
  const stepsLogged = document.getElementById('steps-slider').value;
  const activeMins = document.getElementById('active-slider').value;
  const waterCups = document.getElementById('water-cups-slider').value;

  doc.setFont("Helvetica", "normal");
  doc.setFontSize(10);
  doc.text(`Synchronized Heart Rate: ${state.heartRate || 72} BPM`, 20, 89);
  doc.text(`Steps Walked: ${Number(stepsLogged).toLocaleString()} / 10,000`, 20, 95);
  doc.text(`Active minutes: ${activeMins} minutes`, 20, 101);
  doc.text(`Sleep duration: ${sleepHours} hours`, 20, 107);
  doc.text(`Hydration logged: ${waterCups}/8 cups`, 20, 113);
  doc.text(`Subjective stress: ${stressIndex}/10`, 20, 119);
  doc.text(`Webcam Fatigue Score: ${state.fatigueScore}%`, 20, 125);
  doc.text(`Webcam Blink Frequency: ${state.blinkFrequency} blinks/min`, 20, 131);

  // AI Outline Nudges
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text("AI Nudge Feed & Physiology Assessment", 20, 145);

  doc.setFont("Helvetica", "normal");
  doc.setFontSize(10);
  
  const nudge = state.latestReport ? state.latestReport.nudge : "No suggested active recovery. Please submit biometrics.";
  const assess = state.latestReport ? state.latestReport.assessment : "Sync smartwatch and run a facial scanner scan to generate an autonomic recovery outline.";

  const nudgeLines = doc.splitTextToSize(`Suggestion: "${nudge}"`, 170);
  doc.text(nudgeLines, 20, 153);

  const assessLines = doc.splitTextToSize(`Physiological Outline: ${assess}`, 170);
  doc.text(assessLines, 20, 167);

  // Embed face image
  if (state.capturedSnapshot) {
    try {
      doc.addImage(state.capturedSnapshot, 'JPEG', 20, 195, 52, 39);
      doc.setFontSize(9);
      doc.setTextColor(148, 163, 184);
      doc.text("Biometric Webcam Frame Snapshot", 20, 238);
    } catch (e) {
      console.warn("Failed to embed image in PDF:", e.message);
    }
  }

  // Footer
  doc.setLineWidth(0.5);
  doc.setDrawColor(226, 232, 240);
  doc.line(20, 275, 190, 275);
  
  doc.setFontSize(9);
  doc.setTextColor(148, 163, 184);
  doc.text(`Compiled on ${new Date().toLocaleString()} | BioSync Context Engine`, 20, 282);

  doc.save(`BioSync-Recovery-Report-${Date.now()}.pdf`);
}

// --- PDF SHARE MODAL ---
function shareReportPDF() {
  const urlInput = document.getElementById('share-report-url');
  
  const reportUrl = `${window.location.protocol}//${window.location.host}/#report`;
  urlInput.value = reportUrl;
  
  document.getElementById('share-status-message').classList.add('hidden');
  
  // Automatically trigger native share if available
  if (navigator.share) {
    triggerNativeShare();
  } else {
    // Fall back to modal with copy option
    const modal = document.getElementById('share-modal-overlay');
    modal.classList.add('show');
  }
}

function copyShareLinkToClipboard() {
  const urlInput = document.getElementById('share-report-url');
  urlInput.select();
  urlInput.setSelectionRange(0, 99999); // for mobile devices
  
  navigator.clipboard.writeText(urlInput.value)
    .then(() => {
      const msg = document.getElementById('share-status-message');
      msg.textContent = "Link copied to clipboard!";
      msg.classList.remove('hidden');
    })
    .catch(err => {
      console.error('Copy to clipboard failed:', err);
    });
}

function triggerNativeShare() {
  const urlInput = document.getElementById('share-report-url');
  const reportUrl = `${window.location.protocol}//${window.location.host}/#report`;
  
  if (navigator.share) {
    navigator.share({
      title: 'BioSync Health Recovery Report',
      text: 'Here is my autonomic recovery analysis from BioSync - generated from smartwatch data and AI insights.',
      url: reportUrl
    })
    .catch(err => {
      if (err.name !== 'AbortError') {
        console.warn('Native share failed:', err);
      }
    });
  } else {
    // Fallback: show modal with copy option
    urlInput.value = reportUrl;
    document.getElementById('share-status-message').classList.add('hidden');
    const modal = document.getElementById('share-modal-overlay');
    modal.classList.add('show');
  }
}

// --- ADMIN PORTAL ---
async function loadAdminDashboard() {
  if (!state.token) return;

  try {
    const resLogs = await fetch('/api/admin/anomalies', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const anomalies = await resLogs.json();
    renderAnomalyLogs(anomalies);

    const resSet = await fetch('/api/admin/settings', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const settings = await resSet.json();
    
    document.getElementById('admin-hr-threshold').value = settings.heart_rate_threshold || 100;
    document.getElementById('admin-stress-threshold').value = settings.stress_threshold || 7;
    document.getElementById('admin-ai-temp').value = settings.ai_temperature || 0.7;

  } catch (err) {
    console.error('Error loading admin configurations:', err);
  }
}

function renderAnomalyLogs(anomalies) {
  const listEl = document.getElementById('anomaly-logs-list');
  listEl.innerHTML = '';

  if (anomalies.length === 0) {
    listEl.innerHTML = '<div class="glass-panel text-center">No anomalies logged in the system.</div>';
    return;
  }

  anomalies.forEach(a => {
    const item = document.createElement('div');
    const isCritical = a.severity === 'critical';
    item.className = isCritical ? 'anomaly-item critical' : 'anomaly-item';
    
    const metricLabel = a.metric === 'heart_rate' ? 'Heart Rate Limit Breached' : 'Stress Limit Breached';
    const unit = a.metric === 'heart_rate' ? 'BPM' : '/10';
    const dateStr = new Date(a.created_at).toLocaleString();

    item.innerHTML = `
      <div class="anomaly-meta">
        <span class="anomaly-title">
          ${isCritical ? '⚠️ ' : ''}${metricLabel}
        </span>
        <span class="anomaly-user">User: ${a.email} (${a.severity})</span>
        <span class="anomaly-date">${dateStr}</span>
      </div>
      <div class="anomaly-value-badge">
        ${a.value}${unit}
      </div>
    `;
    listEl.appendChild(item);
  });
}

async function submitAdminSettings(e) {
  e.preventDefault();
  const hrThreshold = parseInt(document.getElementById('admin-hr-threshold').value);
  const stressThreshold = parseInt(document.getElementById('admin-stress-threshold').value);
  const aiTemp = parseFloat(document.getElementById('admin-ai-temp').value);
  const statusEl = document.getElementById('admin-settings-status');

  statusEl.textContent = '';

  try {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({
        heart_rate_threshold: hrThreshold,
        stress_threshold: stressThreshold,
        ai_temperature: aiTemp
      })
    });
    
    if (!res.ok) throw new Error('Failed to update settings');
    
    statusEl.textContent = 'Settings saved successfully!';
    statusEl.style.color = 'var(--accent-green)';
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.style.color = 'var(--accent-pink)';
  }
}

// --- ONBOARDING WIZARD ---
let wizardCurrentStep = 1;

function initOnboardingWizard() {
  wizardCurrentStep = 1;
  updateWizardUI();
  
  // Clear any previous selections
  document.querySelectorAll('.wizard-question .selection-card').forEach(card => {
    card.classList.remove('selected');
  });
  const form = document.getElementById('signup-form');
  if (form) form.reset();
  const errorEl = document.getElementById('signup-error');
  if (errorEl) errorEl.classList.add('hidden');
}

function updateWizardUI() {
  document.querySelectorAll('.wizard-step').forEach(step => step.classList.add('hidden'));
  const activeStep = document.getElementById(`wizard-step-${wizardCurrentStep}`);
  if (activeStep) activeStep.classList.remove('hidden');

  // Update progress bar
  const bar = document.getElementById('signup-progress-bar');
  if (bar) {
    const pct = (wizardCurrentStep / 3) * 100;
    bar.style.width = `${pct}%`;
  }
  
  const stepIndicator = document.getElementById('current-step-num');
  if (stepIndicator) stepIndicator.textContent = wizardCurrentStep;

  // Show/Hide buttons
  const prevBtn = document.getElementById('signup-prev-btn');
  const nextBtn = document.getElementById('signup-next-btn');
  const submitBtn = document.getElementById('signup-submit-btn');

  if (wizardCurrentStep === 1) {
    if (prevBtn) prevBtn.classList.add('hidden');
    if (nextBtn) nextBtn.classList.remove('hidden');
    if (submitBtn) submitBtn.classList.add('hidden');
  } else if (wizardCurrentStep === 2) {
    if (prevBtn) prevBtn.classList.remove('hidden');
    if (nextBtn) nextBtn.classList.remove('hidden');
    if (submitBtn) submitBtn.classList.add('hidden');
  } else if (wizardCurrentStep === 3) {
    if (prevBtn) prevBtn.classList.remove('hidden');
    if (nextBtn) nextBtn.classList.add('hidden');
    if (submitBtn) submitBtn.classList.remove('hidden');
  }

  // Re-apply language translations to the wizard UI
  applyLanguage(state.lang || 'en');
}

function validateWizardStep(step) {
  const errorEl = document.getElementById('signup-error');
  if (errorEl) errorEl.classList.add('hidden');

  if (step === 1) {
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;
    if (!email || !password) {
      if (errorEl) {
        errorEl.textContent = 'Please enter both email and password.';
        errorEl.classList.remove('hidden');
      }
      return false;
    }
    if (!email.includes('@')) {
      if (errorEl) {
        errorEl.textContent = 'Please enter a valid email address.';
        errorEl.classList.remove('hidden');
      }
      return false;
    }
    return true;
  } else if (step === 2) {
    // Check Q1 to Q5
    for (let i = 1; i <= 5; i++) {
      const question = document.querySelector(`.wizard-question[data-qid="q${i}"]`);
      const selected = question.querySelectorAll('.selection-card.selected');
      if (selected.length === 0) {
        if (errorEl) {
          errorEl.textContent = `Please answer question ${i} before proceeding.`;
          errorEl.classList.remove('hidden');
        }
        return false;
      }
    }
    return true;
  }
  return true;
}

function bindWizardEvents() {
  document.querySelectorAll('.wizard-question').forEach(question => {
    const type = question.dataset.type;
    const max = parseInt(question.dataset.max || '1');
    
    question.querySelectorAll('.selection-card').forEach(card => {
      card.addEventListener('click', () => {
        if (type === 'single') {
          question.querySelectorAll('.selection-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
        } else {
          // Multi-select
          if (card.classList.contains('selected')) {
            card.classList.remove('selected');
          } else {
            const selectedCount = question.querySelectorAll('.selection-card.selected').length;
            if (selectedCount < max) {
              card.classList.add('selected');
            } else {
              if (max === 2) {
                const firstSelected = question.querySelector('.selection-card.selected');
                if (firstSelected) firstSelected.classList.remove('selected');
                card.classList.add('selected');
              }
            }
          }
        }
      });
    });
  });

  const prevBtn = document.getElementById('signup-prev-btn');
  const nextBtn = document.getElementById('signup-next-btn');
  
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (wizardCurrentStep > 1) {
        wizardCurrentStep--;
        updateWizardUI();
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (validateWizardStep(wizardCurrentStep)) {
        wizardCurrentStep++;
        updateWizardUI();
      }
    });
  }
}

// --- TELEGRAM PIN LINKING ---
let telegramPollInterval = null;

async function generateTelegramPin() {
  if (!state.token) return;
  try {
    const res = await fetch('/api/telegram/generate-pin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to generate PIN');

    document.getElementById('telegram-pin-display').textContent = data.pin;
    
    // Set bot link
    const pinRaw = data.pin.replace('-', '');
    document.getElementById('telegram-bot-link').href = `https://t.me/${data.botUsername}?start=${pinRaw}`;

    document.getElementById('telegram-disconnected-ui').classList.add('hidden');
    document.getElementById('telegram-pin-ui').classList.remove('hidden');
    document.getElementById('telegram-connected-ui').classList.add('hidden');

    // Start status polling
    startTelegramStatusPolling();
  } catch (err) {
    console.error('Error generating Telegram PIN:', err.message);
  }
}

function cancelTelegramPinGeneration() {
  stopTelegramStatusPolling();
  document.getElementById('telegram-disconnected-ui').classList.remove('hidden');
  document.getElementById('telegram-pin-ui').classList.add('hidden');
  document.getElementById('telegram-connected-ui').classList.add('hidden');
}

async function fetchTelegramLinkingStatus() {
  if (!state.token) return;
  try {
    const res = await fetch('/api/telegram/status', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to get Telegram status');

    if (data.connected) {
      stopTelegramStatusPolling();
      document.getElementById('telegram-disconnected-ui').classList.add('hidden');
      document.getElementById('telegram-pin-ui').classList.add('hidden');
      document.getElementById('telegram-connected-ui').classList.remove('hidden');
    } else {
      if (data.pin) {
        document.getElementById('telegram-pin-display').textContent = data.pin;
        const pinRaw = data.pin.replace('-', '');
        document.getElementById('telegram-bot-link').href = `https://t.me/${data.botUsername}?start=${pinRaw}`;
        
        document.getElementById('telegram-disconnected-ui').classList.add('hidden');
        document.getElementById('telegram-pin-ui').classList.remove('hidden');
        document.getElementById('telegram-connected-ui').classList.add('hidden');
        
        startTelegramStatusPolling();
      } else {
        stopTelegramStatusPolling();
        document.getElementById('telegram-disconnected-ui').classList.remove('hidden');
        document.getElementById('telegram-pin-ui').classList.add('hidden');
        document.getElementById('telegram-connected-ui').classList.add('hidden');
      }
    }
  } catch (err) {
    console.error('Error checking Telegram status:', err.message);
  }
}

function startTelegramStatusPolling() {
  if (telegramPollInterval) clearInterval(telegramPollInterval);
  telegramPollInterval = setInterval(async () => {
    if (!state.token || state.activeView !== 'profile') {
      stopTelegramStatusPolling();
      return;
    }
    try {
      const res = await fetch('/api/telegram/status', {
        headers: { 'Authorization': `Bearer ${state.token}` }
      });
      const data = await res.json();
      if (data.connected) {
        stopTelegramStatusPolling();
        document.getElementById('telegram-disconnected-ui').classList.add('hidden');
        document.getElementById('telegram-pin-ui').classList.add('hidden');
        document.getElementById('telegram-connected-ui').classList.remove('hidden');
        
        // Show update message
        const statusEl = document.getElementById('profile-status-message');
        if (statusEl) {
          statusEl.textContent = 'Telegram account connected successfully!';
          statusEl.className = 'badge badge-green mb-1';
          statusEl.classList.remove('hidden');
          setTimeout(() => statusEl.classList.add('hidden'), 5000);
        }
      }
    } catch (e) {
      console.warn('Telegram status check poll error:', e.message);
    }
  }, 3000);
}

function stopTelegramStatusPolling() {
  if (telegramPollInterval) {
    clearInterval(telegramPollInterval);
    telegramPollInterval = null;
  }
}

// --- AMHARIC TRANSLATION SYSTEM ---
const translations = {
  am: {
    // Sidebar nav
    "Dashboard": "ዳሽቦርድ",
    "Connection": "ግንኙነት",
    "Webcam Scanner": "የፊት ስካነር",
    "Analysis": "ትንተና",
    "Reports": "ሪፖርቶች",
    "Admin": "አድሚን",
    "Account Settings": "የመለያ ቅንብሮች",
    "Sign Out": "ውጣ",

    // Dashboard View
    "Welcome back, User!": "እንኳን ደህና መጡ!",
    "Here's your health overview for today": "የዛሬው የጤናዎ አጠቃላይ እይታ",
    "Heart Rate": "የልብ ምት",
    "Activity Level": "የእንቅስቃሴ ደረጃ",
    "Sleep Quality": "የእንቅልፍ ጥራት",
    "Hydration": "የውሃ መጠን",
    "bpm - Last 5 min avg": "ምት በደቂቃ - የ5 ደቂቃ አማካኝ",
    "Last night average": "የሌሊት አማካኝ",
    "cups - Daily water intake": "ኩባያዎች - ዕለታዊ የውሃ ፍጆታ",
    "Heart Rate Trends": "የልብ ምት አዝማሚያዎች",
    "Activity Breakdown": "የእንቅስቃሴ ዝርዝር",
    "Sleep Patterns (7 days)": "የእንቅልፍ ሁኔታዎች (7 ቀናት)",
    "Weekly Summary": "ሳምንታዊ ማጠቃለያ",
    "Latest Smart Suggestion": "የቅርብ ጊዜ አስተያየት",
    "Sync telemetry & run analysis": "ቴሌሜትሪ ያመሳስሉ እና ትንተና ያሂዱ",
    "Connection Status": "የግንኙነት ሁኔታ",

    // Connection View
    "Smartwatch Connection": "የስማርት ሰዓት ግንኙነት",
    "Pair your smartwatch to receive real-time biometric data": "የቀጥታ ባዮሜትሪክ መረጃን ለማግኘት ስማርት ሰዓትዎን ያገናኙ",
    "Not Connected": "አልተገናኘም",
    "Connected": "ተገናኝቷል",
    "Connect Smartwatch": "ስማርት ሰዓት አገናኝ",
    "Launch Simulator": "ሲሙሌተር አስጀምር",
    "Disconnect Smartwatch": "ስማርት ሰዓት አቋርጥ",
    "Device Name: BioSync Virtual Band X-1 | Telemetry Simulation Active": "የመሣሪያ ስም: ባዮሲንክ ምናባዊ ባንድ X-1 | የቴሌሜትሪ ማስመሰል ገባሪ ነው",

    // Webcam Scanner View
    "Facial Analysis Scanner": "የፊት ትንተና ስካነር",
    "Position your face in the circle and capture for fatigue analysis": "ፊትዎን በክበቡ ውስጥ ያድርጉ እና ለድካም ትንተና ፎቶ ያንሱ",
    "Camera Setup": "የካሜራ ማዋቀር",
    "Start Camera": "ካሜራ አስጀምር",
    "Capture Fatigue": "ድካምን መዝግብ",
    "Reset Camera": "ካሜራን ዳግም አስጀምር",
    "Analysis Results": "የትንተና ውጤቶች",
    "Fatigue Level": "የድካም ደረጃ",
    "Blink Rate": "የዐይን ብልጭታ መጠን",

    // Ingestion Portal View
    "Ingestion Portal": "የመረጃ ማስገቢያ ፖርታል",
    "Aggregate smartwatch data, webcam scans, and daily metrics to submit to the AI Engine": "የስማርት ሰዓት መረጃዎችን፣ የካሜራ ቅኝቶችን እና ዕለታዊ መለኪያዎችን ለአይ ሞተር ያስገቡ",
    "Smartwatch Data": "የስማርት ሰዓት መረጃ",
    "Facial Scan": "የፊት ቅኝት",
    "Manual Input": "በእጅ የሚገባ መረጃ",
    "Daily Metrics": "ዕለታዊ መለኪያዎች",
    "Hours Slept": "የተኙበት ሰዓት",
    "Stress Level": "የጭንቀት ደረጃ",
    "Steps Count": "የእርምጃዎች ብዛት",
    "Active Minutes": "ንቁ ደቂቃዎች",
    "Hydration (Cups)": "የውሃ መጠጣት (ኩባያዎች)",
    "Submit & Aggregates Analysis": "ትንተናውን አስገብተው ያሂዱ",

    // Reports View
    "Autonomic nervous system recovery logs and trends": "የነርቭ ሥርዓት ማገገሚያ ምዝግብ ማስታወሻዎች እና አዝማሚያዎች",
    "Back to Dashboard": "ወደ ዳሽቦርድ ይመለሱ",
    "Share Report": "ሪፖርት ያጋሩ",
    "Download PDF": "PDF ያውርዱ",
    "Suggested AI Activity": "የተጠቆመ የአይ ተግባር",
    "Sleep Patterns": "የእንቅልፍ ሁኔታዎች",
    "Average Heart Rate:": "አማካኝ የልብ ምት:",
    "Total Active Minutes:": "አጠቃላይ ንቁ ደቂቃዎች:",
    "Average Sleep:": "አማካኝ እንቅልፍ:",
    "Average Hydration:": "አማካኝ የውሃ መጠጣት:",
    "Anomaly Triggers:": "ያልተለመዱ ክስተቶች:",
    "Granular Recovery Recommendations": "ዝርዝር የማገገሚያ ምክሮች",

    // Profile Settings View
    "Profile Settings": "የመለያ ቅንብሮች",
    "Change Password (Leave blank to keep current)": "የይለፍ ቃል ቀይር (ላለመቀየር ባዶ ይተውት)",
    "Save Profile Changes": "ለውጦችን አስቀምጥ",
    "Telegram Integration": "የቴሌግራም ውህደት",
    "Connect to Telegram": "ከቴሌግራም ጋር አገናኝ",
    "Open @biosync_robot": "ቴሌግራም ክፈት @biosync_robot",
    "Cancel": "ሰርዝ",
    "Your temporary 6-digit authentication PIN:": "የእርስዎ ጊዜያዊ 6 አሃዝ መለያ ፒን (PIN):",
    "1. Open Telegram and search for @biosync_robot (or click the link below)": "1. ቴሌግራምን ይክፈቱ እና @biosync_robot ብለው ይፈልጉ (ወይም ከታች ያለውን ሊንክ ይጫኑ)",
    "2. Hit /start": "2. /start የሚለውን ይጫኑ",
    "3. Send the PIN code shown above": "3. ከላይ የሚታየውን የፒን ኮድ ይላኩ",
    "Receive daily recovery cards right inside your Telegram chat.": "ዕለታዊ ማገገሚያ ካርዶችን በቀጥታ በቴሌግራም ቻትዎ ውስጥ ይቀበሉ።",

    // Landing View
    "Health is not a checklist —": "ጤና የዝርዝር ማረጋገጫ አይደለም —",
    "it's a rhythm.": "ምት ነው!",
    "BioSync listens to your body, learns who you are, and intelligently suggests the one thing you need right now to feel better.": "ባዮሲንክ የሰውነትዎን ምልክቶች ያዳምጣል፣ ማንነትዎን ይማራል፣ እና አሁን የተሻለ ስሜት እንዲሰማዎት የሚያስፈልገውን አንድ ነገር በጥበብ ይጠቁማል።",
    "Join BioSync Today": " his ዛሬውኑ ባዮሲንክን ይቀላቀሉ",
    "Learn More": "የበለጠ ይረዱ",
    "Our Vision": "ራዕያችን",
    "What Biosync Actually Does": "ባዮሲንክ በትክክል ምን ይሰራል?",
    "Our Evolving Plan": "እየተሻሻለ የመጣው ዕቅዳችን",
    "Sign In": "ግባ",
    "Get Started": "ጀምር",
    "Welcome to Biosync": "እንኳን ወደ ባዮሲንክ በደህና መጡ",
    "Beyond Tracking: True Personal Understanding": "ከክትትል ባሻገር: እውነተኛ የግል ግንዛቤ",
    "Situationally Intelligent, Moment-Ready Guidance": "ወቅታዊ ብልህ እና ዝግጁ የሆኑ ምክሮች",
    "Every Goal, Your Terms": "ማንኛውም ግብ በእርስዎ ምርጫ",
    
    // Auth Forms
    "Sign in to sync your biometrics": "ባዮሜትሪክስዎን ለማመሳሰል ይግቡ",
    "Email Address": "የኢሜይል አድራሻ",
    "Password": "የይለፍ ቃል",
    "Create Account": "መለያ ፍጠር"
  }
};

function applyLanguage(lang) {
  const isAmharic = lang === 'am';
  document.documentElement.lang = lang;
  
  const dict = translations.am;
  if (!dict) return;

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue.trim();
      if (text) {
        for (const [enKey, amVal] of Object.entries(dict)) {
          if (isAmharic && text === enKey) {
            node.nodeValue = amVal;
            break;
          } else if (!isAmharic && text === amVal) {
            node.nodeValue = enKey;
            break;
          }
        }
      }
    } else {
      if (node.tagName !== 'SCRIPT' && node.tagName !== 'STYLE' && node.tagName !== 'INPUT' && node.tagName !== 'TEXTAREA') {
        node.childNodes.forEach(walk);
      }
    }
  };

  walk(document.body);
}

