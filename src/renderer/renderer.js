const appRoot = document.querySelector('#app');
const params = new URLSearchParams(window.location.search);
const view = params.get('view') || 'menu';
const widgetId = params.get('widgetId');
const collapsedTodoGroups = new Set(JSON.parse(localStorage.getItem('todo:collapsedGroups') || '[]'));
let unsubscribeTodoTreeUpdated = null;
let unsubscribeAppearanceUpdated = null;
let unsubscribeObservedDevicesUpdated = null;
let unsubscribeSpotifyLiteUpdated = null;
let unsubscribeDockerUpdated = null;
let unsubscribeDockerTodoUpdated = null;
let unsubscribeDockerDevicesUpdated = null;
let unsubscribeDockerSpotifyUpdated = null;
let appearanceSaveTimer = null;
let draggedTodoTaskId = null;
let devicesPollTimer = null;
let dockerDevicesPollTimer = null;
let dockerSpotifyProgressTimer = null;
let spotifyProgressTimer = null;
let stopDockerClockTicker = null;
const todoGroupAnimationMs = 460;
const devicesPollMs = 5 * 60 * 1000;
const clockTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});
const clockDateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric'
});

window.addEventListener('beforeunload', () => {
  clearTimeout(appearanceSaveTimer);
  clearInterval(devicesPollTimer);
  clearInterval(dockerDevicesPollTimer);
  clearInterval(dockerSpotifyProgressTimer);
  clearInterval(spotifyProgressTimer);
  stopDockerClockTicker?.();

  for (const unsubscribe of [
    unsubscribeTodoTreeUpdated,
    unsubscribeAppearanceUpdated,
    unsubscribeObservedDevicesUpdated,
    unsubscribeSpotifyLiteUpdated,
    unsubscribeDockerUpdated,
    unsubscribeDockerTodoUpdated,
    unsubscribeDockerDevicesUpdated,
    unsubscribeDockerSpotifyUpdated
  ]) {
    unsubscribe?.();
  }
}, { once: true });

function formatClockTime(date = new Date()) {
  return clockTimeFormatter.format(date);
}

function formatClockDate(date = new Date()) {
  const formatted = clockDateFormatter.format(date);
  return formatted.charAt(0).toLocaleUpperCase() + formatted.slice(1);
}

