
const $ = id => document.getElementById(id);

const defaults = { enabled: true, delay: 2000 };

chrome.storage.local.get('settings').then(({ settings = {} }) => {
  const ui = { ...defaults };
  ui.enabled = settings.enabled ?? defaults.enabled;
  ui.delay   = settings.turnstile_solve_delay_time ?? defaults.delay;

  $('enabled').checked = ui.enabled;
  $('delay').value     = ui.delay;
});

$('enabled').addEventListener('change', () => save(readUI()));
$('delay').addEventListener('input', () => save(readUI()));

function readUI() {
  return {
    enabled: $('enabled').checked,
    delay:   Number($('delay').value) || 0
  };
}
function save(ui) {
  const out = {
    enabled: ui.enabled,
    turnstile_solve_delay_time: ui.delay
  };
  chrome.storage.local.set({ settings: out });
  chrome.runtime.sendMessage([Math.random().toString(36).slice(2), 'settings::update', out]);
}
