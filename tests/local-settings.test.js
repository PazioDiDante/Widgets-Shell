const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadLocalSettings, saveLocalSettingsPatch } = require('../src/main/local-settings');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'widgets-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('credentials are empty without local configuration', (t) => {
  const settings = loadLocalSettings(fixture(t), {});
  assert.equal(settings.spotifyClientId, '');
  assert.equal(settings.spotifyClientSecret, '');
});

test('environment overrides local settings while preserving other paths', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'settings.local.json'), JSON.stringify({
    spotifyClientId: 'local-id', spotifyClientSecret: 'dummy-private-value', todoRootPath: 'tasks'
  }));
  const settings = loadLocalSettings(root, { SPOTIFY_CLIENT_ID: 'env-id' });
  assert.equal(settings.spotifyClientId, 'env-id');
  assert.equal(settings.spotifyClientSecret, 'dummy-private-value');
  assert.equal(settings.todoRootPath, 'tasks');
});

test('invalid configuration errors never echo secret values', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'settings.local.json'), '{"secret":"do-not-display",');
  assert.throws(() => loadLocalSettings(root, {}), (error) => {
    assert.ok(!error.message.includes('do-not-display'));
    return /JSON format/.test(error.message);
  });
});

test('updating todo paths preserves existing credentials and settings', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'settings.local.json'), JSON.stringify({
    spotifyClientId: 'personal-id',
    spotifyClientSecret: 'dummy-private-value',
    customSetting: true
  }));

  saveLocalSettingsPatch(root, {
    todoRootPath: 'D:/Notes/Todo',
    todoTemplatePath: ''
  });

  const saved = JSON.parse(fs.readFileSync(path.join(root, 'settings.local.json'), 'utf8'));
  assert.equal(saved.spotifyClientId, 'personal-id');
  assert.equal(saved.spotifyClientSecret, 'dummy-private-value');
  assert.equal(saved.customSetting, true);
  assert.equal(saved.todoRootPath, 'D:/Notes/Todo');
  assert.equal(saved.todoTemplatePath, '');
});
