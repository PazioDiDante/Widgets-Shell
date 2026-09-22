const fs = require('node:fs');
const path = require('node:path');

function loadLocalSettings(root, env = process.env) {
  const file = path.join(root, 'settings.local.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error('Cannot read settings.local.json. Check its JSON format.');
    }
  }
  const fields = {
    spotifyClientId: 'SPOTIFY_CLIENT_ID',
    spotifyClientSecret: 'SPOTIFY_CLIENT_SECRET',
    todoRootPath: 'WIDGETS_TODO_PATH',
    todoTemplatePath: 'WIDGETS_TODO_TEMPLATE_PATH'
  };
  const result = {};
  for (const [key, variable] of Object.entries(fields)) {
    const value = env[variable] ?? settings[key] ?? '';
    if (typeof value !== 'string') throw new Error(`Setting ${key} must be a string.`);
    result[key] = value.trim();
  }
  return result;
}

function saveLocalSettingsPatch(root, patch) {
  const file = path.join(root, 'settings.local.json');
  let settings = {};

  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error('Cannot read settings.local.json. Check its JSON format.');
    }
  }

  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== 'string') {
      throw new Error(`Setting ${key} must be a string.`);
    }

    settings[key] = value.trim();
  }

  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

module.exports = { loadLocalSettings, saveLocalSettingsPatch };
