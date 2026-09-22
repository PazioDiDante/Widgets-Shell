const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const fsp = fs.promises;
const SPOTIFY_API_URL = 'https://api.spotify.com/v1';
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const REQUIRED_SCOPES = 'user-read-playback-state user-read-currently-playing user-modify-playback-state';
const SIDE_CACHE_CAPACITY = 5;
const MEDIA_COMMAND_SETTLE_MS = 1800;
const TRACK_TRANSITION_DELAY_MS = 1500;
const NAVIGATION_REFRESH_DELAY_MS = 250;
const NAVIGATION_RETRY_DELAY_MS = 900;
const NAVIGATION_MAX_ATTEMPTS = 2;
const SPOTIFY_API_TIMEOUT_MS = 15000;
const SPOTIFY_TOKEN_TIMEOUT_MS = 15000;
const SPOTIFY_ARTWORK_TIMEOUT_MS = 12000;
const ARTWORK_CACHE_MAX_ENTRIES = SIDE_CACHE_CAPACITY * 2 + 1;
const ARTWORK_CACHE_MAX_BYTES = 20 * 1024 * 1024;

class SpotifyAuthenticationRequiredError extends Error {}
class SpotifyUserNotRegisteredError extends Error {}
class SpotifyOperationCancelledError extends Error {}
class SpotifyRequestTimeoutError extends Error {}

class SpotifyLiteService {
  constructor({
    tokenFilePath,
    playbackCacheFilePath,
    clientId,
    clientSecret,
    redirectUri = 'http://127.0.0.1:5000/callback',
    openExternal,
    sendMediaKey,
    mediaSessionMonitor = null,
    onStateChanged,
    fetchImpl = global.fetch
  }) {
    this.tokenFilePath = tokenFilePath;
    this.playbackCacheFilePath = playbackCacheFilePath;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.openExternal = openExternal;
    this.sendMediaKey = sendMediaKey;
    this.mediaSessionMonitor = mediaSessionMonitor;
    this.onStateChanged = onStateChanged;
    this.fetch = fetchImpl;

    this.tokens = null;
    this.tokensLoaded = false;
    this.playbackCacheLoaded = false;
    this.playbackCacheLoadPromise = null;
    this.current = null;
    this.previous = [];
    this.upcoming = [];
    this.artworkCache = new Map();
    this.artworkCacheSizes = new Map();
    this.artworkCacheBytes = 0;
    this.artworkRequests = new Map();
    this.trackTransitionTimer = null;
    this.systemMediaRefreshTimer = null;
    this.navigationRefreshTimer = null;
    this.pendingSystemMediaChange = null;
    this.lastTransitionCheckTrackId = null;
    this.refreshPromise = null;
    this.accessTokenRefreshPromise = null;
    this.refreshGeneration = 0;
    this.connectPromise = null;
    this.startPromise = null;
    this.lifecycleGeneration = 0;
    this.oauthSession = null;
    this.activeRequests = new Set();
    this.oauthInProgress = false;
    this.pendingPlaybackCommand = null;
    this.pendingTrackNavigation = null;
    this.active = false;
    this.disposed = false;
    this.state = {
      authenticated: false,
      status: 'disconnected',
      message: 'Подключите Spotify',
      current: null,
      isPlaying: false,
      progressMs: 0,
      capturedAt: Date.now(),
      previousCount: 0,
      upcomingCount: 0
    };
  }

  async start() {
    if (this.disposed) {
      return this.getPublicState();
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.active) {
      if (!this.oauthInProgress) {
        this.startSystemMediaMonitor();
      }
      return this.getPublicState();
    }

    this.active = true;
    const generation = ++this.lifecycleGeneration;
    let startTask;
    startTask = this.startCore(generation).finally(() => {
      if (this.startPromise === startTask) {
        this.startPromise = null;
      }
    });
    this.startPromise = startTask;
    return startTask;
  }

  async startCore(generation) {
    await this.loadPlaybackCache();
    await this.loadTokens();

    if (!this.active || generation !== this.lifecycleGeneration) {
      return this.getPublicState();
    }

    if (!this.tokens?.refreshToken && !this.tokens?.accessToken) {
      this.publish({
        authenticated: false,
        status: 'disconnected',
        message: 'Подключите Spotify'
      });
      return this.getPublicState();
    }

    await this.refreshNow();
    if (this.active && generation === this.lifecycleGeneration) {
      this.startSystemMediaMonitor();
    }
    return this.getPublicState();
  }

  stop() {
    void this.savePlaybackCache();
    this.active = false;
    this.lifecycleGeneration += 1;
    this.refreshGeneration += 1;
    this.startPromise = null;
    this.refreshPromise = null;
    this.pendingPlaybackCommand = null;
    this.pendingTrackNavigation = null;
    this.clearTrackTransitionTimer();
    this.clearSystemMediaRefreshTimer();
    this.clearNavigationRefreshTimer();
    this.cancelAuthorization(new SpotifyOperationCancelledError('Spotify authorization was cancelled.'));
    this.cancelActiveRequests(new SpotifyOperationCancelledError('Spotify operation was cancelled.'));
    this.mediaSessionMonitor?.stop();
  }