function startMinuteAlignedUpdates(update) {
  let timer = null;
  let stopped = false;

  const tick = () => {
    if (stopped) {
      return;
    }

    update();
    const delay = 60_000 - (Date.now() % 60_000) + 25;
    timer = setTimeout(tick, delay);
  };

  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function startClockTicker(timeElement, dateElement = null) {
  const stop = startMinuteAlignedUpdates(() => {
    const now = new Date();
    timeElement.textContent = formatClockTime(now);
    timeElement.dateTime = now.toISOString();
    if (dateElement) {
      dateElement.textContent = formatClockDate(now);
      dateElement.dateTime = now.toISOString().slice(0, 10);
    }
  });
  window.addEventListener('beforeunload', stop, { once: true });
  return stop;
}

function hsbToRgb(hue, saturation, brightness) {
  const h = ((Number(hue) % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, Number(saturation))) / 100;
  const v = Math.max(0, Math.min(100, Number(brightness))) / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (h < 60) {
    red = c;
    green = x;
  } else if (h < 120) {
    red = x;
    green = c;
  } else if (h < 180) {
    green = c;
    blue = x;
  } else if (h < 240) {
    green = x;
    blue = c;
  } else if (h < 300) {
    red = x;
    blue = c;
  } else {
    red = c;
    blue = x;
  }

  return {
    red: Math.round((red + m) * 255),
    green: Math.round((green + m) * 255),
    blue: Math.round((blue + m) * 255)
  };
}

function applyAppearance(appearance) {
  if (!appearance) {
    return;
  }

  const color = hsbToRgb(
    appearance.backgroundHue,
    appearance.backgroundSaturation,
    appearance.backgroundBrightness
  );
  const opacity = Math.max(0, Math.min(100, Number(appearance.backgroundOpacity))) / 100;

  document.documentElement.style.setProperty(
    '--shell-background',
    `rgba(${color.red}, ${color.green}, ${color.blue}, ${opacity})`
  );
}

function ensureAppearanceSubscription() {
  if (unsubscribeAppearanceUpdated) {
    return;
  }

  unsubscribeAppearanceUpdated = window.widgetsApi.onAppearanceUpdated((appearance) => {
    applyAppearance(appearance);
  });
}

function button(label, className, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className || 'button';
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function iconButton(symbol, title, className, onClick) {
  const element = button(symbol, className || 'icon-button', onClick);
  element.title = title;
  element.setAttribute('aria-label', title);
  return element;
}

function chromeTitle(title, actions = []) {
  const bar = document.createElement('header');
  bar.className = 'chrome';

  const heading = document.createElement('div');
  heading.className = 'chrome-title';
  heading.textContent = title;

  const controls = document.createElement('div');
  controls.className = 'chrome-actions';
  actions.forEach((action) => controls.append(action));

  bar.append(heading, controls);
  return bar;
}

function saveCollapsedTodoGroups() {
  localStorage.setItem('todo:collapsedGroups', JSON.stringify([...collapsedTodoGroups]));
}

function pruneCollapsedTodoGroups(rootGroup) {
  const validGroupIds = new Set();
  const collect = (group) => {
    if (!group) {
      return;
    }

    validGroupIds.add(group.id);
    group.groups.forEach(collect);
  };
  collect(rootGroup);

  let changed = false;
  for (const groupId of collapsedTodoGroups) {
    if (!validGroupIds.has(groupId)) {
      collapsedTodoGroups.delete(groupId);
      changed = true;
    }
  }

  if (changed) {
    saveCollapsedTodoGroups();
  }
}

function createRangeSetting(labelText, value, min, max, suffix, onInput) {
  const row = document.createElement('label');
  row.className = 'range-row';

  const header = document.createElement('span');
  header.className = 'range-label';

  const name = document.createElement('span');
  name.textContent = labelText;

  const output = document.createElement('span');
  output.textContent = `${value}${suffix}`;

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.addEventListener('input', () => {
    output.textContent = `${input.value}${suffix}`;
    onInput(Number(input.value));
  });

  header.append(name, output);
  row.append(header, input);
  return row;
}

function createAppearancePanel(appearance) {
  const panel = document.createElement('section');
  panel.className = 'appearance-panel';

  const title = document.createElement('div');
  title.className = 'appearance-title';
  title.textContent = 'Background';

  const preview = document.createElement('div');
  preview.className = 'appearance-preview';

  const draft = { ...appearance };
  const updateDraft = (key, value) => {
    draft[key] = value;
    applyAppearance(draft);
    preview.style.background = getAppearanceCssColor(draft);

    clearTimeout(appearanceSaveTimer);
    appearanceSaveTimer = setTimeout(() => {
      window.widgetsApi.setAppearance({ ...draft });
    }, 120);
  };

  preview.style.background = getAppearanceCssColor(draft);

  panel.append(
    title,
    preview,
    createRangeSetting('Hue', draft.backgroundHue, 0, 360, '', (value) => updateDraft('backgroundHue', value)),
    createRangeSetting('Saturation', draft.backgroundSaturation, 0, 100, '%', (value) => updateDraft('backgroundSaturation', value)),
    createRangeSetting('Brightness', draft.backgroundBrightness, 0, 100, '%', (value) => updateDraft('backgroundBrightness', value)),
    createRangeSetting('Opacity', draft.backgroundOpacity, 0, 100, '%', (value) => updateDraft('backgroundOpacity', value))
  );

  return panel;
}

function getAppearanceCssColor(appearance) {
  const color = hsbToRgb(
    appearance.backgroundHue,
    appearance.backgroundSaturation,
    appearance.backgroundBrightness
  );
  const opacity = Math.max(0, Math.min(100, Number(appearance.backgroundOpacity))) / 100;
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${opacity})`;
}

async function renderMenu() {
  const data = await window.widgetsApi.getMenuData();
  applyAppearance(data.appearance);
  ensureAppearanceSubscription();

  appRoot.className = 'shell menu-shell';
  appRoot.replaceChildren();

  const autostart = document.createElement('label');
  autostart.className = 'toggle-row';

  const autostartInput = document.createElement('input');
  autostartInput.type = 'checkbox';
  autostartInput.checked = data.autostart;
  autostartInput.addEventListener('change', async () => {
    autostartInput.checked = await window.widgetsApi.setAutostart(autostartInput.checked);
  });

  const autostartText = document.createElement('span');
  autostartText.textContent = 'Run on startup';
  autostart.append(autostartInput, autostartText);

  const list = document.createElement('section');
  list.className = 'widget-list';

  data.widgets.forEach((widget) => {
    const row = document.createElement('article');
    row.className = 'widget-row';

    const text = document.createElement('div');

    const title = document.createElement('h2');
    title.textContent = widget.title;

    const status = document.createElement('p');
    status.textContent = widget.state.docked ? 'In Docker' : widget.state.open ? 'Open' : 'Closed';

    const controls = document.createElement('div');
    controls.className = 'row-actions';

    const open = button('Open', 'button', async () => {
      await window.widgetsApi.openWidget(widget.id);
      renderMenu();
    });

    const pin = button(widget.state.alwaysOnTop ? 'Unpin' : 'Pin', 'button secondary', async () => {
      await window.widgetsApi.setAlwaysOnTop(widget.id, !widget.state.alwaysOnTop);
      renderMenu();
    });

    const close = button('Close', 'button secondary', async () => {
      await window.widgetsApi.closeWidget(widget.id);
      renderMenu();
    });

    text.append(title, status);
    controls.append(open, pin, close);
    row.append(text, controls);
    list.append(row);
  });

  const content = document.createElement('section');
  content.className = 'menu-content';
  content.append(autostart, createAppearancePanel(data.appearance), list);

  appRoot.append(
    chromeTitle('Widgets', [
      iconButton('−', 'Minimize', 'icon-button', () => window.widgetsApi.minimizeCurrentWindow()),
      iconButton('×', 'Close', 'icon-button', () => window.widgetsApi.closeCurrentWindow())
    ]),
    content
  );

  await window.widgetsApi.rendererReady();
}

function renderWidgetBody(widget) {
  if (widget.id === 'todo') {
    return renderTodoWidgetBody();
  }

  if (widget.id === 'devices') {
    return renderDevicesWidgetBody();
  }

  if (widget.id === 'spotify-lite') {
    return renderSpotifyLiteWidgetBody();
  }

  const content = document.createElement('section');
  content.className = 'widget-content';

  const value = document.createElement('div');
  value.className = 'widget-value';

  const caption = document.createElement('p');

  if (widget.id === 'clock') {
    content.classList.add('clock-content');
    value.classList.add('clock-value');
    caption.classList.add('clock-date');
    startClockTicker(value, caption);
  } else if (widget.id === 'notes') {
    value.textContent = 'Notes';
    caption.textContent = 'Placeholder for your own widget renderer.';
  } else {
    value.textContent = 'System';
    caption.textContent = `${navigator.platform}`;
  }

  content.append(value, caption);
  return content;
}

function renderSpotifyLiteWidgetBody(options = {}) {
  const desktopMode = Boolean(options.desktopMode);
  const content = document.createElement('section');
  content.className = 'spotify-lite-content';
  content.classList.toggle('spotify-desktop-content', desktopMode);
  let artworkExpanded = appRoot.classList.contains('spotify-lite-expanded');

  const artworkFrame = document.createElement('div');
  artworkFrame.className = 'spotify-artwork-frame';

  const artworkPlaceholder = document.createElement('span');
  artworkPlaceholder.className = 'spotify-artwork-placeholder';
  artworkPlaceholder.textContent = '♪';

  const artwork = document.createElement('img');
  artwork.className = 'spotify-artwork';
  artwork.alt = '';
  artwork.addEventListener('error', () => artwork.classList.remove('is-visible'));
  artwork.addEventListener('load', () => artwork.classList.add('is-visible'));

  const artworkToggle = button('', 'spotify-artwork-toggle', async (event) => {
    artworkToggle.disabled = true;
    try {
      const result = await window.widgetsApi.setSpotifyLiteExpanded(!artworkExpanded);
      setArtworkExpanded(Boolean(result?.expanded));
    } catch (error) {
      status.textContent = error.message || 'Не удалось изменить размер обложки';
      status.title = status.textContent;
      status.hidden = false;
      setFooterVisibility(true);
    } finally {
      artworkToggle.disabled = false;
      if (event.detail > 0) {
        artworkToggle.blur();
      }
    }
  });
  artworkToggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path></path></svg>';
  artworkFrame.append(artworkPlaceholder, artwork, artworkToggle);

  function setArtworkExpanded(expanded) {
    artworkExpanded = expanded;
    appRoot.classList.toggle('spotify-lite-expanded', expanded);
    artworkToggle.title = expanded ? 'Свернуть обложку' : 'Развернуть обложку';
    artworkToggle.setAttribute('aria-label', artworkToggle.title);
    artworkToggle.querySelector('path').setAttribute(
      'd',
      expanded ? 'M5 9.5 12 16l7-6.5-1.6-1.7L12 12.9 6.6 7.8 5 9.5Z' : 'M5 14.5 12 8l7 6.5-1.6 1.7L12 11.1l-5.4 5.1L5 14.5Z'
    );
  }

  setArtworkExpanded(artworkExpanded);

  const titleViewport = document.createElement('div');
  titleViewport.className = 'spotify-marquee spotify-track-title';
  const title = document.createElement('span');
  title.textContent = 'Ничего не играет';
  titleViewport.append(title);

  const artistViewport = document.createElement('div');
  artistViewport.className = 'spotify-marquee spotify-track-artist';
  const artist = document.createElement('span');
  artist.textContent = 'Откройте Spotify и включите трек';
  artistViewport.append(artist);

  const metadata = document.createElement('div');
  metadata.className = 'spotify-metadata';
  metadata.append(titleViewport, artistViewport);

  const mediaRow = document.createElement('div');
  mediaRow.className = 'spotify-media-row';
  mediaRow.append(artworkFrame, metadata);

  const elapsed = document.createElement('span');
  elapsed.className = 'spotify-time';
  elapsed.textContent = '0:00';

  const duration = button('0:00', 'spotify-time spotify-duration-toggle', () => {
    showRemaining = !showRemaining;
    updateProgress();
  });
  duration.title = 'Переключить длительность / оставшееся время';
  duration.setAttribute('aria-label', duration.title);

  const timeRow = document.createElement('div');
  timeRow.className = 'spotify-time-row';
  timeRow.append(elapsed, duration);

  const progress = document.createElement('div');
  progress.className = 'spotify-progress';
  progress.tabIndex = 0;
  progress.setAttribute('role', 'slider');
  progress.setAttribute('aria-label', 'Позиция воспроизведения');
  progress.setAttribute('aria-valuemin', '0');
  const progressFill = document.createElement('span');
  progressFill.className = 'spotify-progress-fill';
  const progressThumb = document.createElement('span');
  progressThumb.className = 'spotify-progress-thumb';
  progress.append(progressFill, progressThumb);

  const playbackInfo = document.createElement('div');
  playbackInfo.className = 'spotify-playback-info';
  playbackInfo.append(mediaRow, timeRow, progress);

  const previous = createSpotifyMediaButton('previous', 'Предыдущий трек', 'M4 4h3v16H4V4Zm4 8 12 8V4L8 12Z');
  const playPause = createSpotifyMediaButton('play-pause', 'Воспроизвести', 'M7 4v16l13-8L7 4Z', true);
  const next = createSpotifyMediaButton('next', 'Следующий трек', 'M4 4v16l12-8L4 4Zm13 0h3v16h-3V4Z');

  const controls = document.createElement('div');
  controls.className = 'spotify-controls';
  controls.append(previous, playPause, next);

  const status = document.createElement('span');
  status.className = 'spotify-status';
  status.textContent = 'Подключение…';

  const connect = button('Подключить', 'spotify-connect-button', async () => {
    connect.disabled = true;
    try {
      const nextState = spotifyState?.authenticated
        ? await window.widgetsApi.refreshSpotifyLite()
        : await window.widgetsApi.connectSpotifyLite();
      applyState(nextState);
    } catch (error) {
      status.textContent = error.message || 'Не удалось подключить Spotify';
      status.title = status.textContent;
      status.hidden = false;
      setFooterVisibility(true);
    } finally {
      connect.disabled = false;
    }
  });

  const dashboard = button('Dashboard', 'spotify-connect-button', () => {
    void window.widgetsApi.openSpotifyDashboard();
  });
  dashboard.hidden = true;

  const footerActions = document.createElement('div');
  footerActions.className = 'spotify-footer-actions';
  footerActions.append(dashboard, connect);

  const footer = document.createElement('div');
  footer.className = 'spotify-footer';
  footer.append(status, footerActions);
  footer.hidden = true;

  content.append(playbackInfo, controls, footer);

  let spotifyState = null;
  let showRemaining = false;
  let seekDrag = null;
  let pendingSeek = null;
  let seekRequestId = 0;
  let footerIsVisible = false;

  function setFooterVisibility(visible) {
    const nextVisible = !desktopMode && Boolean(visible);
    footer.hidden = !nextVisible;

    if (footerIsVisible === nextVisible) {
      return;
    }

    footerIsVisible = nextVisible;
    void window.widgetsApi.setSpotifyLiteFooterVisible(nextVisible).catch(() => {});
  }

  function getSeekPosition(event) {
    const durationMs = Math.max(0, Number(spotifyState?.current?.durationMs) || 0);
    const bounds = progress.getBoundingClientRect();

    if (!durationMs || !bounds.width) {
      return 0;
    }

    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    return Math.round(durationMs * ratio);
  }

  function cancelSeekDrag(pointerId = null) {
    if (!seekDrag || (pointerId !== null && seekDrag.pointerId !== pointerId)) {
      return;
    }

    if (progress.hasPointerCapture(seekDrag.pointerId)) {
      progress.releasePointerCapture(seekDrag.pointerId);
    }

    seekDrag = null;
    progress.classList.remove('is-seeking');
    updateProgress();
  }

  async function commitSeek(positionMs, trackId) {
    const requestId = ++seekRequestId;
    pendingSeek = { requestId, positionMs, trackId };
    updateProgress();

    try {
      const nextState = await window.widgetsApi.seekSpotifyLite(positionMs);
      if (requestId === seekRequestId) {
        applyState(nextState);
      }
    } catch (error) {
      if (requestId === seekRequestId) {
        status.textContent = error.message || 'Не удалось перемотать трек';
        status.title = status.textContent;
        status.hidden = false;
        setFooterVisibility(true);
      }
    } finally {
      if (pendingSeek?.requestId === requestId) {
        pendingSeek = null;
        updateProgress();
      }
    }
  }

  progress.addEventListener('pointerdown', (event) => {
    const current = spotifyState?.current;
    if (event.button !== 0 || !current?.durationMs) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    seekDrag = {
      pointerId: event.pointerId,
      trackId: current.id,
      positionMs: getSeekPosition(event)
    };
    progress.setPointerCapture(event.pointerId);
    progress.classList.add('is-seeking');
    updateProgress();
  });

  progress.addEventListener('pointermove', (event) => {
    if (!seekDrag || seekDrag.pointerId !== event.pointerId) {
      return;
    }

    seekDrag.positionMs = getSeekPosition(event);
    updateProgress();
  });

  progress.addEventListener('pointerup', (event) => {
    if (!seekDrag || seekDrag.pointerId !== event.pointerId) {
      return;
    }

    seekDrag.positionMs = getSeekPosition(event);
    const { positionMs, trackId } = seekDrag;
    cancelSeekDrag(event.pointerId);

    if (spotifyState?.current?.id === trackId) {
      void commitSeek(positionMs, trackId);
    }
  });

  progress.addEventListener('pointercancel', (event) => cancelSeekDrag(event.pointerId));

  function applyState(nextState) {
    if (!nextState) {
      return;
    }

    const previousTrackId = spotifyState?.current?.id || null;
    spotifyState = nextState;
    const current = nextState.current;
    const currentTrackId = current?.id || null;

    if (previousTrackId !== currentTrackId) {
      cancelSeekDrag();
      pendingSeek = null;
    }
    const registrationRequired = nextState.status === 'registration-required';
    title.textContent = current?.title
      || (registrationRequired
        ? 'Аккаунт не добавлен'
        : nextState.status === 'loading'
          ? 'Загрузка…'
          : 'Ничего не играет');
    artist.textContent = current?.artist
      || (registrationRequired
        ? 'Settings → Users Management'
        : nextState.authenticated
          ? 'Spotify'
          : 'Подключите аккаунт Spotify');
    const rawMessage = nextState.message || '';
    const visibleMessage = /^Кэш \d+ назад · \d+ вперёд$/u.test(rawMessage)
      ? ''
      : rawMessage;
    status.textContent = visibleMessage;
    status.title = status.textContent;

    const artworkSource = current?.artworkDataUrl || current?.artworkUrl || '';
    if (artworkSource && artwork.src !== artworkSource) {
      artwork.classList.remove('is-visible');
      artwork.src = artworkSource;
    } else if (!artworkSource) {
      artwork.removeAttribute('src');
      artwork.classList.remove('is-visible');
    }

    updatePlayPauseIcon(playPause, Boolean(nextState.isPlaying));

    const needsAction = !nextState.authenticated
      || nextState.status === 'error'
      || nextState.status === 'stale'
      || registrationRequired;
    connect.hidden = !needsAction;
    connect.textContent = registrationRequired
      ? 'Проверить'
      : nextState.authenticated
        ? 'Повторить'
        : 'Подключить';
    dashboard.hidden = !registrationRequired;
    status.hidden = !visibleMessage;
    setFooterVisibility(Boolean(visibleMessage || needsAction));

    restartSpotifyMarquee(titleViewport, title);
    restartSpotifyMarquee(artistViewport, artist);
    updateProgress();
  }

  function updateProgress() {
    const current = spotifyState?.current;
    const total = Math.max(0, Number(current?.durationMs) || 0);
    let position = Math.max(0, Number(spotifyState?.progressMs) || 0);

    if (seekDrag?.trackId === current?.id) {
      position = seekDrag.positionMs;
    } else if (pendingSeek?.trackId === current?.id) {
      position = pendingSeek.positionMs;
    } else if (spotifyState?.isPlaying) {
      position += Math.max(0, Date.now() - Number(spotifyState.capturedAt || Date.now()));
    }

    position = Math.min(total || position, position);
    const progressPercent = total ? Math.min(100, (position / total) * 100) : 0;
    elapsed.textContent = formatSpotifyTime(position);
    duration.textContent = showRemaining
      ? `−${formatSpotifyTime(Math.max(0, total - position))}`
      : formatSpotifyTime(total);
    progressFill.style.width = `${progressPercent}%`;
    progressThumb.style.left = `${progressPercent}%`;
    progress.classList.toggle('is-enabled', total > 0);
    progress.setAttribute('aria-disabled', String(total <= 0));
    progress.setAttribute('aria-valuemax', String(total));
    progress.setAttribute('aria-valuenow', String(Math.round(position)));
    progress.setAttribute('aria-valuetext', `${formatSpotifyTime(position)} из ${formatSpotifyTime(total)}`);
  }

  unsubscribeSpotifyLiteUpdated?.();
  unsubscribeSpotifyLiteUpdated = window.widgetsApi.onSpotifyLiteStateUpdated(applyState);
  window.addEventListener('beforeunload', () => unsubscribeSpotifyLiteUpdated?.(), { once: true });
  clearInterval(spotifyProgressTimer);
  spotifyProgressTimer = setInterval(updateProgress, 250);
  window.addEventListener('beforeunload', () => {
    clearInterval(spotifyProgressTimer);
    spotifyProgressTimer = null;
  }, { once: true });
  void window.widgetsApi.getSpotifyLiteState().then(applyState);
  return content;
}

function createSpotifyMediaButton(command, title, iconPath, primary = false) {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = `spotify-media-button${primary ? ' primary' : ''}`;
  control.title = title;
  control.setAttribute('aria-label', title);
  control.dataset.command = command;
  control.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPath}"></path></svg>`;
  control.addEventListener('click', async () => {
    await window.widgetsApi.sendSpotifyLiteMediaCommand(command);
  });
  return control;
}

function updatePlayPauseIcon(control, isPlaying) {
  const path = control.querySelector('path');
  path.setAttribute('d', isPlaying ? 'M6 4h5v16H6V4Zm7 0h5v16h-5V4Z' : 'M7 4v16l13-8L7 4Z');
  control.title = isPlaying ? 'Пауза' : 'Воспроизвести';
  control.setAttribute('aria-label', control.title);
}

function restartSpotifyMarquee(viewport, text) {
  text.classList.remove('is-scrolling');
  text.style.removeProperty('--spotify-marquee-distance');
  text.style.removeProperty('--spotify-marquee-duration');

  requestAnimationFrame(() => {
    const overflow = Math.ceil(text.scrollWidth - viewport.clientWidth);
    if (overflow <= 2) {
      return;
    }

    text.style.setProperty('--spotify-marquee-distance', `${-overflow}px`);
    text.style.setProperty('--spotify-marquee-duration', `${Math.max(5, 3.2 + overflow / 28)}s`);
    text.classList.add('is-scrolling');
  });
}

function formatSpotifyTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function batteryStatusClass(device) {
  if (!device.connected || device.batteryPercent === null) {
    return 'unknown';
  }

  if (device.batteryPercent <= 10) {
    return 'critical';
  }

  if (device.batteryPercent <= 35) {
    return 'low';
  }

  if (device.batteryPercent <= 70) {
    return 'medium';
  }

  return 'full';
}

function createBatteryIcon(device) {
  const icon = document.createElement('div');
  icon.className = `device-battery-icon ${batteryStatusClass(device)}`;
  icon.setAttribute('aria-hidden', 'true');

  const fill = document.createElement('span');
  const percent = device.batteryPercent === null ? 0 : device.batteryPercent;
  fill.style.width = `${Math.max(8, Math.min(100, percent))}%`;

  icon.append(fill);
  return icon;
}

function createDeviceTile(device) {
  const tile = document.createElement('article');
  tile.className = 'device-tile';
  tile.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void window.widgetsApi.openDeviceMenu(device.id);
  });

  if (!device.connected) {
    tile.classList.add('is-offline');
  }

  const name = document.createElement('div');
  name.className = 'device-name';
  name.textContent = device.name;

  const battery = document.createElement('div');
  battery.className = 'device-battery';

  const percent = document.createElement('div');
  percent.className = 'device-percent';
  percent.textContent = device.connected
    ? (device.batteryPercent === null ? '--%' : `${device.batteryPercent}%`)
    : 'offline';

  battery.append(createBatteryIcon(device));
  tile.append(name, battery, percent);
  return tile;
}

