const byId = id => document.getElementById(id);
const model = /** @type {HTMLSelectElement} */ (byId('model'));
const family = /** @type {HTMLSelectElement} */ (byId('family'));
const role = /** @type {HTMLSelectElement} */ (byId('role'));
const pin = /** @type {HTMLButtonElement} */ (byId('pin'));
let current, pinned, requestNumber = 0;
let requested = new Set();
const bytes = value => `${value.toLocaleString('en-US')} B`;
const size = entry => `${bytes(entry.bytes)} · ${entry.characters.toLocaleString('en-US')} characters`;

// Configuration and instruction text are always text nodes, never HTML/Markdown.
function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

async function get(endpoint) {
  const response = await fetch(endpoint, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

function options(select, choices, empty, selected) {
  select.replaceChildren();
  if (empty) select.add(new Option(empty, ''));
  for (const value of choices) select.add(new Option(value, value));
  if (selected && !choices.includes(selected)) select.add(new Option(selected, selected));
  select.value = selected ?? '';
}

function inspect(entry, provenance) {
  const details = document.createElement('details');
  // Host-native skills are invoked by the host; Agent Profiles never injects or measures them.
  const host = entry.type === 'host';
  details.append(element('summary', `${entry.id} · ${host ? 'host skill' : bytes(entry.bytes)}`),
    element('p', host ? `${entry.host} skill ${entry.hostId} · ${entry.verification} · bytes not counted` : size(entry), 'size'),
    element('p', provenance, 'muted'), element('code', entry.path ?? `${entry.host}: ${entry.hostId}`));
  if (entry.description) details.append(element('p', entry.description, 'muted'));
  if (entry.content !== undefined) details.append(element('pre', entry.content));
  return details;
}

function compare() {
  byId('comparison').hidden = !pinned;
  if (!pinned) return;
  const label = result => `${result.model ?? 'Default model'} / ${result.family ?? 'no family'} / ${result.role} / ${result.profile}`;
  byId('comparison-label').textContent = `${label(pinned)} → ${label(current)}`;
  const rows = byId('comparison-rows');
  rows.replaceChildren();
  for (const [key, title] of [['profile', 'Profile'], ['role', 'Role'], ['requiredSkills', 'Required skills'], ['requestedSkills', 'Requested skills'], ['total', 'Managed total'], ['availableNotLoaded', 'Available, not loaded']]) {
    const before = key === 'availableNotLoaded' ? pinned.diagnostics[key] : pinned.diagnostics.managed[key];
    const after = key === 'availableNotLoaded' ? current.diagnostics[key] : current.diagnostics.managed[key];
    const row = element('tr');
    row.append(element('th', title), element('td', bytes(before.bytes)), element('td', bytes(after.bytes)),
      element('td', `${after.bytes > before.bytes ? '+' : ''}${bytes(after.bytes - before.bytes)}`));
    rows.append(row);
  }
}

function render(result) {
  current = result;
  const { managed, availableNotLoaded } = result.diagnostics;
  byId('total').textContent = bytes(managed.total.bytes);
  byId('total-chars').textContent = `${managed.total.characters.toLocaleString('en-US')} characters · ${managed.total.files} instruction entries`;
  byId('available-total').textContent = bytes(availableNotLoaded.bytes);
  byId('routing').textContent = `${result.model ?? 'Unspecified model'} → ${result.profile} (matched by ${result.matchedBy}${result.matchedBy.startsWith('family') ? ': ' + result.family : result.matchedBy === 'alias' ? ' of ' + result.identity.canonical : ''}) · Role: ${result.role}`;
  const layers = byId('layers');
  layers.replaceChildren();
  for (const kind of ['profile', 'role']) {
    const layer = element('div', '', 'layer');
    layer.append(element('h3', kind === 'profile' ? '01 / Model profile' : '02 / Assigned role'));
    for (const entry of result.loaded.filter(item => item.kind === kind)) {
      const card = element('div', '', 'entry');
      card.append(inspect(entry, kind === 'profile' ? `Selected by ${result.matchedBy} routing` : `Active role: ${result.role}`));
      layer.append(card);
    }
    layers.append(layer);
  }
  const required = byId('required');
  required.replaceChildren(element('p', size(managed.requiredSkills), 'muted'));
  for (const entry of result.loaded.filter(item => item.kind === 'required-skill')) {
    const card = element('div', '', 'entry');
    card.append(inspect(entry, `Required by role: ${result.role}`));
    required.append(card);
  }
  for (const entry of result.required.filter(item => item.type === 'host')) {
    const card = element('div', '', 'entry');
    card.append(inspect(entry, `Required by role ${result.role}; invoked through the host`));
    required.append(card);
  }
  if (!result.required.length) required.append(element('p', 'No required skills.', 'muted'));
  const available = byId('available');
  available.replaceChildren(element('p', `Requested: ${size(managed.requestedSkills)}`, 'muted'));
  for (const entry of result.available) {
    if (entry.type === 'host') {
      const card = element('div', '', 'entry');
      card.append(inspect(entry, `Available to role ${result.role}; invoked through the host, never injected`));
      available.append(card);
      continue;
    }
    const loaded = result.loaded.find(item => item.kind === 'requested-skill' && item.id === entry.id);
    const card = element('div', '', `entry${loaded ? ' requested' : ''}`);
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `skill-${entry.id}`;
    checkbox.checked = Boolean(loaded);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) requested.add(entry.id); else requested.delete(entry.id);
      update(checkbox.id);
    });
    label.append(checkbox, document.createTextNode(`${entry.id} · ${loaded ? 'Requested, loaded' : 'Available, not loaded'}`));
    card.append(label, inspect(loaded ?? entry, `${loaded ? 'Requested for' : 'Available to'} role: ${result.role}`));
    available.append(card);
  }
  if (!result.available.length) available.append(element('p', 'No on-demand skills for this role.', 'muted'));
  compare();
}