  async connect() {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connectCore().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async connectCore() {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Configure your Spotify client ID and secret in settings.local.json, then restart Widgets.');
    }
    const lifecycleGeneration = this.lifecycleGeneration;
    this.oauthInProgress = true;
    this.refreshGeneration += 1;
    this.refreshPromise = null;
    this.cancelActiveRequests(new SpotifyOperationCancelledError('Spotify operation was superseded.'));
    this.clearTrackTransitionTimer();
    this.clearSystemMediaRefreshTimer();
    this.clearNavigationRefreshTimer();
    this.mediaSessionMonitor?.stop();
    this.tokens = null;
    this.tokensLoaded = true;
    this.current = null;
    this.previous = [];
    this.upcoming = [];
    this.pendingPlaybackCommand = null;
    this.pendingTrackNavigation = null;
    await this.clearPlaybackCache();
    await this.saveTokens();
    this.publish({
      authenticated: false,
      status: 'connecting',
      message: 'Войдите в Spotify в браузере',
      current: null,
      isPlaying: false,
      progressMs: 0,
      capturedAt: Date.now()
    });

    try {
      const code = await this.waitForAuthorizationCode();
      await this.exchangeAuthorizationCode(code);
      this.oauthInProgress = false;

      if (!this.active || lifecycleGeneration !== this.lifecycleGeneration) {
        return this.getPublicState();
      }

      await this.refreshNow({ forceQueue: true });
      if (this.active && lifecycleGeneration === this.lifecycleGeneration) {
        this.startSystemMediaMonitor();
      }
      return this.getPublicState();
    } catch (error) {
      this.oauthInProgress = false;

      if (error instanceof SpotifyOperationCancelledError) {
        if (!this.active || lifecycleGeneration !== this.lifecycleGeneration) {
          return this.getPublicState();
        }

        this.publish({
          authenticated: false,
          status: 'disconnected',
          message: 'Подключите Spotify'
        });
        return this.getPublicState();
      }

      this.publish({
        authenticated: Boolean(this.tokens?.accessToken || this.tokens?.refreshToken),
        status: 'error',
        message: this.toFriendlyError(error)
      });
      throw error;
    }
  }

  async getState() {
    await this.loadPlaybackCache();
    await this.loadTokens();
    return this.getPublicState();
  }