function renderDevicesEmpty(message = 'Add a device') {
  const empty = document.createElement('div');
  empty.className = 'devices-empty';
  empty.textContent = message;
  return empty;
}

async function refreshDevicesWidget() {
  if (widgetId !== 'devices') {
    return;
  }

  const body = await renderDevicesWidgetBody();
  replaceWidgetBody(body);
}

async function forceRefreshDevicesWidget() {
  if (widgetId !== 'devices') {
    return;
  }

  const data = await window.widgetsApi.refreshDevicesData();
  replaceWidgetBody(renderDevicesWidgetData(data));
}

function scheduleDevicesPolling() {
  clearInterval(devicesPollTimer);

  if (widgetId !== 'devices') {
    return;
  }

  devicesPollTimer = setInterval(() => {
    void refreshDevicesWidget();
  }, devicesPollMs);
}

function ensureObservedDevicesSubscription() {
  if (unsubscribeObservedDevicesUpdated || widgetId !== 'devices') {
    return;
  }

  unsubscribeObservedDevicesUpdated = window.widgetsApi.onObservedDevicesUpdated((data) => {
    replaceWidgetBody(renderDevicesWidgetData(data));
  });
}

function renderDevicesWidgetData(data) {
  const content = document.createElement('section');
  content.className = 'devices-content';

  if (data.error && !data.observedDevices.length) {
    content.append(renderDevicesEmpty(data.error));
    return content;
  }

  if (!data.observedDevices.length) {
    content.append(renderDevicesEmpty('Press + to add a device'));
    return content;
  }

  const grid = document.createElement('div');
  grid.className = 'devices-grid';
  data.observedDevices.forEach((device) => grid.append(createDeviceTile(device)));
  content.append(grid);
  return content;
}

function renderDevicesFromWidgetState(widgetState) {
  const observedDevices = Array.isArray(widgetState?.observedDevices)
    ? widgetState.observedDevices
    : [];

  return renderDevicesWidgetData({
    observedDevices,
    error: null
  });
}

async function renderDevicesWidgetBody() {
  const data = await window.widgetsApi.getDevicesData();
  return renderDevicesWidgetData(data);
}

function todoTaskCountText(count) {
  if (count === 1) {
    return '1 task';
  }

  return `${count} tasks`;
}

