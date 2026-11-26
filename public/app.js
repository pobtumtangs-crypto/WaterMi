const $ = (selector) => document.querySelector(selector);

let currentUser = null;

async function handleLogout() {
  try {
    await api('POST', '/api/auth/logout');
    window.location.replace('/');
  } catch (err) {
    toast('Logout failed: ' + friendly(err));
  }
}

const STATUS = {
  healthy: { label: 'Healthy', icon: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M8 12l3 3 5-6'] },
  needs_attention: { label: 'Needs attention', icon: ['M12 3L2 21h20L12 3z', 'M12 10v5M12 18v.5'] },
  critical: { label: 'Critical', icon: ['M8 2h8l6 6v8l-6 6H8l-6-6V8z', 'M9 9l6 6M15 9l-6 6'] },
};
const SEVERITY = { low: 'Low', medium: 'Medium', high: 'High' };
const LEAF = ['M5 19C4 10 10 4 20 4c0 10-6 16-15 15z', 'M5 19l9-9'];
const TRASH = ['M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'];
const STARTERS = [
  'Why are my leaves turning yellow?',
  'How often should I water?',
  'How do I treat powdery mildew?',
];
const QUOTA_MESSAGE = 'Daily free limit reached. Try again later.';

let plants = [];

// ---------- Setup state ----------
let setupPlants = [];
let setupSketch = '';
let setupPollTimer = null;
let setupViewActive = false;

// ---------- DOM helpers (text is always added as text nodes, never as HTML) ----------

function build(node, props, children) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
}
const el = (tag, props, ...children) => build(document.createElement(tag), props, children);
const svg = (tag, props, ...children) =>
  build(document.createElementNS('http://www.w3.org/2000/svg', tag), props, children);
const icon = (paths) =>
  svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, paths.map((d) => svg('path', { d })));

const statusOf = (status) => STATUS[status] ?? STATUS.needs_attention;
const badge = (status, score) =>
  el('span', { class: `badge ${status}` }, icon(statusOf(status).icon),
    score === undefined ? statusOf(status).label : `${score} · ${statusOf(status).label}`);

let toastTimer;
function toast(message) {
  const node = $('#toast');
  // An open modal dialog covers the page, so the toast has to live inside it.
  (document.querySelector('dialog[open]') ?? document.body).append(node);
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3500);
}

// ---------- API ----------

const apiError = (message, code) => Object.assign(new Error(message), { code });

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include', // Include session cookies
    });
  } catch {
    throw apiError('Cannot reach the WaterMI server. Check that it is running.', 'offline');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (data.code === 'authentication_required') window.location.replace('/');
    throw apiError(data.error || `Request failed (${res.status}).`, data.code);
  }
  return res;
}
const api = async (method, url, body) => (await request(method, url, body)).json();
const friendly = (err) => (err.code === 'quota' ? QUOTA_MESSAGE : err.message);

async function loadPlants() {
  plants = await api('GET', '/api/plants');
  renderPlants();
}

function replacePlant(updated) {
  const index = plants.findIndex((p) => p.id === updated.id);
  if (index === -1) plants.push(updated);
  else plants[index] = updated;
  renderPlants();
}

const findPlant = (id) => plants.find((p) => p.id === id);
const latestCheckup = (plant) => plant.checkups.at(-1);

// ---------- dates and watering ----------

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
// Rounding absorbs the 23 and 25 hour days around daylight saving changes.
const daysBetween = (from, to) => Math.round((startOfDay(to) - startOfDay(from)) / 86_400_000);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function daysUntilWater(plant) {
  const due = new Date(plant.lastWatered);
  due.setDate(due.getDate() + plant.waterEveryDays);
  return daysBetween(new Date(), due);
}

function waterLine(plant) {
  const days = daysUntilWater(plant);
  if (days < 0) return el('span', { class: 'overdue' }, `Overdue by ${plural(-days, 'day')}`);
  return el('span', {}, days === 0 ? 'Water today' : `Water in ${plural(days, 'day')}`);
}

function checkedLine(plant) {
  const last = latestCheckup(plant);
  if (!last) return 'Not checked yet';
  const days = daysBetween(new Date(last.date), new Date());
  return days <= 0 ? 'Checked today' : `Checked ${plural(days, 'day')} ago`;
}

const needsAttention = (plant) => {
  const last = latestCheckup(plant);
  return (last && last.status !== 'healthy') || daysUntilWater(plant) < 0;
};

// ---------- navigation ----------