  async refreshNow(options = {}) {
    if (this.disposed) {
      return this.getPublicState();
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    const generation = this.refreshGeneration;
    let refreshTask;
    refreshTask = this.refreshCore(options, generation)
      .catch((error) => {
        if (generation !== this.refreshGeneration) {
          return this.getPublicState();
        }

        if (error instanceof SpotifyOperationCancelledError && !this.active) {
          return this.getPublicState();
        }

        if (error instanceof SpotifyAuthenticationRequiredError) {
          this.clearTrackTransitionTimer();
          this.publish({
            authenticated: false,
            status: 'disconnected',
            message: 'Подключите Spotify'
          });
          return this.getPublicState();
        }

        if (error instanceof SpotifyUserNotRegisteredError) {
          this.clearTrackTransitionTimer();
          this.publish({
            authenticated: true,
            status: 'registration-required',
            message: 'Добавьте аккаунт в Dashboard → Users Management'
          });
          return this.getPublicState();
        }

        this.publish({
          status: this.current ? 'stale' : 'error',
          message: this.toFriendlyError(error)
        });
        return this.getPublicState();
      })
      .finally(() => {
        if (this.refreshPromise === refreshTask) {
          this.refreshPromise = null;
        }
      });

    this.refreshPromise = refreshTask;

    return this.refreshPromise;
  }

  async refreshCore({ forceQueue = false } = {}, generation = this.refreshGeneration) {
    await this.loadTokens();
    let response = await this.spotifyGet('/me/player');

    if (generation !== this.refreshGeneration) {
      return this.getPublicState();
    }

    if (response.status === 204 && !this.current) {
      response = await this.spotifyGet('/me/player/currently-playing');

      if (generation !== this.refreshGeneration) {
        return this.getPublicState();
      }
    }

    if (response.status === 204) {
      this.pendingPlaybackCommand = null;
      this.clearTrackTransitionTimer();
      this.publish({
        authenticated: true,
        status: this.current ? 'paused' : 'idle',
        message: '',
        current: this.current,
        isPlaying: false,
        progressMs: this.current ? this.estimatedProgress() : 0,
        capturedAt: Date.now()
      });
      await this.savePlaybackCache();
      return this.getPublicState();
    }

    await this.ensureSuccessfulResponse(response, 'Не удалось получить состояние Spotify');
    const playback = await response.json();

    if (generation !== this.refreshGeneration) {
      return this.getPublicState();
    }

    const apiTrack = parseSpotifyTrack(playback.item);

    if (!apiTrack) {
      this.pendingPlaybackCommand = null;
      this.clearTrackTransitionTimer();
      this.publish({
        authenticated: true,
        status: this.current ? 'paused' : 'idle',
        message: '',
        current: this.current,
        isPlaying: false,
        progressMs: this.current ? this.estimatedProgress() : 0,
        capturedAt: Date.now()
      });
      await this.savePlaybackCache();
      return this.getPublicState();
    }

    const previousEstimatedProgress = this.estimatedProgress();
    const playbackProgress = Math.max(0, Number(playback.progress_ms) || 0);
    const changed = !sameTrack(this.current, apiTrack);
    if (changed) {
      this.lastTransitionCheckTrackId = null;
      const cached = this.findCachedTrack(apiTrack);

      if (this.current) {
        this.pushPrevious(this.current);
      }

      this.current = cached || await this.withArtwork(apiTrack);

      if (generation !== this.refreshGeneration) {
        return this.getPublicState();
      }

      this.removeTrack(this.upcoming, this.current);
      this.removeTrack(this.previous, this.current);
      this.pruneArtworkCache();
    } else {
      if (this.lastTransitionCheckTrackId === apiTrack.id
        && playbackProgress + 5000 < previousEstimatedProgress) {
        this.lastTransitionCheckTrackId = null;
      }

      this.current = {
        ...this.current,
        ...apiTrack,
        artworkDataUrl: this.current?.artworkDataUrl || apiTrack.artworkDataUrl || null
      };
    }

    const isPlaying = this.resolvePlaybackState(Boolean(playback.is_playing), apiTrack);
    if (this.pendingTrackNavigation
      && apiTrack.id !== this.pendingTrackNavigation.fromTrackId) {
      this.pendingTrackNavigation = null;
    }

    this.publish({
      authenticated: true,
      status: isPlaying ? 'playing' : 'paused',
      message: this.cacheMessage(),
      current: this.current,
      isPlaying,
      progressMs: playbackProgress,
      capturedAt: Date.now()
    });
    await this.savePlaybackCache();
    if (this.pendingTrackNavigation) {
      this.clearTrackTransitionTimer();
    } else {
      this.scheduleTrackTransitionRefresh();
    }

    if (forceQueue || changed || this.upcoming.length < SIDE_CACHE_CAPACITY) {
      try {
        await this.refreshQueue(generation);
      } catch (error) {
        this.publish({ message: `Очередь Spotify недоступна · ${this.toFriendlyError(error)}` });
      }
    }

    return this.getPublicState();
  }

  async refreshQueue(generation = this.refreshGeneration) {
    const response = await this.spotifyGet('/me/player/queue');

    if (generation !== this.refreshGeneration) {
      return;
    }

    await this.ensureSuccessfulResponse(response, 'Не удалось получить очередь Spotify');
    const payload = await response.json();
    const candidates = (Array.isArray(payload.queue) ? payload.queue : [])
      .map(parseSpotifyTrack)
      .filter(Boolean)
      .filter((track) => !sameTrack(track, this.current));

    const unique = [];
    for (const track of candidates) {
      if (unique.some((candidate) => sameTrack(candidate, track))) {
        continue;
      }

      unique.push(track);
      if (unique.length === SIDE_CACHE_CAPACITY) {
        break;
      }
    }

    const upcoming = await Promise.all(unique.map((track) => this.withArtwork(track)));

    if (generation !== this.refreshGeneration) {
      return;
    }

    this.upcoming = upcoming;
    this.pruneArtworkCache();
    this.publish({ message: this.cacheMessage() });
  }

  async mediaCommand(command) {
    if (!['previous', 'play-pause', 'next'].includes(command)) {
      throw new Error('Unsupported media command.');
    }

    this.refreshGeneration += 1;
    this.refreshPromise = null;
    this.clearNavigationRefreshTimer();

    const progressBeforeCommand = this.estimatedProgress();
    const expectsTrackChange = command === 'next'
      || (command === 'previous' && progressBeforeCommand <= 3000);

    if (command === 'play-pause') {
      this.pendingPlaybackCommand = {
        expectedIsPlaying: !this.state.isPlaying,
        trackId: this.current?.id || null,
        expiresAt: Date.now() + MEDIA_COMMAND_SETTLE_MS
      };
      if (this.pendingPlaybackCommand.expectedIsPlaying) {
        this.lastTransitionCheckTrackId = null;
      }
    } else {
      this.pendingPlaybackCommand = null;
    }

    this.pendingTrackNavigation = expectsTrackChange
      ? {
        command,
        fromTrackId: this.current?.id || null,
        attempts: 0
      }
      : null;

    this.applyOptimisticMediaCommand(command);

    try {
      await this.sendMediaKey(command);
    } catch (error) {
      this.pendingPlaybackCommand = null;
      this.pendingTrackNavigation = null;
      this.publish({
        status: 'error',
        message: 'Системная медиакоманда недоступна'
      });
      throw error;
    }

    if (this.pendingTrackNavigation) {
      this.clearTrackTransitionTimer();
      this.scheduleNavigationRefresh(NAVIGATION_REFRESH_DELAY_MS);
    } else {
      this.scheduleTrackTransitionRefresh();
    }
    await this.savePlaybackCache();
    return this.getPublicState();
  }

  startSystemMediaMonitor() {
    if (!this.active || this.oauthInProgress) {
      return;
    }

    this.mediaSessionMonitor?.start((event) => this.handleSystemMediaEvent(event));
  }

  handleSystemMediaEvent(event) {
    if (!this.active || !event) {
      return;
    }

    if (event.type === 'unavailable') {
      console.error('Spotify Lite system media listener unavailable:', event.message || 'Unknown error');
      return;
    }

    if (event.type === 'ready') {
      return;
    }

    if (event.type === 'media-properties-changed') {
      this.clearTrackTransitionTimer();
      if (this.pendingTrackNavigation) {
        return;
      }

      this.clearSystemMediaRefreshTimer();
      this.pendingSystemMediaChange = {
        fromTrackId: this.current?.id || null,
        attempts: 0
      };
      this.scheduleSystemMediaRefresh(NAVIGATION_REFRESH_DELAY_MS);
      return;
    }

    if (event.type !== 'playback' || !this.current) {
      return;
    }

    const playbackStatus = String(event.playbackStatus || '');
    if (!['Playing', 'Paused', 'Stopped', 'Closed'].includes(playbackStatus)) {
      return;
    }

    const isPlaying = playbackStatus === 'Playing';
    const pendingPlaybackCommand = this.pendingPlaybackCommand;
    if (pendingPlaybackCommand
      && Date.now() < pendingPlaybackCommand.expiresAt
      && isPlaying !== pendingPlaybackCommand.expectedIsPlaying) {
      return;
    }

    const reportedPosition = Number(event.positionMs);
    const durationMs = Math.max(0, Number(this.current.durationMs) || 0);
    const progressMs = Number.isFinite(reportedPosition)
      ? Math.min(durationMs || reportedPosition, Math.max(0, reportedPosition))
      : this.estimatedProgress();

    this.pendingPlaybackCommand = null;
    this.clearTrackTransitionTimer();
    this.publish({
      status: isPlaying ? 'playing' : 'paused',
      message: this.cacheMessage(),
      isPlaying,
      progressMs,
      capturedAt: Date.now()
    });

    if (isPlaying) {
      this.lastTransitionCheckTrackId = null;
      this.scheduleTrackTransitionRefresh();
    }

    void this.savePlaybackCache();
  }

  clearSystemMediaRefreshTimer() {
    clearTimeout(this.systemMediaRefreshTimer);
    this.systemMediaRefreshTimer = null;
    this.pendingSystemMediaChange = null;
  }

  scheduleSystemMediaRefresh(delayMs) {
    const pending = this.pendingSystemMediaChange;
    if (!pending) {
      return;
    }

    this.systemMediaRefreshTimer = setTimeout(async () => {
      this.systemMediaRefreshTimer = null;
      if (!this.active || this.pendingSystemMediaChange !== pending) {
        return;
      }

      pending.attempts += 1;
      this.lastTransitionCheckTrackId = null;
      await this.refreshNow();

      if (this.pendingSystemMediaChange !== pending) {
        return;
      }

      const trackChanged = Boolean(this.current?.id && this.current.id !== pending.fromTrackId);
      if (trackChanged || pending.attempts >= NAVIGATION_MAX_ATTEMPTS) {
        this.pendingSystemMediaChange = null;
        this.scheduleTrackTransitionRefresh();
        return;
      }

      this.scheduleSystemMediaRefresh(NAVIGATION_RETRY_DELAY_MS);
    }, delayMs);
  }

  scheduleNavigationRefresh(delayMs) {
    this.clearNavigationRefreshTimer();
    this.navigationRefreshTimer = setTimeout(async () => {
      this.navigationRefreshTimer = null;
      const pending = this.pendingTrackNavigation;
      if (!this.active || !pending) {
        return;
      }

      pending.attempts += 1;
      await this.refreshNow();

      if (this.pendingTrackNavigation !== pending) {
        return;
      }

      const trackChanged = Boolean(this.current?.id && this.current.id !== pending.fromTrackId);
      if (trackChanged) {
        this.pendingTrackNavigation = null;
        this.scheduleTrackTransitionRefresh();
        return;
      }

      if (pending.attempts < NAVIGATION_MAX_ATTEMPTS) {
        this.scheduleNavigationRefresh(NAVIGATION_RETRY_DELAY_MS);
        return;
      }

      this.pendingTrackNavigation = null;
      this.scheduleTrackTransitionRefresh();
    }, delayMs);
  }

  clearNavigationRefreshTimer() {
    clearTimeout(this.navigationRefreshTimer);
    this.navigationRefreshTimer = null;
  }

  resolvePlaybackState(actualIsPlaying, track) {
    const pending = this.pendingPlaybackCommand;

    if (!pending) {
      return actualIsPlaying;
    }

    const trackChanged = pending.trackId && pending.trackId !== track?.id;
    const expired = Date.now() >= pending.expiresAt;

    if (trackChanged || expired || actualIsPlaying === pending.expectedIsPlaying) {
      this.pendingPlaybackCommand = null;
      return actualIsPlaying;
    }

    return pending.expectedIsPlaying;
  }

  async seek(positionMs) {
    const durationMs = Math.max(0, Number(this.current?.durationMs) || 0);
    const requestedPosition = Number(positionMs);

    if (!this.current || !durationMs || !Number.isFinite(requestedPosition)) {
      throw new Error('Сейчас нельзя перемотать этот трек.');
    }

    const targetPosition = Math.min(durationMs, Math.max(0, Math.round(requestedPosition)));
    this.lastTransitionCheckTrackId = null;
    this.publish({
      progressMs: targetPosition,
      capturedAt: Date.now(),
      message: this.cacheMessage()
    });
    this.scheduleTrackTransitionRefresh();

    try {
      const response = await this.spotifyPut(`/me/player/seek?position_ms=${targetPosition}`);
      await this.ensureSuccessfulResponse(response, 'Не удалось перемотать трек');
    } catch (error) {
      this.publish({ message: `Перемотка Spotify недоступна · ${this.toFriendlyError(error)}` });
      throw error;
    }

    await this.savePlaybackCache();
    return this.getPublicState();
  }

  applyOptimisticMediaCommand(command) {
    if (command === 'play-pause') {
      const isPlaying = !this.state.isPlaying;
      this.publish({
        isPlaying,
        status: isPlaying ? 'playing' : 'paused',
        progressMs: this.estimatedProgress(),
        capturedAt: Date.now()
      });
      return;
    }

    if (command === 'previous' && this.estimatedProgress() > 3000) {
      this.publish({
        progressMs: 0,
        capturedAt: Date.now(),
        message: this.cacheMessage()
      });
      return;
    }

    this.publish({
      isPlaying: true,
      status: 'loading',
      progressMs: this.estimatedProgress(),
      capturedAt: Date.now(),
      message: ''
    });
  }

  async spotifyGet(relativePath) {
    return this.spotifyRequest(relativePath);
  }

  async spotifyPut(relativePath) {
    return this.spotifyRequest(relativePath, { method: 'PUT' });
  }

  async spotifyRequest(relativePath, options = {}) {
    await this.ensureAccessToken();
    let response = await this.fetchWithTimeout(`${SPOTIFY_API_URL}${relativePath}`, {
      ...options,
      headers: { Authorization: `Bearer ${this.tokens.accessToken}` }
    }, SPOTIFY_API_TIMEOUT_MS);

    if (response.status === 401 && this.tokens?.refreshToken) {
      await response.body?.cancel?.().catch(() => {});
      this.tokens.accessToken = null;
      await this.refreshAccessToken();
      response = await this.fetchWithTimeout(`${SPOTIFY_API_URL}${relativePath}`, {
        ...options,
        headers: { Authorization: `Bearer ${this.tokens.accessToken}` }
      }, SPOTIFY_API_TIMEOUT_MS);
    }

    return response;
  }

  async ensureAccessToken() {
    await this.loadTokens();

    if (this.tokens?.accessToken && this.tokens.expiresAt > Date.now() + 30000) {
      return;
    }

    if (!this.tokens?.refreshToken) {
      throw new SpotifyAuthenticationRequiredError('Spotify authentication is required.');
    }

    await this.refreshAccessToken();
  }

  async refreshAccessToken() {
    if (this.accessTokenRefreshPromise) {
      return this.accessTokenRefreshPromise;
    }

    let refreshTask;
    refreshTask = this.refreshAccessTokenCore().finally(() => {
      if (this.accessTokenRefreshPromise === refreshTask) {
        this.accessTokenRefreshPromise = null;
      }
    });
    this.accessTokenRefreshPromise = refreshTask;
    return refreshTask;
  }

  async refreshAccessTokenCore() {
    const response = await this.fetchWithTimeout(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret
      })
    }, SPOTIFY_TOKEN_TIMEOUT_MS);

    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        this.tokens = null;
        await this.saveTokens();
        throw new SpotifyAuthenticationRequiredError('Spotify refresh token is no longer valid.');
      }

      throw new Error(`Spotify token refresh failed (${response.status}).`);
    }

    await this.readTokenResponse(response);
  }

  async exchangeAuthorizationCode(code) {
    const response = await this.fetchWithTimeout(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret
      })
    }, SPOTIFY_TOKEN_TIMEOUT_MS);

    await this.ensureSuccessfulResponse(response, 'Не удалось завершить вход в Spotify');
    await this.readTokenResponse(response);
  }

  async readTokenResponse(response) {
    const payload = await response.json();
    this.tokens = {
      clientId: this.clientId,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || this.tokens?.refreshToken || null,
      scope: payload.scope || this.tokens?.scope || '',
      expiresAt: Date.now() + Math.max(30, Number(payload.expires_in) || 3600) * 1000
    };
    await this.saveTokens();
  }

  waitForAuthorizationCode() {
    const state = crypto.randomBytes(24).toString('hex');
    const authorizationUrl = new URL(SPOTIFY_AUTH_URL);
    authorizationUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: REQUIRED_SCOPES,
      state,
      show_dialog: 'true'
    }).toString();

    return new Promise((resolve, reject) => {
      let settled = false;
      const sockets = new Set();
      const finish = (error, code, forceClose = false) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        if (this.oauthSession?.server === server) {
          this.oauthSession = null;
        }
        if (server.listening) {
          server.close();
        }
        if (forceClose) {
          for (const socket of sockets) {
            socket.destroy();
          }
        }
        if (error) {
          reject(error);
        } else {
          resolve(code);
        }
      };

      const server = http.createServer((request, response) => {
        const requestUrl = new URL(request.url, this.redirectUri);
        if (requestUrl.pathname !== '/callback') {
          response.writeHead(404).end();
          return;
        }

        const returnedState = requestUrl.searchParams.get('state');
        const error = requestUrl.searchParams.get('error');
        const code = requestUrl.searchParams.get('code');
        const successful = !error && returnedState === state && code;
        const message = successful
          ? 'Spotify Lite подключён. Это окно можно закрыть.'
          : 'Не удалось подключить Spotify. Вернитесь в виджет и попробуйте снова.';

        response.writeHead(successful ? 200 : 400, {
          'Content-Type': 'text/html; charset=utf-8'
        });
        response.end(`<html><body style="font:16px Segoe UI;background:#121212;color:white;padding:32px">${message}</body></html>`);

        if (!successful) {
          finish(new Error(error || 'Spotify returned an invalid authorization response.'));
          return;
        }

        finish(null, code);
      });
      server.maxConnections = 16;

      const timeout = setTimeout(() => {
        finish(new Error('Время ожидания входа в Spotify истекло.'), null, true);
      }, 3 * 60 * 1000);
      timeout.unref?.();

      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.setTimeout(15000, () => socket.destroy());
        socket.once('close', () => sockets.delete(socket));
      });

      this.oauthSession = {
        server,
        cancel: (error) => finish(error, null, true)
      };

      server.once('error', (error) => finish(error, null, true));
      server.listen(5000, '127.0.0.1', () => {
        Promise.resolve(this.openExternal(authorizationUrl.toString()))
          .catch((error) => finish(error, null, true));
      });
    });
  }

  cancelAuthorization(error) {
    this.oauthSession?.cancel(error);
  }

  cancelActiveRequests(error) {
    for (const request of this.activeRequests) {
      request.error = error;
      request.controller.abort();
    }
  }

  async fetchWithTimeout(url, options = {}, timeoutMs = SPOTIFY_API_TIMEOUT_MS) {
    const controller = new AbortController();
    const request = { controller, error: null };
    const timeout = setTimeout(() => {
      request.error = new SpotifyRequestTimeoutError(`Spotify request timed out after ${timeoutMs} ms.`);
      controller.abort();
    }, timeoutMs);
    timeout.unref?.();
    this.activeRequests.add(request);

    try {
      return await this.fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && request.error) {
        throw request.error;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
      this.activeRequests.delete(request);
    }
  }

  async withArtwork(track) {
    if (!track?.artworkUrl) {
      return track;
    }

    if (this.artworkCache.has(track.artworkUrl)) {
      const dataUrl = this.artworkCache.get(track.artworkUrl);
      this.artworkCache.delete(track.artworkUrl);
      this.artworkCache.set(track.artworkUrl, dataUrl);
      return { ...track, artworkDataUrl: dataUrl };
    }

    let artworkRequest = this.artworkRequests.get(track.artworkUrl);
    if (!artworkRequest) {
      artworkRequest = this.loadArtwork(track.artworkUrl).finally(() => {
        if (this.artworkRequests.get(track.artworkUrl) === artworkRequest) {
          this.artworkRequests.delete(track.artworkUrl);
        }
      });
      this.artworkRequests.set(track.artworkUrl, artworkRequest);
    }

    try {
      const dataUrl = await artworkRequest;
      return dataUrl ? { ...track, artworkDataUrl: dataUrl } : track;
    } catch {
      return track;
    }
  }

  async loadArtwork(artworkUrl) {
    const response = await this.fetchWithTimeout(artworkUrl, {}, SPOTIFY_ARTWORK_TIMEOUT_MS);
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      return null;
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const bytes = Buffer.from(await response.arrayBuffer());
    const dataUrl = `data:${contentType};base64,${bytes.toString('base64')}`;
    this.setArtworkCache(artworkUrl, dataUrl);
    return dataUrl;
  }

  setArtworkCache(artworkUrl, dataUrl) {
    const previousSize = this.artworkCacheSizes.get(artworkUrl) || 0;
    const nextSize = Buffer.byteLength(dataUrl, 'utf8');
    this.artworkCache.delete(artworkUrl);
    this.artworkCache.set(artworkUrl, dataUrl);
    this.artworkCacheSizes.set(artworkUrl, nextSize);
    this.artworkCacheBytes += nextSize - previousSize;
    this.enforceArtworkCacheLimits();
  }

  deleteArtworkCacheEntry(artworkUrl) {
    this.artworkCache.delete(artworkUrl);
    this.artworkCacheBytes -= this.artworkCacheSizes.get(artworkUrl) || 0;
    this.artworkCacheSizes.delete(artworkUrl);
    this.artworkCacheBytes = Math.max(0, this.artworkCacheBytes);
  }

  enforceArtworkCacheLimits() {
    while (
      this.artworkCache.size > ARTWORK_CACHE_MAX_ENTRIES
      || this.artworkCacheBytes > ARTWORK_CACHE_MAX_BYTES
    ) {
      const oldestArtworkUrl = this.artworkCache.keys().next().value;
      if (!oldestArtworkUrl) {
        break;
      }

      this.deleteArtworkCacheEntry(oldestArtworkUrl);
    }
  }

  findCachedTrack(track) {
    return [this.current, ...this.upcoming, ...this.previous]
      .filter(Boolean)
      .find((candidate) => sameTrack(candidate, track)) || null;
  }

  pushPrevious(track) {
    this.removeTrack(this.previous, track);
    this.previous.unshift(track);
    this.previous.splice(SIDE_CACHE_CAPACITY);
  }

  removeTrack(collection, track) {
    const index = collection.findIndex((candidate) => sameTrack(candidate, track));
    if (index >= 0) {
      collection.splice(index, 1);
    }
  }

  pruneArtworkCache() {
    const retained = new Set(
      [this.current, ...this.previous, ...this.upcoming]
        .map((track) => track?.artworkUrl)
        .filter(Boolean)
    );

    for (const artworkUrl of this.artworkCache.keys()) {
      if (!retained.has(artworkUrl)) {
        this.deleteArtworkCacheEntry(artworkUrl);
      }
    }

    this.enforceArtworkCacheLimits();
  }

  estimatedProgress() {
    const elapsed = this.state.isPlaying ? Date.now() - this.state.capturedAt : 0;
    const duration = this.current?.durationMs || Number.MAX_SAFE_INTEGER;
    return Math.min(duration, Math.max(0, this.state.progressMs + elapsed));
  }

  cacheMessage() {
    return '';
  }

  scheduleTrackTransitionRefresh() {
    this.clearTrackTransitionTimer();

    if (!this.active || !this.state.isPlaying || !this.current?.durationMs) {
      return;
    }

    const remainingMs = Math.max(0, this.current.durationMs - this.estimatedProgress());
    if (this.lastTransitionCheckTrackId === this.current.id) {
      return;
    }

    const delayMs = Math.max(TRACK_TRANSITION_DELAY_MS, remainingMs + TRACK_TRANSITION_DELAY_MS);
    const trackId = this.current.id;
    this.trackTransitionTimer = setTimeout(() => {
      this.trackTransitionTimer = null;
      this.lastTransitionCheckTrackId = trackId;
      void this.refreshNow({ forceQueue: true });
    }, delayMs);
  }

  clearTrackTransitionTimer() {
    clearTimeout(this.trackTransitionTimer);
    this.trackTransitionTimer = null;
  }

  async ensureSuccessfulResponse(response, message) {
    if (response.ok) {
      return;
    }

    let responseMessage = '';
    try {
      responseMessage = (await response.text()).trim();
    } catch {
      // The HTTP status remains enough to surface a useful fallback.
    }

    if (response.status === 403
      && responseMessage.toLocaleLowerCase().includes('not registered for this application')) {
      throw new SpotifyUserNotRegisteredError(responseMessage);
    }

    throw new Error(responseMessage || `${message} (${response.status}).`);
  }

  publish(patch = {}) {
    if (this.oauthInProgress && patch.status !== 'connecting') {
      return;
    }

    this.state = {
      ...this.state,
      ...patch,
      current: Object.hasOwn(patch, 'current') ? patch.current : this.current,
      previousCount: this.previous.length,
      upcomingCount: this.upcoming.length
    };
    this.onStateChanged?.(this.getPublicState());
  }

  getPublicState() {
    return {
      ...this.state,
      current: this.state.current ? { ...this.state.current } : null
    };
  }

  async loadPlaybackCache() {
    if (this.playbackCacheLoaded) {
      return;
    }

    if (!this.playbackCacheFilePath) {
      this.playbackCacheLoaded = true;
      return;
    }

    if (this.playbackCacheLoadPromise) {
      return this.playbackCacheLoadPromise;
    }

    this.playbackCacheLoadPromise = (async () => {
      try {
        const cached = JSON.parse(await fsp.readFile(this.playbackCacheFilePath, 'utf8'));
        const current = cached?.current;

        if (!current?.id || !current?.title || !current?.durationMs) {
          return;
        }

        this.current = {
          id: String(current.id),
          uri: String(current.uri || ''),
          title: String(current.title),
          artist: String(current.artist || 'Spotify'),
          durationMs: Math.max(0, Number(current.durationMs) || 0),
          artworkUrl: current.artworkUrl || null,
          artworkDataUrl: current.artworkDataUrl || null
        };
        this.state = {
          ...this.state,
          status: 'paused',
          message: '',
          current: this.current,
          isPlaying: false,
          progressMs: Math.min(
            this.current.durationMs,
            Math.max(0, Number(cached.progressMs) || 0)
          ),
          capturedAt: Date.now()
        };
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error('Failed to read Spotify Lite playback cache:', error);
        }
      } finally {
        this.playbackCacheLoaded = true;
        this.playbackCacheLoadPromise = null;
      }
    })();

    return this.playbackCacheLoadPromise;
  }

  async savePlaybackCache() {
    if (!this.playbackCacheFilePath) {
      return;
    }

    if (!this.current) {
      await this.clearPlaybackCache();
      return;
    }

    await fsp.mkdir(path.dirname(this.playbackCacheFilePath), { recursive: true });
    await fsp.writeFile(this.playbackCacheFilePath, JSON.stringify({
      current: this.current,
      progressMs: this.estimatedProgress(),
      savedAt: Date.now()
    }), 'utf8');
  }

  async clearPlaybackCache() {
    if (!this.playbackCacheFilePath) {
      return;
    }

    await fsp.rm(this.playbackCacheFilePath, { force: true });
  }

  async loadTokens() {
    if (this.tokensLoaded) {
      return;
    }

    this.tokensLoaded = true;
    try {
      this.tokens = JSON.parse(await fsp.readFile(this.tokenFilePath, 'utf8'));

      if (this.tokens?.clientId !== this.clientId || !hasRequiredSpotifyScopes(this.tokens?.scope)) {
        this.tokens = null;
        await this.saveTokens();
        return;
      }

      this.state.authenticated = Boolean(this.tokens?.refreshToken || this.tokens?.accessToken);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Failed to read Spotify Lite tokens:', error);
      }
      this.tokens = null;
    }
  }

  async saveTokens() {
    await fsp.mkdir(path.dirname(this.tokenFilePath), { recursive: true });
    if (!this.tokens) {
      await fsp.rm(this.tokenFilePath, { force: true });
      return;
    }

    await fsp.writeFile(this.tokenFilePath, JSON.stringify(this.tokens), 'utf8');
  }

  toFriendlyError(error) {
    if (error instanceof SpotifyRequestTimeoutError) {
      return 'Spotify не ответил вовремя';
    }

    if (error instanceof SpotifyOperationCancelledError) {
      return 'Операция Spotify отменена';
    }

    if (error instanceof SpotifyAuthenticationRequiredError) {
      return 'Подключите Spotify';
    }

    if (error instanceof SpotifyUserNotRegisteredError) {
      return 'Добавьте аккаунт в Dashboard → Users Management';
    }

    if (error?.code === 'EADDRINUSE') {
      return 'Порт входа Spotify уже занят';
    }

    return error?.message || 'Spotify временно недоступен';
  }

  dispose() {
    this.disposed = true;
    this.stop();
  }
}