function countGroupTasks(group) {
  return group.tasks.length + group.groups.reduce((total, child) => total + countGroupTasks(child), 0);
}

function createTodoTask(task) {
  const item = document.createElement('div');
  item.className = 'todo-task';
  item.textContent = task.title;
  item.draggable = true;
  item.dataset.taskId = task.id;
  let suppressClickAfterDrag = false;

  item.addEventListener('click', async () => {
    if (suppressClickAfterDrag) {
      suppressClickAfterDrag = false;
      return;
    }

    try {
      await window.widgetsApi.openTodoTaskEditor(task.id);
    } catch (error) {
      window.alert(error.message || 'Не удалось открыть описание дела.');
    }
  });

  item.addEventListener('contextmenu', async (event) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      await window.widgetsApi.openTodoTaskMenu(task.id);
    } catch (error) {
      window.alert(error.message || 'Не удалось открыть меню дела.');
    }
  });

  item.addEventListener('dragstart', (event) => {
    suppressClickAfterDrag = true;
    draggedTodoTaskId = task.id;
    item.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', task.id);
  });

  item.addEventListener('dragend', () => {
    draggedTodoTaskId = null;
    item.classList.remove('is-dragging');
    document
      .querySelectorAll('.todo-drop-target')
      .forEach((element) => element.classList.remove('todo-drop-target'));
  });

  item.addEventListener('mousedown', () => {
    if (!draggedTodoTaskId) {
      suppressClickAfterDrag = false;
    }
  });

  return item;
}

function getDraggedTodoTaskId(event) {
  return draggedTodoTaskId || event.dataTransfer.getData('text/plain');
}

function attachTodoDropTarget(element, group, highlightTarget = null) {
  element.addEventListener('dragover', (event) => {
    if (!getDraggedTodoTaskId(event)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    if (highlightTarget) {
      highlightTarget.classList.add('todo-drop-target');
    }
  });

  element.addEventListener('dragleave', (event) => {
    if (highlightTarget && !element.contains(event.relatedTarget)) {
      highlightTarget.classList.remove('todo-drop-target');
    }
  });

  element.addEventListener('drop', async (event) => {
    const taskId = getDraggedTodoTaskId(event);

    if (!taskId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (highlightTarget) {
      highlightTarget.classList.remove('todo-drop-target');
    }

    try {
      const tree = await window.widgetsApi.moveTodoTask(taskId, group.id);
      replaceWidgetBody(renderTodoWidgetTree(tree));
    } catch (error) {
      window.alert(error.message || 'Unable to move todo task.');
    }
  });
}

function setTodoGroupCollapsed(nested, collapsed, animated = true) {
  if (!animated) {
    nested.classList.toggle('is-collapsed', collapsed);
    nested.style.maxHeight = collapsed ? '0px' : '';
    return;
  }

  if (collapsed) {
    nested.style.maxHeight = `${nested.scrollHeight}px`;
    nested.getBoundingClientRect();
    window.requestAnimationFrame(() => {
      nested.classList.add('is-collapsed');
      nested.style.maxHeight = '0px';
    });
    return;
  }

  nested.classList.remove('is-collapsed');
  nested.style.maxHeight = `${nested.scrollHeight}px`;

  window.setTimeout(() => {
    if (!nested.classList.contains('is-collapsed')) {
      nested.style.maxHeight = '';
    }
  }, todoGroupAnimationMs);
}

function createTodoGroup(group, isRoot = false) {
  const groupElement = document.createElement('section');
  groupElement.className = isRoot ? 'todo-group todo-root-group' : 'todo-group';
  groupElement.dataset.groupId = group.id;

  const isCollapsed = !isRoot && collapsedTodoGroups.has(group.id);
  const nested = document.createElement('div');
  nested.className = 'todo-group-content';
  let groupDropHighlight = null;

  if (isCollapsed) {
    nested.classList.add('is-collapsed');
    nested.style.maxHeight = '0px';
  }

  if (!isRoot) {
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'todo-group-header';

    const chevron = document.createElement('span');
    chevron.className = 'todo-chevron';
    chevron.textContent = isCollapsed ? '>' : 'v';

    const name = document.createElement('span');
    name.className = 'todo-group-name';
    name.textContent = group.name;

    const count = document.createElement('span');
    count.className = 'todo-count';
    count.textContent = todoTaskCountText(countGroupTasks(group));

    header.append(chevron, name, count);
    groupDropHighlight = header;
    attachTodoDropTarget(header, group, groupDropHighlight);
    header.addEventListener('click', () => {
      const nextCollapsed = !nested.classList.contains('is-collapsed');
      setTodoGroupCollapsed(nested, nextCollapsed);
      chevron.textContent = nextCollapsed ? '>' : 'v';

      if (nextCollapsed) {
        collapsedTodoGroups.add(group.id);
      } else {
        collapsedTodoGroups.delete(group.id);
      }

      saveCollapsedTodoGroups();
    });
    header.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      try {
        await window.widgetsApi.openTodoGroupMenu(group.id);
      } catch (error) {
        window.alert(error.message || 'Не удалось открыть меню раздела.');
      }
    });

    groupElement.append(header);
  }

  attachTodoDropTarget(nested, group, groupDropHighlight);

  if (group.tasks.length) {
    const taskList = document.createElement('div');
    taskList.className = 'todo-task-list';
    group.tasks.forEach((task) => taskList.append(createTodoTask(task)));
    nested.append(taskList);
  }

  group.groups.forEach((childGroup) => {
    nested.append(createTodoGroup(childGroup));
  });

  groupElement.append(nested);
  return groupElement;
}

function renderTodoError(message, rootPath) {
  const content = document.createElement('section');
  content.className = 'todo-content';

  const error = document.createElement('div');
  error.className = 'todo-error';
  error.textContent = message;

  const pathText = document.createElement('p');
  pathText.textContent = rootPath;

  content.append(error, pathText);
  return content;
}

function renderTodoLoading() {
  const content = document.createElement('section');
  content.className = 'todo-content';

  const loading = document.createElement('div');
  loading.className = 'todo-empty';
  loading.textContent = 'Loading tasks...';

  content.append(loading);
  return content;
}

function renderWidgetLoading(message = 'Loading...') {
  const content = document.createElement('section');
  content.className = 'widget-content';

  const loading = document.createElement('div');
  loading.className = 'todo-empty';
  loading.textContent = message;

  content.append(loading);
  return content;
}

function renderTodoWidgetTree(tree) {
  const wrapper = document.createElement('section');
  wrapper.className = 'todo-content';

  if (tree.error || !tree.group) {
    return renderTodoError(tree.error || 'Unable to load todo folder.', tree.rootPath);
  }

  pruneCollapsedTodoGroups(tree.group);

  const summary = document.createElement('div');
  summary.className = 'todo-summary';

  const total = document.createElement('strong');
  total.textContent = todoTaskCountText(tree.totalTasks);

  summary.append(total);

  const treeElement = createTodoGroup(tree.group, true);
  wrapper.append(summary, treeElement);
  return wrapper;
}

async function renderTodoWidgetBody() {
  const tree = await window.widgetsApi.getTodoTree();
  return renderTodoWidgetTree(tree);
}

function replaceWidgetBody(nextBody) {
  const currentBodies = appRoot.querySelectorAll('.widget-content, .todo-content, .devices-content');
  const currentBody = currentBodies[0];

  if (currentBody) {
    currentBody.replaceWith(nextBody);
  } else {
    appRoot.append(nextBody);
  }

  currentBodies.forEach((body, index) => {
    if (index > 0) {
      body.remove();
    }
  });
}

function ensureTodoTreeSubscription() {
  if (unsubscribeTodoTreeUpdated || widgetId !== 'todo') {
    return;
  }

  unsubscribeTodoTreeUpdated = window.widgetsApi.onTodoTreeUpdated((tree) => {
    replaceWidgetBody(renderTodoWidgetTree(tree));
  });
}

function enableWindowDragging(element) {
  let dragState = null;

  element.addEventListener('pointerdown', async (event) => {
    if (event.button !== 0) {
      return;
    }

    const state = {
      pointerId: event.pointerId,
      pointerX: event.screenX,
      pointerY: event.screenY,
      windowX: 0,
      windowY: 0,
      ready: false,
      moving: false
    };
    dragState = state;
    element.setPointerCapture(event.pointerId);

    const [windowX, windowY] = await window.widgetsApi.getCurrentWindowPosition();

    if (dragState === state) {
      state.windowX = windowX;
      state.windowY = windowY;
      state.ready = true;
    }
  });

  element.addEventListener('pointermove', (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId || !dragState.ready) {
      return;
    }

    const offsetX = event.screenX - dragState.pointerX;
    const offsetY = event.screenY - dragState.pointerY;

    if (!dragState.moving && Math.hypot(offsetX, offsetY) < 4) {
      return;
    }

    dragState.moving = true;
    event.preventDefault();
    window.widgetsApi.setCurrentWindowPosition(
      dragState.windowX + offsetX,
      dragState.windowY + offsetY
    );
  });

  const stopWindowDragging = (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }

    dragState = null;
  };

  element.addEventListener('pointerup', stopWindowDragging);
  element.addEventListener('pointercancel', stopWindowDragging);
}