function failure(error) {
  byId('error').textContent = error.message;
  byId('error').hidden = false;
  byId('view').hidden = true;
  byId('status').textContent = 'Unable to resolve. Fix the configuration or change the selection, then refresh.';
}

async function update(focusId) {
  const number = ++requestNumber;
  pin.disabled = true;
  byId('view').setAttribute('aria-busy', 'true');
  byId('error').hidden = true;
  byId('status').textContent = 'Resolving selected instructions…';
  const query = new URLSearchParams();
  for (const [key, value] of [['model', model.value], ['family', family.value], ['role', role.value]]) if (value) query.set(key, value);
  for (const skill of requested) query.append('skill', skill);
  try {
    const result = await get(`api/resolve?${query}`);
    if (number !== requestNumber) return;
    render(result);
    byId('view').hidden = false;
    byId('status').textContent = `Resolved ${result.role} / ${result.profile}. Temporary skill selections do not change files.`;
    if (focusId) byId(focusId)?.focus();
  } catch (error) { if (number === requestNumber) failure(error); }
  finally {
    if (number === requestNumber) {
      pin.disabled = false;
      byId('view').removeAttribute('aria-busy');
    }
  }
}

async function initialize(first = false) {
  ++requestNumber;
  const refresh = /** @type {HTMLButtonElement} */ (byId('refresh'));
  for (const control of [model, family, role, refresh]) control.disabled = true;
  try {
    const data = await get('api/config');
    const selection = first ? data.initial : { model: model.value, family: family.value, role: data.roles.includes(role.value) ? role.value : data.initial.role };
    options(model, data.models, 'Unspecified model (use fallback)', selection.model);
    options(family, data.families, 'No family fallback', selection.family);
    options(role, data.roles, null, selection.role);
    requested = new Set(first ? data.initial.skills : []);
    await update();
  } catch (error) { failure(error); }
  finally { for (const control of [model, family, role, refresh]) control.disabled = false; }
}

byId('selectors').addEventListener('submit', event => event.preventDefault());
model.addEventListener('change', () => update());
family.addEventListener('change', () => update());
role.addEventListener('change', () => { requested.clear(); update(); });
byId('refresh').addEventListener('click', () => initialize());
pin.addEventListener('click', () => { pinned = current; compare(); });
byId('clear').addEventListener('click', () => { pinned = undefined; compare(); });
initialize(true);