function showView(name) {
  const view = ['dashboard', 'analyze', 'chat', 'setup'].includes(name) ? name : 'dashboard';
  const wasSetup = $('#view-setup')?.classList.contains('active') ?? false;
  for (const section of document.querySelectorAll('.view')) {
    section.classList.toggle('active', section.id === `view-${view}`);
  }
  for (const button of document.querySelectorAll('#tabs button')) {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  history.replaceState(null, '', `#${view}`);
  window.scrollTo(0, 0);
  if (view === 'chat') scrollChat();

  // Handle setup view polling
  if (view === 'setup' && !wasSetup) {
    startSetupPolling();
  } else if (wasSetup && view !== 'setup') {
    stopSetupPolling();
  }
}

function fillSelect(select, firstLabel) {
  const chosen = select.value;
  select.replaceChildren(
    el('option', { value: '' }, firstLabel),
    ...plants.map((p) => el('option', { value: p.id }, p.name)),
  );
  select.value = findPlant(chosen) ? chosen : '';
}

// ---------- dashboard ----------

function renderPlants() {
  renderStats();
  renderGrid();
  fillSelect($('#an-plant'), 'Not saved to a plant');
  fillSelect($('#chat-plant'), 'General question');
}

function renderStats() {
  const scores = plants.map(latestCheckup).filter(Boolean).map((c) => c.health_score);
  const attention = plants.filter(needsAttention).length;
  const stat = (label, value, alert) =>
    el('div', { class: alert ? 'stat alert' : 'stat' }, el('span', {}, label), el('strong', {}, String(value)));
  $('#stats').replaceChildren(
    stat('Plants', plants.length),
    stat('Need attention', attention, attention > 0),
    stat('Water due', plants.filter((p) => daysUntilWater(p) <= 0).length),
    stat('Average health', scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : '–'),
  );
}

const photo = (plant, className) => {
  const last = latestCheckup(plant);
  return last
    ? el('img', { class: className, src: `/photos/${last.photo}`, alt: `Latest photo of ${plant.name}`, loading: 'lazy' })
    : el('div', { class: `${className} placeholder`, role: 'img', 'aria-label': 'No photo yet' }, icon(LEAF));
};

function renderGrid() {
  $('#stats').hidden = plants.length === 0;
  $('#add-plant-btn').hidden = plants.length === 0;
  if (!plants.length) {
    $('#plant-grid').replaceChildren(
      el('div', { class: 'empty card' }, icon(LEAF), el('h2', {}, 'No plants yet'),
        el('p', {}, 'Add a plant to track its health and watering.'),
        el('button', { type: 'button', class: 'btn primary big', onclick: openAddDialog }, '+ Add plant')),
    );
    return;
  }
  $('#plant-grid').replaceChildren(
    ...plants.map((plant) => {
      const last = latestCheckup(plant);
      return el('button', { type: 'button', class: 'plant-card', onclick: () => openPlant(plant.id) },
        photo(plant, 'thumb'),
        el('span', { class: 'plant-info' },
          el('span', { class: 'name' }, plant.name),
          el('span', { class: 'muted small' }, plant.species),
          last ? badge(last.status, last.health_score) : el('span', { class: 'badge none' }, 'No checkup yet'),
          waterLine(plant),
          el('span', { class: 'muted small' }, checkedLine(plant)),
        ));
    }),
  );
}

// ---------- add plant ----------

function openAddDialog() {
  $('#form-add').reset();
  $('#dlg-add').showModal();
}

async function submitPlant(event) {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const plant = await api('POST', '/api/plants', {
      name: $('#f-name').value,
      species: $('#f-species').value,
      location: $('#f-location').value,
      waterEveryDays: Number($('#f-water').value),
      notes: $('#f-notes').value,
    });
    $('#dlg-add').close();
    replacePlant(plant);
    toast(`Added ${plant.name}`);
  } catch (err) {
    toast(friendly(err));
  } finally {
    submit.disabled = false;
  }
}

// ---------- plant detail ----------

const SENSORS = [
  { key: 'humidity', label: 'Humidity', unit: '%' },
  { key: 'temperature', label: 'Temperature', unit: '°C' },
  { key: 'soilMoisture', label: 'Soil moisture', unit: '%' },
  { key: 'light', label: 'Light', unit: 'lux' },
];

const SETUP_SENSORS = [
  ['humidity', 'Humidity'],
  ['temperature', 'Temperature'],
  ['soilMoisture', 'Soil moisture'],
  ['light', 'Light'],
];

function formatSensorReading(sensor, defaultUnit) {
  const connected = Boolean(sensor && sensor.connected);
  const unit = typeof sensor?.unit === 'string' && sensor.unit.trim() ? sensor.unit.trim() : defaultUnit;
  const hasValue = connected && typeof sensor?.value === 'number' && Number.isFinite(sensor.value);
  return {
    connected,
    reading: hasValue ? `${sensor.value}${unit === 'lux' ? ' lux' : unit}` : '—',
    hasValue,
  };
}

function sensorsSection(plant) {
  const rawSensors = plant.sensors && typeof plant.sensors === 'object' ? plant.sensors : {};
  return el('section', { class: 'card sensors-card', 'aria-labelledby': 'h-sensors' },
    el('h3', { id: 'h-sensors' }, 'Sensors'),
    el('ul', { class: 'sensor-grid' },
      SENSORS.map(({ key, label, unit }) => {
        const { connected, reading, hasValue } = formatSensorReading(rawSensors[key], unit);
        return el('li', { class: 'sensor-item', 'data-sensor': key },
          el('div', { class: 'sensor-head' },
            el('span', { class: 'sensor-label' }, label),
            el('span', { class: `badge sensor-status ${connected ? 'connected' : 'disconnected'}` },
              connected ? 'Connected' : 'Not connected')),
          el('strong', {
            class: hasValue ? 'sensor-value' : 'sensor-value unavailable',
            'aria-label': hasValue ? undefined : 'No reading',
          }, reading));
      })),
    el('a', {
      class: 'muted small',
      href: '#setup',
      onclick: (e) => {
        e.preventDefault();
        $('#dlg-plant')?.close();
        const select = $('#s-plant');
        if (select) {
          select.value = plant.id;
          select.dispatchEvent(new Event('change'));
        }
        showView('setup');
      },
    }, 'How to connect your sensors'));
}