async function renderTodoEditor() {
  let taskId = null;
  const data = await window.widgetsApi.getMenuData();
  applyAppearance(data.appearance);
  ensureAppearanceSubscription();

  appRoot.className = 'shell widget-shell todo-editor-shell';
  appRoot.replaceChildren();

  const editor = document.createElement('textarea');
  editor.className = 'todo-window-editor';
  editor.setAttribute('aria-label', 'Описание дела');
  editor.disabled = true;

  const content = document.createElement('section');
  content.className = 'todo-editor-content';
  content.append(editor);

  let savedDetails = '';
  let savePromise = null;
  let closePromise = null;
  let contentVersion = 0;
  enableWindowDragging(editor);

  const clearEditorContent = (expectedVersion) => {
    if (expectedVersion !== contentVersion) {
      return;
    }

    contentVersion += 1;
    taskId = null;
    savedDetails = '';
    editor.value = '';
    editor.disabled = true;
    editor.setAttribute('aria-label', 'Описание дела');
  };

  const saveDetails = async () => {
    if (editor.disabled || !taskId) {
      return true;
    }

    if (savePromise) {
      const currentSave = savePromise;
      const saved = await currentSave;

      if (savePromise === currentSave) {
        savePromise = null;
      }

      if (!saved) {
        return false;
      }

      return editor.value === savedDetails || saveDetails();
    }

    if (editor.value === savedDetails) {
      return true;
    }

    const details = editor.value;
    editor.classList.add('is-saving');
    savePromise = (async () => {
      try {
        await window.widgetsApi.saveTodoTaskDetails(taskId, details);
        savedDetails = details;
        return true;
      } catch (error) {
        window.alert(error.message || 'Не удалось сохранить описание дела.');
        editor.focus();
        return false;
      } finally {
        editor.classList.remove('is-saving');
      }
    })();

    const saved = await savePromise;
    savePromise = null;
    return saved;
  };

  const closeEditor = () => {
    if (closePromise) {
      return closePromise;
    }

    const version = contentVersion;
    closePromise = (async () => {
      try {
        if (await saveDetails() && version === contentVersion) {
          const closed = await window.widgetsApi.closeTodoTaskEditor();
          if (closed) {
            clearEditorContent(version);
          }
        }
      } finally {
        closePromise = null;
      }
    })();

    return closePromise;
  };

  editor.addEventListener('blur', () => {
    void saveDetails();
  });
  window.addEventListener('blur', () => {
    void closeEditor();
  });
  window.widgetsApi.onTodoEditorCloseRequested(() => {
    void closeEditor();
  });
  window.widgetsApi.onTodoEditorTaskMoved((movedTaskId) => {
    taskId = movedTaskId;
  });
  window.widgetsApi.onTodoEditorTaskDeleted((deletedTaskId) => {
    if (taskId !== deletedTaskId) {
      return;
    }

    contentVersion += 1;
    taskId = null;
    savedDetails = '';
    editor.value = '';
    editor.disabled = true;
  });
  window.widgetsApi.onTodoEditorLoadTask(async (task) => {
    const version = ++contentVersion;

    if (!await saveDetails() || version !== contentVersion) {
      return;
    }

    taskId = task.taskId;
    savedDetails = task.details;
    editor.value = task.details;
    editor.disabled = false;
    editor.setAttribute('aria-label', `Описание дела: ${task.taskTitle}`);
    editor.setSelectionRange(editor.value.length, editor.value.length);
    window.widgetsApi.todoEditorContentReady(task.requestId);
  });
  window.addEventListener('focus', () => {
    if (!editor.disabled) {
      editor.focus();
    }
  });

  appRoot.append(content);

  await window.widgetsApi.rendererReady();
}

async function renderTodoContextMenu() {
  const data = await window.widgetsApi.getMenuData();
  applyAppearance(data.appearance);
  ensureAppearanceSubscription();

  appRoot.className = 'shell widget-shell todo-context-menu-shell';
  appRoot.replaceChildren();

  const content = document.createElement('section');
  content.className = 'todo-context-menu-content';
  let targetId = null;
  let actionPending = false;

  const setActionsDisabled = (disabled) => {
    openButton.disabled = disabled;
    deleteButton.disabled = disabled;
    addButton.disabled = disabled;
  };

  const runAction = async (action) => {
    if (!targetId || actionPending) {
      return;
    }

    actionPending = true;
    setActionsDisabled(true);

    try {
      await action(targetId);
    } catch (error) {
      window.alert(error.message || 'Не удалось выполнить действие.');
      actionPending = false;
      setActionsDisabled(false);
    }
  };

  const openButton = button('Открыть заметку', 'todo-context-action', () => {
    void runAction(async (selectedTaskId) => {
      await window.widgetsApi.closeTodoTaskMenu();
      await window.widgetsApi.openTodoTask(selectedTaskId);
    });
  });

  const deleteButton = button('Удалить', 'todo-context-action danger', () => {
    void runAction(async (selectedTaskId) => {
      await window.widgetsApi.deleteTodoTask(selectedTaskId);
      await window.widgetsApi.closeTodoTaskMenu();
    });
  });

  const addButton = button('Добавить заметку', 'todo-context-action', () => {
    void runAction(async (selectedGroupId) => {
      await window.widgetsApi.closeTodoTaskMenu();
      await window.widgetsApi.openTodoCreateWindow(selectedGroupId);
    });
  });

  content.append(openButton, deleteButton, addButton);
  appRoot.append(content);

  window.widgetsApi.onTodoTaskMenuLoad((target) => {
    targetId = target.id;
    actionPending = false;
    const isGroup = target.kind === 'group';
    openButton.hidden = isGroup;
    deleteButton.hidden = isGroup;
    addButton.hidden = !isGroup;
    setActionsDisabled(false);
    window.widgetsApi.todoTaskMenuContentReady(target.requestId);
  });
  window.addEventListener('blur', () => {
    void window.widgetsApi.closeTodoTaskMenu();
  });
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  await window.widgetsApi.rendererReady();
}

async function renderDevicesContextMenu() {
  const data = await window.widgetsApi.getMenuData();
  applyAppearance(data.appearance);
  ensureAppearanceSubscription();

  appRoot.className = 'shell widget-shell todo-context-menu-shell';
  appRoot.replaceChildren();

  const content = document.createElement('section');
  content.className = 'todo-context-menu-content';
  let targetId = null;
  let actionPending = false;

  const removeButton = button('Удалить', 'todo-context-action danger', async () => {
    if (!targetId || actionPending) {
      return;
    }

    actionPending = true;
    removeButton.disabled = true;

    try {
      await window.widgetsApi.removeObservedDevice(targetId);
      await window.widgetsApi.closeDeviceMenu();
    } catch (error) {
      window.alert(error.message || 'Не удалось удалить устройство.');
      actionPending = false;
      removeButton.disabled = false;
    }
  });

  content.append(removeButton);
  appRoot.append(content);

  window.widgetsApi.onDeviceMenuLoad((target) => {
    targetId = target.id;
    actionPending = false;
    removeButton.disabled = false;
    window.widgetsApi.deviceMenuContentReady(target.requestId);
  });
  window.addEventListener('blur', () => {
    void window.widgetsApi.closeDeviceMenu();
  });
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  await window.widgetsApi.rendererReady();
}

function createDevicePickerList(data) {
  const content = document.createElement('section');
  content.className = 'devices-picker-window-content';

  const observedIds = new Set(data.observedDevices.map((device) => device.id));
  const observedContainers = new Set(
    data.observedDevices
      .map((device) => device.containerId)
      .filter(Boolean)
  );
  const availableDevices = data.availableDevices.filter((device) => (
    !observedIds.has(device.id)
    && (!device.containerId || !observedContainers.has(device.containerId))
  ));

  if (data.error) {
    const error = document.createElement('div');
    error.className = 'devices-picker-message';
    error.textContent = data.error;
    content.append(error);
    return content;
  }

  if (!availableDevices.length) {
    const empty = document.createElement('div');
    empty.className = 'devices-picker-message';
    empty.textContent = 'No devices to add';
    content.append(empty);
    return content;
  }

  availableDevices.forEach((device) => {
    const item = button(device.name, 'devices-picker-item', async () => {
      item.disabled = true;
      try {
        await window.widgetsApi.addObservedDevice(device.id);
        await window.widgetsApi.closeDevicePicker();
      } catch (error) {
        window.alert(error.message || 'Unable to add device.');
        item.disabled = false;
      }
    });

    content.append(item);
  });

  return content;
}

async function renderDevicesPicker() {
  const data = await window.widgetsApi.getMenuData();
  applyAppearance(data.appearance);
  ensureAppearanceSubscription();

  appRoot.className = 'shell widget-shell devices-picker-window-shell';
  appRoot.replaceChildren();

  const loading = document.createElement('section');
  loading.className = 'devices-picker-window-content';

  const loadingMessage = document.createElement('div');
  loadingMessage.className = 'devices-picker-message';
  loadingMessage.textContent = 'Loading devices...';
  loading.append(loadingMessage);
  appRoot.append(loading);
  let contentVersion = 0;

  window.widgetsApi.onDevicePickerLoad(async (target) => {
    const version = ++contentVersion;
    window.widgetsApi.devicePickerContentReady(target.requestId);
    const pickerData = await window.widgetsApi.getDevicePickerData();
    if (version === contentVersion) {
      appRoot.replaceChildren(createDevicePickerList(pickerData));
    }
  });
  window.addEventListener('blur', () => {
    const version = contentVersion;
    void window.widgetsApi.closeDevicePicker().then((closed) => {
      if (closed && version === contentVersion) {
        contentVersion += 1;
        appRoot.replaceChildren(loading);
      }
    });
  });
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  await window.widgetsApi.rendererReady();
}