function parseSpotifyTrack(item) {
  if (!item || typeof item !== 'object' || !item.name) {
    return null;
  }

  const artists = Array.isArray(item.artists)
    ? item.artists.map((artist) => artist?.name).filter(Boolean).join(', ')
    : '';
  const artist = artists || item.show?.publisher || item.show?.name || 'Spotify';
  const images = item.album?.images || item.images || [];

  return {
    id: item.id || item.uri || `${item.name}|${artist}`,
    uri: item.uri || '',
    title: item.name,
    artist,
    durationMs: Math.max(0, Number(item.duration_ms) || 0),
    artworkUrl: images[0]?.url || null,
    artworkDataUrl: null
  };
}

function sameTrack(left, right) {
  if (!left || !right) {
    return false;
  }

  if (left.id && right.id) {
    return left.id === right.id;
  }

  return normalizeText(left.title) === normalizeText(right.title)
    && normalizeText(left.artist) === normalizeText(right.artist);
}

function hasRequiredSpotifyScopes(scope) {
  const grantedScopes = new Set(String(scope || '').split(/\s+/).filter(Boolean));
  return REQUIRED_SCOPES.split(/\s+/).every((requiredScope) => grantedScopes.has(requiredScope));
}

function normalizeText(value) {
  return String(value || '').toLocaleLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, '');
}

module.exports = {
  SpotifyLiteService,
  parseSpotifyTrack,
  sameTrack
};