function healthChart(checkups) {
  if (checkups.length < 2) {
    return el('p', { class: 'muted' },
      checkups.length ? 'Run one more checkup to see a trend line.' : 'Run two checkups to see a trend line.');
  }
  const width = 340;
  const x = (i) => 46 + (i * (width - 66)) / (checkups.length - 1);
  const y = (score) => 130 - score * 1.1;
  const labelAll = checkups.length <= 5;
  const summary = checkups.map((c) => `${c.health_score} on ${shortDate(c.date)}`).join(', ');
  return svg('svg', { class: 'chart', viewBox: `0 0 ${width} 156`, role: 'img', 'aria-label': `Health score by checkup: ${summary}` },
    [0, 50, 100].map((v) => [
      svg('line', { class: 'grid', x1: 32, x2: width - 8, y1: y(v), y2: y(v) }),
      svg('text', { x: 26, y: y(v) + 4, 'text-anchor': 'end' }, String(v)),
    ]).flat(),
    svg('polyline', { class: 'line', points: checkups.map((c, i) => `${x(i)},${y(c.health_score)}`).join(' ') }),
    checkups.map((c, i) => {
      const labelled = labelAll || i === 0 || i === checkups.length - 1;
      return svg('g', {},
        svg('circle', { class: 'dot', cx: x(i), cy: y(c.health_score), r: 4.5 }, svg('title', {}, `${shortDate(c.date)}: ${c.health_score}`)),
        labelled ? svg('text', { class: 'score', x: x(i), y: y(c.health_score) - 9, 'text-anchor': 'middle' }, String(c.health_score)) : null,
        labelled ? svg('text', { x: x(i), y: 151, 'text-anchor': 'middle' }, shortDate(c.date)) : null);
    }),
  );
}

let sensorPollTimer = null;
let openPlantId = null;

function stopSensorPolling() {
  if (sensorPollTimer && typeof clearInterval === 'function') {
    clearInterval(sensorPollTimer);
  }
  sensorPollTimer = null;
  openPlantId = null;
}

async function refreshOpenSensors() {
  const dialog = $('#dlg-plant');
  if (!openPlantId || !dialog?.open) return stopSensorPolling();
  try {
    const latest = await api('GET', '/api/plants');
    plants = latest;
    const plant = findPlant(openPlantId);
    const currentCard = $('#plant-detail .sensors-card');
    if (plant && currentCard && dialog.open) {
      currentCard.replaceWith(sensorsSection(plant));
    }
  } catch {
    // Ignore transient network hiccups during background polling.
  }
}

function startSensorPolling(id) {
  stopSensorPolling();
  openPlantId = id;
  if (typeof setInterval === 'function') {
    sensorPollTimer = setInterval(refreshOpenSensors, 3000);
  }
}

function openPlant(id) {
  renderDetail(id);
  const dialog = $('#dlg-plant');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  startSensorPolling(id);
}

// Runs a change from the detail dialog, blocking double taps while it is in flight.
async function act(button, task) {
  button.disabled = true;
  try {
    await task();
  } catch (err) {
    toast(friendly(err));
    button.disabled = false;
  }
}

function renderDetail(id) {
  const plant = findPlant(id);
  const dialog = $('#dlg-plant');
  if (!plant) return dialog.close();
  const go = (view, select) => {
    dialog.close();
    $(select).value = plant.id;
    $(select).dispatchEvent(new Event('change'));
    showView(view);
  };
  const button = (label, className, onclick) => el('button', { type: 'button', class: `btn ${className}`, onclick }, label);

  $('#plant-detail').replaceChildren(
    el('button', { type: 'button', class: 'close', 'aria-label': 'Close', onclick: () => dialog.close() }, '×'),
    el('div', { class: 'detail-layout' },
      el('div', { class: 'detail-left' },
        el('div', { class: 'detail-top' }, photo(plant, 'detail-photo')),
        el('div', { class: 'detail-meta' },
          el('h2', {}, plant.name),
          el('p', { class: 'muted' }, [plant.species, plant.location].filter(Boolean).join(' · ')),
          plant.notes ? el('p', {}, plant.notes) : null,
          el('p', {}, waterLine(plant), ` · every ${plural(plant.waterEveryDays, 'day')}`),
          button('New checkup', 'primary big', () => go('analyze', '#an-plant')),
          el('div', { class: 'row' },
            button('Chat about this plant', 'secondary', () => go('chat', '#chat-plant')),
            button('Mark watered', 'secondary', (e) => act(e.currentTarget, async () => {
              replacePlant(await api('PATCH', `/api/plants/${plant.id}`, { watered: true }));
              renderDetail(plant.id);
              toast('Marked as watered');
            }))),
          button('Delete plant', 'danger', (e) => {
            const target = e.currentTarget;
            if (!confirm(`Delete "${plant.name}" with all its checkups and photos? This cannot be undone.`)) return;
            act(target, async () => {
              await api('DELETE', `/api/plants/${plant.id}`);
              storeChat(plant.id, []);
              plants = plants.filter((p) => p.id !== plant.id);
              dialog.close();
              renderPlants();
              renderChat();
              toast(`Deleted ${plant.name}`);
            });
          }),
        ),
      ),
      el('div', { class: 'detail-right' },
        sensorsSection(plant),
        el('section', { class: 'card' }, el('h3', {}, 'Health over time'), healthChart(plant.checkups)),
        el('h3', {}, 'Checkups'),
        plant.checkups.length ? null : el('p', { class: 'muted' }, 'No checkups yet.'),
        [...plant.checkups].reverse().map((c) =>
          el('article', { class: 'card checkup' },
            el('a', { href: `/photos/${c.photo}`, target: '_blank', rel: 'noopener' },
              el('img', { src: `/photos/${c.photo}`, alt: `Photo from ${shortDate(c.date)}`, loading: 'lazy' })),
            el('div', { class: 'checkup-text' },
              el('strong', {}, shortDate(c.date)),
              badge(c.status, c.health_score),
              el('span', {}, c.report.summary),
              c.report.backup_model ? el('span', { class: 'muted' }, 'Made by the backup model') : null,
              c.report.problems.length
                ? el('span', { class: 'muted' }, c.report.problems.slice(0, 3).map((p) => p.name).join(', '))
                : null),
            el('button', {
              type: 'button', class: 'icon-btn', 'aria-label': `Delete checkup from ${shortDate(c.date)}`,
              onclick: (e) => {
                const target = e.currentTarget;
                if (!confirm(`Delete the checkup from ${shortDate(c.date)} and its photo?`)) return;
                act(target, async () => {
                  replacePlant(await api('DELETE', `/api/plants/${plant.id}/checkups/${c.id}`));
                  renderDetail(plant.id);
                  toast('Checkup deleted');
                });
              },
            }, icon(TRASH)))),
      ),
    ),
  );
}