async function renderTodoCreate() {
  const data = await window.widgetsApi.getMenuData();
  applyAppearance(data.appearance);
  ensureAppearanceSubscription();

  appRoot.className = 'shell widget-shell todo-create-shell';
  appRoot.replaceChildren();

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'todo-create-title';
  titleInput.placeholder = 'Название заметки';
  titleInput.disabled = true;

  const detailsInput = document.createElement('textarea');
  detailsInput.className = 'todo-create-details';
  detailsInput.setAttribute('aria-label', 'Что нужно сделать');
  detailsInput.disabled = true;

  const content = document.createElement('section');
  content.className = 'todo-create-content';
  content.append(titleInput, detailsInput);
  appRoot.append(content);

  let groupId = null;
  let contentVersion = 0;
  let createPromise = null;

  enableWindowDragging(titleInput);
  enableWindowDragging(detailsInput);

  const clearCreateContent = (expectedVersion) => {
    if (expectedVersion !== contentVersion) {
      return;
    }

    contentVersion += 1;
    groupId = null;
    titleInput.value = '';
    detailsInput.value = '';
    titleInput.disabled = true;
    detailsInput.disabled = true;
  };

  const createAndClose = () => {
    if (createPromise) {
      return createPromise;
    }

    const version = contentVersion;
    const targetGroupId = groupId;
    const title = titleInput.value.trim();
    const details = detailsInput.value;

    createPromise = (async () => {
      if (!targetGroupId || !title) {
        if (version === contentVersion) {
          const closed = await window.widgetsApi.closeTodoCreateWindow();
          if (closed) {
            clearCreateContent(version);
          }
        }
        return true;
      }

      titleInput.readOnly = true;
      detailsInput.readOnly = true;
      content.classList.add('is-saving');

      try {
        await window.widgetsApi.createTodoTask(targetGroupId, title, details);

        if (version === contentVersion) {
          const closed = await window.widgetsApi.closeTodoCreateWindow();
          if (closed) {
            clearCreateContent(version);
          }
        }

        return true;
      } catch (error) {
        window.alert(error.message || 'Не удалось создать заметку.');
        titleInput.focus();
        return false;
      } finally {
        titleInput.readOnly = false;
        detailsInput.readOnly = false;
        content.classList.remove('is-saving');
        createPromise = null;
      }
    })();

    return createPromise;
  };

  titleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      detailsInput.focus();
    }
  });
  window.addEventListener('blur', () => {
    void createAndClose();
  });
  window.widgetsApi.onTodoCreateCloseRequested(() => {
    void createAndClose();
  });
  window.widgetsApi.onTodoCreateLoadGroup(async (group) => {
    const version = ++contentVersion;

    if (createPromise) {
      await createPromise;
    }

    if (version !== contentVersion) {
      return;
    }

    groupId = group.groupId;
    titleInput.value = '';
    detailsInput.value = '';
    titleInput.disabled = false;
    detailsInput.disabled = false;
    window.widgetsApi.todoCreateContentReady(group.requestId);
  });
  window.addEventListener('focus', () => {
    if (!titleInput.disabled) {
      titleInput.focus();
    }
  });

  await window.widgetsApi.rendererReady();
}

async function renderClockDesktop() {
  appRoot.className = 'clock-desktop-shell';
  appRoot.replaceChildren();

  const content = document.createElement('section');
  content.className = 'clock-desktop-content';

  const value = document.createElement('time');
  value.className = 'clock-value clock-desktop-value';
  const date = document.createElement('time');
  date.className = 'clock-date clock-desktop-date';
  content.append(value, date);
  appRoot.append(content);
  startClockTicker(value, date);

  installDesktopModePointerGuards('clock');

  await window.widgetsApi.rendererReady();
}

async function renderSpotifyDesktop(expanded) {
  appRoot.className = 'spotify-desktop-shell spotify-lite-shell';
  appRoot.classList.toggle('spotify-lite-expanded', Boolean(expanded));
  appRoot.replaceChildren(renderSpotifyLiteWidgetBody({ desktopMode: true }));

  installDesktopModePointerGuards('spotify-lite');

  await window.widgetsApi.rendererReady();
}

function installDesktopModePointerGuards(widgetId) {
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 2) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void window.widgetsApi.openDesktopWidgetMenu(widgetId);
  });
}

async function renderClockContextMenu() {
  const data = await window.widgetsApi.getMenuData();
  applyAppearance(data.appearance);
  ensureAppearanceSubscription();

  appRoot.className = 'shell widget-shell todo-context-menu-shell';
  appRoot.replaceChildren();

  const content = document.createElement('section');
  content.className = 'todo-context-menu-content';
  const editButton = button('Редактировать', 'todo-context-action', async () => {
    editButton.disabled = true;
    try {
      await window.widgetsApi.editClock();
    } catch (error) {
      window.alert(error.message || 'Не удалось открыть редактирование виджета.');
      editButton.disabled = false;
    }
  });
  content.append(editButton);
  appRoot.append(content);

  window.widgetsApi.onClockMenuLoad((target) => {
    editButton.disabled = false;
    window.widgetsApi.clockMenuContentReady(target.requestId);
  });
  window.addEventListener('blur', () => {
    void window.widgetsApi.closeClockMenu();
  });
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  await window.widgetsApi.rendererReady();
}

async function renderNotesWidget() {
  appRoot.className = 'shell widget-shell notes-shell';
  appRoot.replaceChildren();

  const editor = document.createElement('textarea');
  editor.className = 'todo-window-editor notes-editor';
  editor.setAttribute('aria-label', 'Notes');
  editor.spellcheck = false;
  editor.disabled = true;

  const content = document.createElement('section');
  content.className = 'todo-editor-content notes-content';
  content.append(editor);

  let savedContent = '';
  let savePromise = null;
  let closePromise = null;

  const saveContent = async () => {
    if (editor.disabled) {
      return true;
    }

    if (savePromise) {
      const currentSave = savePromise;
      const saved = await currentSave;
      if (!saved) {
        return false;
      }

      return editor.value === savedContent || saveContent();
    }

    if (editor.value === savedContent) {
      return true;
    }

    const nextContent = editor.value;
    editor.classList.add('is-saving');
    savePromise = (async () => {
      try {
        await window.widgetsApi.saveNotesContent(nextContent);
        savedContent = nextContent;
        return true;
      } catch (error) {
        window.alert(error.message || 'Не удалось сохранить Notes.');
        editor.focus();
        return false;
      } finally {
        editor.classList.remove('is-saving');
      }
    })();

    const saved = await savePromise;
    savePromise = null;
    return saved;
  };

  const closeNotes = () => {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      try {
        if (await saveContent()) {
          await window.widgetsApi.confirmNotesClose();
        }
      } finally {
        closePromise = null;
      }
    })();
    return closePromise;
  };

  const dockButton = iconButton('−', 'Collapse to Docker', 'tool-button icon-tool-button', async () => {
    dockButton.disabled = true;
    closeButton.disabled = true;
    try {
      if (await saveContent()) {
        await window.widgetsApi.dockWidget('notes');
        return;
      }
    } catch (error) {
      window.alert(error.message || 'Не удалось свернуть Notes.');
    }

    dockButton.disabled = false;
    closeButton.disabled = false;
  });

  const closeButton = iconButton('×', 'Close', 'tool-button icon-tool-button danger', () => {
    void closeNotes();
  });

  editor.addEventListener('blur', () => {
    void saveContent();
  });
  window.addEventListener('blur', () => {
    void saveContent();
  });
  window.widgetsApi.onNotesCloseRequested(() => {
    void closeNotes();
  });
  window.addEventListener('focus', () => {
    if (!editor.disabled) {
      editor.focus();
    }
  });

  appRoot.append(chromeTitle('', [dockButton, closeButton]), content);

  try {
    savedContent = await window.widgetsApi.getNotesContent();
    editor.value = savedContent;
    editor.disabled = false;
  } catch (error) {
    editor.placeholder = error.message || 'Не удалось загрузить Notes.';
  }

  await window.widgetsApi.rendererReady();
}

const dockerCellSize = 80;
const dockerGridGap = 10;

function cloneDockerLayout(layout) {
  return Object.fromEntries(Object.entries(layout).map(([id, position]) => [
    id,
    { row: position.row, col: position.col }
  ]));
}

function normalizeDockerGridPosition(position) {
  return {
    row: Math.max(0, Math.floor(Number(position?.row) || 0)),
    col: Math.max(0, Math.floor(Number(position?.col) || 0))
  };
}

function dockerTilesOverlap(first, firstSpan, second, secondSpan) {
  return first.row === second.row
    && first.col < second.col + secondSpan
    && second.col < first.col + firstSpan;
}

function advanceDockerPosition(position, span, columns) {
  const nextCol = position.col + 1;
  return nextCol + span <= columns
    ? { row: position.row, col: nextCol }
    : { row: position.row + 1, col: 0 };
}

function normalizeDockerLayout(widgets, positions, columns) {
  const layout = {};

  widgets.forEach((widget) => {
    const span = Math.min(columns, widget.dockerSpan || 1);
    let position = normalizeDockerGridPosition(positions?.[widget.id]);
    position.col = Math.min(position.col, Math.max(0, columns - span));

    let guard = 0;
    while (widgets.some((candidate) => (
      layout[candidate.id]
      && dockerTilesOverlap(
        position,
        span,
        layout[candidate.id],
        Math.min(columns, candidate.dockerSpan || 1)
      )
    )) && guard < 1000) {
      position = advanceDockerPosition(position, span, columns);
      guard += 1;
    }

    layout[widget.id] = position;
  });

  return layout;
}