// ---------- analysis ----------

let analysisImage = null;
let analyzing = false;
let photoRequest = 0;

async function resizePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = el('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; // JPEG has no transparency
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function choosePhoto(file) {
  if (!file || analyzing) return;
  const mine = ++photoRequest;
  analysisImage = null;
  $('#an-run').disabled = true;
  $('#an-preview').hidden = true;
  $('#an-result').replaceChildren();
  try {
    const resized = await resizePhoto(file);
    if (mine !== photoRequest) return;
    analysisImage = resized;
    $('#an-preview').src = resized;
    $('#an-preview').hidden = false;
    $('#an-run').disabled = false;
  } catch {
    if (mine === photoRequest) toast('Could not read that photo. Try a JPEG or PNG.');
  }
}

function setAnalyzing(value) {
  analyzing = value;
  for (const id of ['#an-plant', '#an-file', '#an-note']) $(id).disabled = value;
  $('#an-run').disabled = value || !analysisImage;
  $('#an-run').textContent = value ? 'Analyzing...' : 'Analyze';
}

async function runAnalysis() {
  if (!analysisImage || analyzing) return;
  const image = analysisImage;
  const note = $('#an-note').value.trim();
  const plantId = $('#an-plant').value;
  setAnalyzing(true);
  $('#an-result').replaceChildren(
    el('div', { class: 'card loading' }, el('div', { class: 'spinner', 'aria-hidden': 'true' }),
      el('strong', {}, 'Looking at your photo...'), el('span', {}, 'This takes a few seconds.')));
  try {
    const report = await api('POST', '/api/analyze', { image, note, plantId: plantId || undefined });
    renderReport({ report, image, note, plantId });
  } catch (err) {
    $('#an-result').replaceChildren(
      el('div', { class: 'error-card', role: 'alert' },
        el('strong', {}, err.code === 'quota' ? 'Daily free limit reached' : 'Analysis did not work'),
        el('p', {}, err.code === 'quota' ? 'Try again later. Your saved plants are still here.' : err.message)));
  } finally {
    setAnalyzing(false);
  }
}

function listSection(title, items, tag, className) {
  if (!items.length) return [];
  return [el('h3', {}, title), el(tag, { class: className }, items.map((item) => el('li', {}, item)))];
}

function scoreRing(report) {
  const length = 2 * Math.PI * 62;
  return svg('svg', { class: `ring ${report.status}`, viewBox: '0 0 150 150', role: 'img', 'aria-label': `Health score ${report.health_score} out of 100` },
    svg('circle', { class: 'track', cx: 75, cy: 75, r: 62 }),
    report.health_score > 0
      ? svg('circle', { class: 'value', cx: 75, cy: 75, r: 62, transform: 'rotate(-90 75 75)', 'stroke-dasharray': `${(length * report.health_score) / 100} ${length}` })
      : null,
    svg('text', { x: 75, y: 90, 'text-anchor': 'middle' }, String(report.health_score)));
}

const backupNote = (report) =>
  report.backup_model
    ? el('p', { class: 'note-box small' },
        report.backup_model.startsWith('gemini')
          ? 'The main model was busy or at its limit, so a lighter backup model made this report. Its assessment may differ.'
          : "Google's models were busy or at their limit, so a backup model run by Groq made this report. Its assessment may differ.")
    : null;

function plantnetSection(report) {
  const found = report.plantnet;
  if (!found) return null;
  const group = (title, items, name) =>
    items.length
      ? [el('p', {}, el('strong', {}, title)),
         el('ul', {}, items.map((item) => el('li', {}, `${name(item)} · ${Math.round(item.score * 100)}% match`)))]
      : [];
  return el('section', { class: 'card plantnet' },
    el('h3', {}, 'Pl@ntNet suggestions'),
    el('p', { class: 'muted small' }, 'Automatic guesses from the Pl@ntNet recognition API. They can be wrong, and are not a diagnosis.'),
    group('Possible plant', found.plants, (p) =>
      p.common_names.length ? `${p.name} (${p.common_names.join(', ')})` : p.name),
    group('Possible disease or pest', found.diseases, (d) => d.name));
}

function renderReport(result) {
  const { report } = result;
  if (!report.is_plant) {
    $('#an-result').replaceChildren(
      el('div', { class: 'card' }, el('h3', {}, "This doesn't look like a plant"),
        el('p', {}, report.summary || 'Try a closer photo of the leaves, stem or fruit.')),
      ...[backupNote(report)].filter(Boolean));
    return;
  }
  const footer = el('div', { class: 'analyze-form' });
  $('#an-result').replaceChildren(...[
    backupNote(report),
    el('section', { class: 'card score-card' },
      scoreRing(report),
      badge(report.status),
      el('h2', {}, report.plant_name || 'Unknown plant'),
      report.scientific_name ? el('p', { class: 'sci' }, report.scientific_name) : null,
      el('p', { class: 'muted small' }, `Confidence: ${report.confidence}`),
      el('p', {}, report.summary)),
    report.problems.length ? el('h3', {}, 'Problems') : null,
    report.problems.map((p) =>
      el('article', { class: 'card problem' },
        el('div', { class: 'problem-head' }, el('strong', {}, p.name),
          el('span', { class: `badge sev-${p.severity}` }, SEVERITY[p.severity] ?? p.severity)),
        el('p', {}, el('strong', {}, 'What we see: '), p.evidence),
        el('p', {}, el('strong', {}, 'Likely cause: '), p.likely_cause))),
    listSection('What to do now', report.actions, 'ol', 'actions-list'),
    listSection('Prevention', report.prevention, 'ul'),
    report.watering_advice ? el('div', { class: 'note-box water' }, el('strong', {}, 'Watering'), el('p', {}, report.watering_advice)) : null,
    report.progress_note ? el('div', { class: 'note-box' }, el('strong', {}, 'Since last check'), el('p', {}, report.progress_note)) : null,
    plantnetSection(report),
    footer,
  ].flat().filter(Boolean));
  renderReportActions(footer, result);
  if (result.plantId) saveCheckup(footer, result);
}

function askAbout(result) {
  if (result.savedId && findPlant(result.savedId)) {
    $('#chat-plant').value = result.savedId;
    renderChat();
  } else {
    // The server only knows about saved plants, so put the findings into the question.
    $('#chat-plant').value = '';
    renderChat();
    $('#chat-input').value =
      `I checked a photo of ${result.report.plant_name || 'my plant'}. The result was: ${result.report.summary} What should I do first?`;
  }
  showView('chat');
  growInput();
}

function renderReportActions(footer, result) {
  const saved = result.savedId && findPlant(result.savedId);
  footer.replaceChildren(...[
    saved
      ? el('p', { class: 'muted' }, `Saved to ${saved.name}.`)
      : el('button', { type: 'button', class: 'btn primary', disabled: result.saving, onclick: () => saveCheckup(footer, result) },
          result.saving ? 'Saving...' : result.plantId ? 'Try saving again' : 'Add to dashboard'),
    el('button', { type: 'button', class: 'btn secondary', disabled: result.saving, onclick: () => askAbout(result) }, 'Ask about this plant'),
  ]);
}

async function saveCheckup(footer, result) {
  if (result.saving || result.savedId) return;
  result.saving = true;
  renderReportActions(footer, result);
  try {
    if (!result.plantId) {
      const created = await api('POST', '/api/plants', {
        name: (result.report.plant_name || 'New plant').slice(0, 80),
        species: result.report.scientific_name,
      });
      // Remembered so that retrying a failed save does not create a second plant.
      result.plantId = created.id;
      replacePlant(created);
    }
    const plant = await api('POST', `/api/plants/${result.plantId}/checkups`,
      { image: result.image, report: result.report, note: result.note });
    replacePlant(plant);
    result.savedId = plant.id;
    toast(`Saved to ${plant.name}`);
  } catch (err) {
    toast(`Not saved: ${friendly(err)}`);
  } finally {
    result.saving = false;
    renderReportActions(footer, result);
  }
}

// ---------- chat ----------

let streaming = false;
const chatMemory = new Map(); // used if the browser blocks or fills localStorage
const chatKey = (id) => currentUser
  ? `leafwise.chat.${currentUser.id}.${id || 'general'}`
  : `leafwise.chat.${id || 'general'}`;
const currentChat = () => $('#chat-plant').value;

function loadChat(id) {
  const key = chatKey(id);
  if (chatMemory.has(key)) return chatMemory.get(key);
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    return Array.isArray(saved) ? saved.filter((m) => m && typeof m.text === 'string') : [];
  } catch {
    return [];
  }
}