function createDockerPreviewLayout(baseLayout, activeId, desiredPosition, widgets, columns) {
  const layout = cloneDockerLayout(baseLayout);
  const spans = Object.fromEntries(widgets.map((widget) => [
    widget.id,
    Math.min(columns, widget.dockerSpan || 1)
  ]));
  const ids = widgets.map((widget) => widget.id);
  layout[activeId] = { ...desiredPosition };
  const fixedIds = new Set([activeId]);
  const queuedIds = new Set();
  const queue = [];
  const positionIndex = (id) => baseLayout[id].row * columns + baseLayout[id].col;
  const enqueue = (id) => {
    if (id === activeId || fixedIds.has(id) || queuedIds.has(id)) {
      return;
    }

    queuedIds.add(id);
    queue.push(id);
    queue.sort((firstId, secondId) => positionIndex(firstId) - positionIndex(secondId));
  };

  ids
    .filter((id) => (
      id !== activeId
      && dockerTilesOverlap(layout[activeId], spans[activeId], layout[id], spans[id])
    ))
    .sort((firstId, secondId) => positionIndex(firstId) - positionIndex(secondId))
    .forEach(enqueue);

  let guard = 0;
  while (queue.length && guard < 1000) {
    const id = queue.shift();
    queuedIds.delete(id);
    let position = advanceDockerPosition(baseLayout[id], spans[id], columns);

    while (
      [...fixedIds].some((fixedId) => dockerTilesOverlap(
        position,
        spans[id],
        layout[fixedId],
        spans[fixedId]
      ))
      && guard < 1000
    ) {
      position = advanceDockerPosition(position, spans[id], columns);
      guard += 1;
    }

    const displacedIds = ids
      .filter((candidateId) => (
        candidateId !== id
        && !fixedIds.has(candidateId)
        && dockerTilesOverlap(position, spans[id], layout[candidateId], spans[candidateId])
      ))
      .sort((firstId, secondId) => positionIndex(firstId) - positionIndex(secondId));

    layout[id] = position;
    fixedIds.add(id);
    displacedIds.forEach(enqueue);
    guard += 1;
  }

  return layout;
}

async function renderDocker() {
  let dockerData = await window.widgetsApi.getDockerData();
  applyAppearance(dockerData.appearance);
  ensureAppearanceSubscription();

  appRoot.className = 'shell docker-shell';
  appRoot.replaceChildren();

  const content = document.createElement('section');
  content.className = 'docker-content';

  const grid = document.createElement('div');
  grid.className = 'docker-grid';
  content.append(grid);
  appRoot.append(content);

  let dockerLayout = {};
  let lastColumnCount = 0;
  let activeDrag = null;
  let dockerSpotifyState = null;

  const getColumnCount = () => Math.max(
    1,
    Math.floor((grid.clientWidth + dockerGridGap) / (dockerCellSize + dockerGridGap))
  );

  const getWidgetSpan = (id, columns = getColumnCount()) => {
    const widget = dockerData.widgets.find((candidate) => candidate.id === id);
    return Math.min(columns, widget?.dockerSpan || 1);
  };

  const applyLayout = (layout, animate = true) => {
    const previousRects = new Map();
    if (animate) {
      grid.querySelectorAll('.docker-widget').forEach((tile) => {
        previousRects.set(tile.dataset.widgetId, tile.getBoundingClientRect());
      });
    }

    const columns = getColumnCount();
    let maximumRow = 2;
    grid.querySelectorAll('.docker-widget').forEach((tile) => {
      const position = layout[tile.dataset.widgetId];
      if (!position) {
        return;
      }

      const span = getWidgetSpan(tile.dataset.widgetId, columns);
      tile.style.gridColumn = `${position.col + 1} / span ${span}`;
      tile.style.gridRow = String(position.row + 1);
      maximumRow = Math.max(maximumRow, position.row);
    });
    grid.style.minHeight = `${(maximumRow + 1) * dockerCellSize + maximumRow * dockerGridGap}px`;

    if (!animate) {
      return;
    }

    grid.getBoundingClientRect();
    grid.querySelectorAll('.docker-widget').forEach((tile) => {
      const previous = previousRects.get(tile.dataset.widgetId);
      if (!previous || activeDrag?.id === tile.dataset.widgetId) {
        return;
      }

      const next = tile.getBoundingClientRect();
      const deltaX = previous.left - next.left;
      const deltaY = previous.top - next.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
        return;
      }

      tile.getAnimations().forEach((animation) => animation.cancel());
      tile.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: 'translate(0, 0)' }
        ],
        { duration: 170, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
      );
    });
  };

  const findCard = (id) => grid.querySelector(`[data-widget-id="${id}"]`);

  const updateClockCard = () => {
    const card = findCard('clock');
    if (!card) {
      return;
    }

    const body = card.querySelector('.docker-card-body');
    let value = body.querySelector('.docker-clock-value');
    if (!value) {
      value = document.createElement('time');
      value.className = 'docker-clock-value';
      body.replaceChildren(value);
    }
    value.textContent = formatClockTime();
  };

  const updateTodoCard = (tree) => {
    const card = findCard('todo');
    if (!card) {
      return;
    }

    const body = card.querySelector('.docker-card-body');
    const count = Number.isFinite(Number(tree?.totalTasks)) ? Number(tree.totalTasks) : null;
    body.replaceChildren();

    const value = document.createElement('strong');
    value.className = 'docker-todo-count';
    value.textContent = count === null ? '—' : String(count);

    const label = document.createElement('span');
    label.className = 'docker-todo-label';
    label.textContent = count === 1 ? 'task' : 'tasks';
    body.append(value, label);
  };

  const updateDevicesCard = (data) => {
    const card = findCard('devices');
    if (!card) {
      return;
    }

    const body = card.querySelector('.docker-card-body');
    const devices = Array.isArray(data?.observedDevices) ? data.observedDevices.slice(0, 3) : [];
    body.replaceChildren();

    if (!devices.length) {
      const empty = document.createElement('span');
      empty.className = 'docker-card-empty';
      empty.textContent = 'No devices';
      body.append(empty);
      return;
    }

    devices.forEach((device) => {
      const row = document.createElement('div');
      row.className = 'docker-device-row';

      const name = document.createElement('span');
      name.textContent = device.name;

      const charge = document.createElement('strong');
      charge.textContent = !device.connected
        ? 'off'
        : device.batteryPercent === null
          ? '--%'
          : `${device.batteryPercent}%`;

      row.append(name, charge);
      body.append(row);
    });
  };

  const updateDockerSpotifyProgress = () => {
    const fill = findCard('spotify-lite')?.querySelector('.docker-spotify-progress-fill');
    if (!fill) {
      return;
    }

    const duration = Math.max(0, Number(dockerSpotifyState?.current?.durationMs) || 0);
    let position = Math.max(0, Number(dockerSpotifyState?.progressMs) || 0);
    if (dockerSpotifyState?.isPlaying) {
      position += Math.max(0, Date.now() - Number(dockerSpotifyState.capturedAt || Date.now()));
    }

    position = Math.min(duration || position, position);
    fill.style.width = `${duration ? Math.min(100, position / duration * 100) : 0}%`;
  };

  const syncDockerSpotifyProgressTimer = () => {
    clearInterval(dockerSpotifyProgressTimer);
    dockerSpotifyProgressTimer = null;
    updateDockerSpotifyProgress();

    if (dockerSpotifyState?.isPlaying) {
      dockerSpotifyProgressTimer = setInterval(updateDockerSpotifyProgress, 250);
    }
  };

  const updateSpotifyCard = (state) => {
    const card = findCard('spotify-lite');
    if (!card) {
      return;
    }

    dockerSpotifyState = state;
    const body = card.querySelector('.docker-card-body');
    card.querySelector('.docker-spotify-progress')?.remove();
    body.replaceChildren();

    const track = document.createElement('strong');
    track.className = 'docker-spotify-track';
    track.textContent = state?.current?.title || 'Nothing playing';

    const artist = document.createElement('span');
    artist.className = 'docker-spotify-artist';
    artist.textContent = state?.current?.artist || 'Spotify';

    const progress = document.createElement('div');
    progress.className = 'docker-spotify-progress';
    progress.setAttribute('aria-hidden', 'true');
    const progressFill = document.createElement('span');
    progressFill.className = 'docker-spotify-progress-fill';
    progress.append(progressFill);

    body.append(track, artist);
    card.append(progress);
    syncDockerSpotifyProgressTimer();
  };

  const hydrateCards = () => {
    const ids = new Set(dockerData.widgets.map((widget) => widget.id));

    clearInterval(dockerDevicesPollTimer);
    dockerDevicesPollTimer = null;
    clearInterval(dockerSpotifyProgressTimer);
    dockerSpotifyProgressTimer = null;
    stopDockerClockTicker?.();
    stopDockerClockTicker = null;

    if (ids.has('clock')) {
      stopDockerClockTicker = startMinuteAlignedUpdates(updateClockCard);
    }

    if (ids.has('todo')) {
      void window.widgetsApi.getTodoTree().then(updateTodoCard).catch(() => updateTodoCard(null));
    }

    if (ids.has('devices')) {
      const storedState = dockerData.widgets.find((widget) => widget.id === 'devices')?.state;
      updateDevicesCard({ observedDevices: storedState?.observedDevices || [] });
      const refresh = () => window.widgetsApi.getDevicesData().then(updateDevicesCard).catch(() => {});
      void refresh();
      dockerDevicesPollTimer = setInterval(() => void refresh(), devicesPollMs);
    }

    if (ids.has('spotify-lite')) {
      void window.widgetsApi.getSpotifyLiteState().then(updateSpotifyCard).catch(() => updateSpotifyCard(null));
    }
  };

  const restoreCard = (id, card) => {
    card.classList.add('is-restoring');
    void window.widgetsApi.restoreDockedWidget(id).catch(() => {
      card.classList.remove('is-restoring');
    });
  };

  const bindCardDragging = (card, widget) => {
    card.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || activeDrag) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const bounds = card.getBoundingClientRect();
      activeDrag = {
        id: widget.id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        grabOffsetX: event.clientX - bounds.left,
        grabOffsetY: event.clientY - bounds.top,
        baseLayout: cloneDockerLayout(dockerLayout),
        dragging: false
      };
      card.setPointerCapture(event.pointerId);
    });

    card.addEventListener('pointermove', (event) => {
      if (!activeDrag || activeDrag.id !== widget.id || activeDrag.pointerId !== event.pointerId) {
        return;
      }

      const distance = Math.hypot(event.clientX - activeDrag.startX, event.clientY - activeDrag.startY);
      if (!activeDrag.dragging && distance < 5) {
        return;
      }

      activeDrag.dragging = true;
      card.classList.add('is-dragging');
      const columns = getColumnCount();
      const span = getWidgetSpan(widget.id, columns);
      const bounds = grid.getBoundingClientRect();
      const left = event.clientX - bounds.left + grid.scrollLeft - activeDrag.grabOffsetX;
      const top = event.clientY - bounds.top + grid.scrollTop - activeDrag.grabOffsetY;
      const desired = {
        row: Math.max(0, Math.round(top / (dockerCellSize + dockerGridGap))),
        col: Math.max(0, Math.min(
          columns - span,
          Math.round(left / (dockerCellSize + dockerGridGap))
        ))
      };

      dockerLayout = createDockerPreviewLayout(
        activeDrag.baseLayout,
        widget.id,
        desired,
        dockerData.widgets,
        columns
      );
      applyLayout(dockerLayout);
    });

    const finishPointer = (event, cancelled) => {
      if (!activeDrag || activeDrag.id !== widget.id || activeDrag.pointerId !== event.pointerId) {
        return;
      }

      const drag = activeDrag;
      activeDrag = null;
      if (card.hasPointerCapture(event.pointerId)) {
        card.releasePointerCapture(event.pointerId);
      }
      card.classList.remove('is-dragging');

      if (cancelled) {
        dockerLayout = drag.baseLayout;
        applyLayout(dockerLayout);
        return;
      }

      if (!drag.dragging) {
        restoreCard(widget.id, card);
        return;
      }

      dockerData.positions = cloneDockerLayout(dockerLayout);
      void window.widgetsApi.setDockerLayout(dockerLayout).catch(() => {
        dockerLayout = drag.baseLayout;
        dockerData.positions = cloneDockerLayout(drag.baseLayout);
        applyLayout(dockerLayout);
      });
    };

    card.addEventListener('pointerup', (event) => finishPointer(event, false));
    card.addEventListener('pointercancel', (event) => finishPointer(event, true));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        restoreCard(widget.id, card);
      }
    });
  };

  const renderCards = (nextData) => {
    activeDrag = null;
    dockerData = nextData;
    grid.replaceChildren();
    const columns = getColumnCount();
    lastColumnCount = columns;
    dockerLayout = normalizeDockerLayout(dockerData.widgets, dockerData.positions, columns);

    dockerData.widgets.forEach((widget) => {
      const card = document.createElement('article');
      card.className = `docker-widget docker-widget-${widget.id}`;
      card.dataset.widgetId = widget.id;
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Restore ${widget.title}`);
      card.title = `Restore ${widget.title}`;

      const title = document.createElement('div');
      title.className = 'docker-card-title';
      title.textContent = widget.title;

      const body = document.createElement('div');
      body.className = 'docker-card-body';

      if (!['clock', 'todo', 'devices', 'spotify-lite'].includes(widget.id)) {
        const label = document.createElement('span');
        label.className = 'docker-generic-label';
        label.textContent = widget.title;
        body.append(label);
      }

      card.append(title, body);
      bindCardDragging(card, widget);
      grid.append(card);
    });

    applyLayout(dockerLayout, false);
    hydrateCards();
  };

  renderCards(dockerData);

  if (!unsubscribeDockerUpdated) {
    unsubscribeDockerUpdated = window.widgetsApi.onDockerStateUpdated((nextData) => {
      applyAppearance(nextData.appearance);
      renderCards(nextData);
    });
  }

  if (!unsubscribeDockerTodoUpdated) {
    unsubscribeDockerTodoUpdated = window.widgetsApi.onTodoTreeUpdated(updateTodoCard);
  }

  if (!unsubscribeDockerDevicesUpdated) {
    unsubscribeDockerDevicesUpdated = window.widgetsApi.onObservedDevicesUpdated(updateDevicesCard);
  }

  if (!unsubscribeDockerSpotifyUpdated) {
    unsubscribeDockerSpotifyUpdated = window.widgetsApi.onSpotifyLiteStateUpdated(updateSpotifyCard);
  }

  const resizeObserver = new ResizeObserver(() => {
    if (activeDrag) {
      return;
    }

    const columns = getColumnCount();
    if (columns === lastColumnCount) {
      return;
    }

    lastColumnCount = columns;
    dockerLayout = normalizeDockerLayout(dockerData.widgets, dockerData.positions, columns);
    applyLayout(dockerLayout);
  });
  resizeObserver.observe(grid);
  window.addEventListener('beforeunload', () => resizeObserver.disconnect(), { once: true });

  await window.widgetsApi.rendererReady();
}

async function renderWidget() {
  const data = await window.widgetsApi.getWidgetData(widgetId);
  applyAppearance(data.appearance);
  ensureAppearanceSubscription();

  if (data.widget.id === 'clock' && data.state.desktopMode) {
    await renderClockDesktop();
    return;
  }

  if (data.widget.id === 'spotify-lite' && data.state.desktopMode) {
    await renderSpotifyDesktop(data.state.expanded);
    return;
  }

  if (data.widget.id === 'notes') {
    await renderNotesWidget();
    return;
  }

  appRoot.className = 'shell widget-shell';
  appRoot.classList.toggle('spotify-lite-shell', data.widget.id === 'spotify-lite');
  appRoot.classList.toggle(
    'spotify-lite-expanded',
    data.widget.id === 'spotify-lite' && Boolean(data.state.expanded)
  );
  appRoot.replaceChildren();

  let pinned = Boolean(data.state.alwaysOnTop);
  const pinButton = iconButton(pinned ? '⌖' : '◇', pinned ? 'Unpin' : 'Pin', 'tool-button icon-tool-button', async () => {
    pinned = !pinned;
    await window.widgetsApi.setAlwaysOnTop(widgetId, pinned);
    pinButton.textContent = pinned ? '⌖' : '◇';
    pinButton.title = pinned ? 'Unpin' : 'Pin';
    pinButton.setAttribute('aria-label', pinned ? 'Unpin' : 'Pin');
  });

  const closeButton = iconButton('×', 'Close', 'tool-button icon-tool-button danger', () => {
    window.widgetsApi.closeWidget(widgetId);
  });

  const dockButton = iconButton('−', 'Collapse to Docker', 'tool-button icon-tool-button', () => {
    dockButton.disabled = true;
    void window.widgetsApi.dockWidget(widgetId).catch(() => {
      dockButton.disabled = false;
    });
  });

  const actions = [dockButton, pinButton, closeButton];

  if (data.widget.id === 'todo') {
    const settingsButton = iconButton(
      '⚙',
      'Choose the Todo folder and optional template',
      'tool-button icon-tool-button',
      async () => {
        settingsButton.disabled = true;

        try {
          const tree = await window.widgetsApi.configureTodo();
          replaceWidgetBody(renderTodoWidgetTree(tree));
        } catch (error) {
          window.alert(error.message || 'Unable to update Todo settings.');
        } finally {
          settingsButton.disabled = false;
        }
      }
    );
    actions.unshift(settingsButton);
  }

  if (data.widget.id === 'clock') {
    const desktopButton = iconButton('◫', 'Show clock only', 'tool-button icon-tool-button', async () => {
      desktopButton.disabled = true;
      try {
        await window.widgetsApi.setClockDesktopMode(true);
        window.location.reload();
      } catch (error) {
        window.alert(error.message || 'Не удалось включить режим часов.');
        desktopButton.disabled = false;
      }
    });
    actions.unshift(desktopButton);
  }

  if (data.widget.id === 'spotify-lite') {
    const desktopButton = iconButton('◫', 'Show player only', 'tool-button icon-tool-button', async () => {
      desktopButton.disabled = true;
      try {
        await window.widgetsApi.setSpotifyLiteDesktopMode(true);
        window.location.reload();
      } catch (error) {
        window.alert(error.message || 'Не удалось включить прозрачный режим Spotify.');
        desktopButton.disabled = false;
      }
    });
    actions.unshift(desktopButton);
  }

  if (data.widget.id === 'devices') {
    const refreshButton = iconButton('↻', 'Refresh devices', 'tool-button icon-tool-button', async () => {
      refreshButton.disabled = true;
      try {
        await forceRefreshDevicesWidget();
      } finally {
        refreshButton.disabled = false;
      }
    });
    const addButton = iconButton('+', 'Add device', 'tool-button icon-tool-button', (event) => {
      event.preventDefault();
      void window.widgetsApi.openDevicePicker();
    });
    actions.unshift(addButton);
    actions.unshift(refreshButton);
    scheduleDevicesPolling();
    ensureObservedDevicesSubscription();
  }

  if (data.widget.id === 'todo') {
    ensureTodoTreeSubscription();
  }

  appRoot.append(
    chromeTitle(data.widget.title, actions),
    data.widget.id === 'devices'
      ? renderDevicesFromWidgetState(data.state)
      : data.widget.id === 'todo'
        ? renderTodoLoading()
        : renderWidgetLoading()
  );

  if (data.widget.id === 'devices') {
    void refreshDevicesWidget();
  } else {
    const body = await renderWidgetBody(data.widget);
    replaceWidgetBody(body);
  }

  await window.widgetsApi.rendererReady();
}

if (view === 'todo-create') {
  renderTodoCreate();
} else if (view === 'devices-picker') {
  renderDevicesPicker();
} else if (view === 'devices-menu') {
  renderDevicesContextMenu();
} else if (view === 'clock-menu') {
  renderClockContextMenu();
} else if (view === 'todo-menu') {
  renderTodoContextMenu();
} else if (view === 'todo-editor') {
  renderTodoEditor();
} else if (view === 'docker') {
  renderDocker();
} else if (view === 'widget' && widgetId) {
  renderWidget();
} else {
  renderMenu();
}