function storeChat(id, messages) {
  const key = chatKey(id);
  try {
    if (messages.length) localStorage.setItem(key, JSON.stringify(messages.slice(-100)));
    else localStorage.removeItem(key);
    chatMemory.delete(key);
  } catch {
    chatMemory.set(key, messages);
  }
}

// Escapes first, so only the tags added here can ever become HTML.
function markdown(source) {
  const escaped = source.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const inline = (line) => line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  let html = '';
  let inList = false;
  let afterText = false;
  for (const line of escaped.split('\n')) {
    const bullet = /^\s*(?:[-•]|\*(?!\*))\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) html += '<ul>';
      html += `<li>${inline(bullet[1])}</li>`;
      inList = true;
      afterText = false;
    } else if (inList && !line.trim()) {
      // A blank line right after a list: the list's own spacing is enough.
      html += '</ul>';
      inList = false;
    } else {
      if (inList) html += '</ul>';
      html += `${afterText ? '<br>' : ''}${inline(line)}`;
      inList = false;
      afterText = true;
    }
  }
  return inList ? `${html}</ul>` : html;
}

function bubble(message) {
  const node = el('div', { class: `msg ${message.role}` });
  node.innerHTML = markdown(message.text);
  return node;
}

function scrollChat() {
  $('#msgs').scrollTop = $('#msgs').scrollHeight;
}

function renderChat() {
  const messages = loadChat(currentChat());
  $('#msgs').replaceChildren(...messages.map(bubble));
  $('#chips').replaceChildren(
    ...(messages.length ? [] : STARTERS.map((question) =>
      el('button', { type: 'button', class: 'chip', onclick: () => sendMessage(question) }, question))));
  scrollChat();
}

function setStreaming(value) {
  streaming = value;
  for (const id of ['#chat-send', '#chat-clear', '#chat-plant']) $(id).disabled = value;
}

async function readReply(response, onText) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const event = JSON.parse(line.slice(5));
      if (event.error) throw apiError(event.error, event.code);
      if (event.done) return;
      onText(event.t);
    }
  }
  throw apiError('The connection closed before the reply finished.', 'interrupted');
}

async function sendMessage(raw) {
  const message = raw.trim();
  if (!message || streaming) return;
  // The chat is captured here: the user may open another one while the reply arrives.
  const id = currentChat();
  const history = [...loadChat(id), { role: 'user', text: message }];
  storeChat(id, history);
  $('#chat-input').value = '';
  growInput();
  setStreaming(true);
  renderChat();

  const reply = el('div', { class: 'msg model' }, el('span', { class: 'cursor', 'aria-hidden': 'true' }));
  $('#msgs').append(reply);
  scrollChat();
  let answer = '';
  let failure = null;
  try {
    const response = await request('POST', '/api/chat', { history: history.slice(-30), plantId: id || undefined });
    await readReply(response, (piece) => {
      const box = $('#msgs');
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      answer += piece;
      reply.innerHTML = `${markdown(answer)}<span class="cursor" aria-hidden="true"></span>`;
      if (atBottom) scrollChat();
    });
  } catch (err) {
    failure = friendly(err);
  }
  setStreaming(false);

  if (id && !findPlant(id)) return storeChat(id, []);
  if (answer) {
    storeChat(id, [...history, { role: 'model', text: answer }]);
  } else {
    // Nothing came back: take the question out of the history and give it back for another try.
    storeChat(id, history.slice(0, -1));
  }
  if (currentChat() === id) {
    renderChat();
    if (failure) {
      $('#msgs').append(el('div', { class: 'msg error', role: 'alert' }, failure));
      if (!answer && !$('#chat-input').value) {
        $('#chat-input').value = message;
        growInput();
      }
      scrollChat();
    }
  } else if (failure) {
    toast(failure);
  }
}

function growInput() {
  const input = $('#chat-input');
  input.style.height = 'auto';
  // A hidden textarea reports no height, so leave it on "auto" until it is visible.
  if (input.scrollHeight) input.style.height = `${input.scrollHeight + 4}px`;
}

// ---------- start ----------

function showBanner(message) {
  $('#banner').textContent = message;
  $('#banner').hidden = false;
}
// The chat view is sized to the screen, so it needs the banner's real height, which changes when text wraps.
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--banner-h', `${$('#banner').offsetHeight}px`);
}).observe($('#banner'));

$('#tabs').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-view]');
  if (button) showView(button.dataset.view);
});
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

$('#add-plant-btn').addEventListener('click', openAddDialog);
$('#form-add').addEventListener('submit', submitPlant);
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}

$('#an-file').addEventListener('change', (e) => {
  choosePhoto(e.target.files[0]);
  e.target.value = ''; // lets the same file be chosen again
});
$('#an-run').addEventListener('click', runAnalysis);
$('#an-plant').addEventListener('change', () => $('#an-result').replaceChildren());
const drop = $('#drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  choosePhoto(e.dataTransfer.files[0]);
});

$('#chat-plant').addEventListener('change', renderChat);
$('#chat-clear').addEventListener('click', () => {
  if (!loadChat(currentChat()).length || !confirm('Clear this chat?')) return;
  storeChat(currentChat(), []);
  renderChat();
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage($('#chat-input').value);
});
$('#chat-input').addEventListener('input', growInput);
$('#chat-input').addEventListener('keydown', (e) => {
  // isComposing: Enter is also used to confirm text in some keyboards, such as Thai or Japanese input methods.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage($('#chat-input').value);
  }
});

$('#dlg-plant').addEventListener('close', stopSensorPolling);

async function init() {
  showView(location.hash.slice(1));
  try {
    const config = await api('GET', '/api/config');
    if (config.authEnabled && !config.user) {
      window.location.replace('/');
      return;
    }
    currentUser = config.user;
    const logout = $('#logout-btn');
    logout.hidden = !currentUser;
    logout.addEventListener('click', handleLogout);
    await loadPlants();
    $('#demo-tag').hidden = !config.mock;
    if (config.blynkTemplateId && $('#s-blynk-template')) {
      $('#s-blynk-template').value = config.blynkTemplateId;
      refreshSetupForm();
    }
    if (!config.hasKey && !config.mock) {
      showBanner('No AI key set. Add one to .env to use analysis and chat.');
    }
    renderChat();
  } catch (err) {
    showBanner(friendly(err));
  }
  initSetup();
}

// ---------- setup view ----------

async function loadSetupSketch() {
  try {
    const res = await fetch('/arduino/watermi_blynk/watermi_blynk.ino');
    if (res.ok) setupSketch = await res.text();
  } catch {
    // The download button stays disabled without the sketch.
  }
}

function setConst(source, name, value) {
  return source.replace(
    new RegExp(`(const char\\* ${name}\\s*=\\s*)"[^"]*";`),
    (_, head) => `${head}"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";`,
  );
}

function setStringDefine(source, name, value) {
  return source.replace(
    new RegExp(`(#define ${name}\\s+)"[^"]*"`),
    (_, head) => `${head}"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  );
}

function setDefine(source, name, value) {
  return source.replace(
    new RegExp(`(#define ${name}\\s+)\\d+`),
    (_, head) => `${head}${value}`,
  );
}

function setIntConst(source, name, value) {
  return source.replace(
    new RegExp(`(const (?:unsigned long|int) ${name}\\s*=\\s*)\\d+`),
    (_, head) => `${head}${value}`,
  );
}

function setBoolConst(source, name, value) {
  return source.replace(
    new RegExp(`(const bool ${name}\\s*=\\s*)(true|false)`),
    (_, head) => `${head}${value}`,
  );
}

function setupValues() {
  return {
    WIFI_SSID: $('#s-ssid').value.trim(),
    WIFI_PASSWORD: $('#s-pass').value,
    BLYNK_TEMPLATE_ID: $('#s-blynk-template').value.trim(),
    BLYNK_AUTH_TOKEN: $('#s-blynk-auth').value,
    SEND_INTERVAL_MS: $('#s-interval').value,
    SOIL_DRY_RAW: $('#s-dry').value,
    SOIL_WET_RAW: $('#s-wet').value,
    LIGHT_SENSOR_ENABLED: $('#s-light').value,
    DHTPIN: $('#s-dhtpin').value,
    soilMoisturePin: $('#s-soilpin').value,
    lightPin: $('#s-lightpin').value,
  };
}

function buildSketch() {
  let out = setupSketch;
  const v = setupValues();

  // String constants & #define strings
  out = setConst(out, 'WIFI_SSID', v.WIFI_SSID);
  out = setConst(out, 'WIFI_PASSWORD', v.WIFI_PASSWORD);
  out = setStringDefine(out, 'BLYNK_TEMPLATE_ID', v.BLYNK_TEMPLATE_ID);
  out = setStringDefine(out, 'BLYNK_AUTH_TOKEN', v.BLYNK_AUTH_TOKEN);

  // Numeric constants (int)
  out = setIntConst(out, 'soilMoisturePin', v.soilMoisturePin);
  out = setIntConst(out, 'lightPin', v.lightPin);
  out = setIntConst(out, 'SOIL_DRY_RAW', v.SOIL_DRY_RAW);
  out = setIntConst(out, 'SOIL_WET_RAW', v.SOIL_WET_RAW);
  out = setIntConst(out, 'SEND_INTERVAL_MS', v.SEND_INTERVAL_MS);

  // Boolean constant
  out = setBoolConst(out, 'LIGHT_SENSOR_ENABLED', v.LIGHT_SENSOR_ENABLED);

  // #define
  out = setDefine(out, 'DHTPIN', v.DHTPIN);

  return out;
}

function refreshSetupForm() {
  const v = setupValues();
  const preview = $('#s-preview');
  if (preview) {
    preview.textContent = [
      `WIFI_SSID           = "${v.WIFI_SSID}"`,
      `WIFI_PASSWORD       = "${v.WIFI_PASSWORD ? '********' : ''}"`,
      `BLYNK_TEMPLATE_ID   = "${v.BLYNK_TEMPLATE_ID}"`,
      `BLYNK_AUTH_TOKEN    = "${v.BLYNK_AUTH_TOKEN ? '********' : ''}"`,
      `SEND_INTERVAL_MS    = ${v.SEND_INTERVAL_MS}`,
      `SOIL_DRY_RAW        = ${v.SOIL_DRY_RAW}`,
      `SOIL_WET_RAW        = ${v.SOIL_WET_RAW}`,
      `LIGHT_SENSOR_ENABLED= ${v.LIGHT_SENSOR_ENABLED}`,
      `DHTPIN              = ${v.DHTPIN}`,
      `soilMoisturePin     = ${v.soilMoisturePin}`,
      `lightPin            = ${v.lightPin}`,
    ].join('\n');
  }
  const plantId = $('#s-plant')?.value || '';
  const plant = setupPlants.find((p) => p.id === plantId);
  const connectBtn = $('#s-connect');
  const disconnectBtn = $('#s-disconnect');
  const connectHint = $('#connect-hint');
  if (connectBtn) {
    connectBtn.disabled = !(plantId && v.BLYNK_AUTH_TOKEN.trim());
    connectBtn.textContent = plant?.blynkLinked ? 'Update Blynk token' : 'Connect Blynk to plant';
  }
  if (disconnectBtn) disconnectBtn.hidden = !plant?.blynkLinked;
  if (connectHint && plant) {
    connectHint.textContent = plant.blynkLinked
      ? `Blynk is connected to ${plant.name}. WaterMI pulls live sensor readings automatically.`
      : 'Paste your Blynk Auth Token and click Connect so WaterMI reads live data automatically.';
  }
  $('#s-download').disabled = !(setupSketch && v.WIFI_SSID && v.BLYNK_TEMPLATE_ID && v.BLYNK_AUTH_TOKEN);
}

function renderLiveSetup() {
  const box = $('#live');
  if (!box) return;
  const select = $('#s-plant');
  const plant = select ? setupPlants.find((p) => p.id === select.value) : setupPlants[0];
  box.replaceChildren();
  const msg = $('#live-msg');
  if (!plant) {
    if (msg) msg.textContent = 'Add a plant on the Dashboard first.';
    return;
  }
  const sensors = plant.sensors ?? {};
  const any = SETUP_SENSORS.some(([key]) => sensors[key]?.connected);
  if (msg) {
    msg.textContent = any
      ? 'The board is sending data. This page refreshes every 3 seconds.'
      : 'Waiting for the board. Readings appear here a few seconds after it connects.';
  }
  for (const [key, label] of SETUP_SENSORS) {
    const s = sensors[key] ?? {};
    const connected = Boolean(s.connected);
    const hasValue = connected && Number.isFinite(s.value);
    const item = document.createElement('div');
    item.className = 'stat';
    const name = document.createElement('span');
    name.textContent = label;
    const value = document.createElement('strong');
    value.textContent = hasValue ? `${s.value}${s.unit === 'lux' ? ' lux' : (s.unit ?? '')}` : '—';
    const badge = document.createElement('span');
    badge.className = `badge ${connected ? 'healthy' : 'none'}`;
    badge.textContent = connected ? 'Connected' : 'Not connected';
    item.append(name, value, badge);
    box.append(item);
  }
}

async function loadSetupPlants() {
  try {
    const res = await fetch('/api/plants', { credentials: 'include' });
    if (!res.ok) return;
    const latest = await res.json();
    const first = !setupPlants.length;
    setupPlants = latest;
    const select = $('#s-plant');
    if (select) {
      const current = select.value;
      select.replaceChildren(...setupPlants.map((p) => {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = p.name;
        return option;
      }));
      if (setupPlants.some((p) => p.id === current)) select.value = current;
    }
    const noplant = $('#s-noplant');
    if (noplant) noplant.hidden = setupPlants.length > 0;
    if (first) refreshSetupForm();
    renderLiveSetup();
  } catch {
    // The next poll tries again.
  }
}

function stopSetupPolling() {
  if (setupPollTimer && typeof clearInterval === 'function') {
    clearInterval(setupPollTimer);
  }
  setupPollTimer = null;
  setupViewActive = false;
}

function startSetupPolling() {
  stopSetupPolling();
  setupViewActive = true;
  loadSetupPlants();
  if (typeof setInterval === 'function') {
    setupPollTimer = setInterval(loadSetupPlants, 3000);
  }
}

function populatePinDropdowns() {
  const dhtPins = [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33];
  const adc1Pins = [32, 33, 34, 35, 36, 37, 38, 39];

  function fillSelect(id, options, defaultVal) {
    const sel = $(id);
    sel.replaceChildren(...options.map((n) => {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = `GPIO ${n}`;
      if (n === defaultVal) opt.selected = true;
      return opt;
    }));
  }

  fillSelect('#s-dhtpin', dhtPins, 4);
  fillSelect('#s-soilpin', adc1Pins, 34);
  fillSelect('#s-lightpin', adc1Pins, 35);
}

function updateWiringDiagram() {
  $('#w-dhtpin').textContent = `GPIO ${$('#s-dhtpin').value}`;
  $('#w-soilpin').textContent = `GPIO ${$('#s-soilpin').value}`;
  $('#w-lightpin').textContent = `GPIO ${$('#s-lightpin').value}`;
}

function initSetup() {
  populatePinDropdowns();
  updateWiringDiagram();
  for (const id of ['#s-ssid', '#s-pass', '#s-blynk-template', '#s-blynk-auth', '#s-interval', '#s-dry', '#s-wet', '#s-light', '#s-dhtpin', '#s-soilpin', '#s-lightpin']) {
    $(id).addEventListener('input', refreshSetupForm);
  }
  const plantSelect = $('#s-plant');
  if (plantSelect) {
    plantSelect.addEventListener('change', () => {
      refreshSetupForm();
      renderLiveSetup();
    });
  }
  const connectBtn = $('#s-connect');
  if (connectBtn) {
    connectBtn.addEventListener('click', async () => {
      const plantId = $('#s-plant')?.value;
      const token = $('#s-blynk-auth').value.trim();
      if (!plantId || !token) return;
      connectBtn.disabled = true;
      try {
        const updated = await api('PATCH', `/api/plants/${plantId}`, { blynkToken: token });
        replacePlant(updated);
        setupPlants = plants;
        refreshSetupForm();
        renderLiveSetup();
        toast(`Connected Blynk to ${updated.name}`);
      } catch (err) {
        toast(friendly(err));
      } finally {
        refreshSetupForm();
      }
    });
  }
  const disconnectBtn = $('#s-disconnect');
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async () => {
      const plantId = $('#s-plant')?.value;
      if (!plantId) return;
      disconnectBtn.disabled = true;
      try {
        const updated = await api('PATCH', `/api/plants/${plantId}`, { blynkToken: '' });
        replacePlant(updated);
        setupPlants = plants;
        refreshSetupForm();
        renderLiveSetup();
        toast(`Disconnected Blynk from ${updated.name}`);
      } catch (err) {
        toast(friendly(err));
      } finally {
        disconnectBtn.disabled = false;
        refreshSetupForm();
      }
    });
  }
  // Also update wiring diagram when pin dropdowns change
  for (const id of ['#s-dhtpin', '#s-soilpin', '#s-lightpin']) {
    $(id).addEventListener('change', updateWiringDiagram);
  }
  $('#s-download').addEventListener('click', () => {
    const sketch = buildSketch();
    const url = URL.createObjectURL(new Blob([sketch], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'watermi_blynk.ino';
    link.click();
    URL.revokeObjectURL(url);
    // Provide feedback
    const hint = $('#download-hint');
    hint.textContent = 'Sketch downloaded! Open it in Arduino IDE to flash your ESP32.';
    hint.className = 'muted small ok-bg';
    // Re-enable after a moment so they can download again
    setTimeout(() => { hint.textContent = 'Enter Wi-Fi, Blynk Template ID & Auth Token, then click Download sketch.'; hint.className = 'muted small'; }, 5000);
  });
  loadSetupSketch();
  loadSetupPlants();
}

// ---------- analysis ----------

init();
