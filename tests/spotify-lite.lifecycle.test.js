const assert = require('node:assert/strict');
const test = require('node:test');

const { SpotifyLiteService } = require('../src/main/spotify-lite');

function createService(overrides = {}) {
  return new SpotifyLiteService({
    tokenFilePath: 'unused-token-file.json',
    playbackCacheFilePath: 'unused-playback-file.json',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    openExternal: async () => {},
    sendMediaKey: async () => {},
    onStateChanged: () => {},
    fetchImpl: async () => {
      throw new Error('Unexpected fetch.');
    },
    ...overrides
  });
}

test('closing during authorization does not reactivate the media monitor', async () => {
  let resolveAuthorization;
  let monitorStarts = 0;
  const authorization = new Promise((resolve) => {
    resolveAuthorization = resolve;
  });
  const service = createService({
    mediaSessionMonitor: {
      start: () => {
        monitorStarts += 1;
      },
      stop: () => {}
    }
  });

  service.active = true;
  service.lifecycleGeneration = 1;
  service.clearPlaybackCache = async () => {};
  service.savePlaybackCache = async () => {};
  service.saveTokens = async () => {};
  service.waitForAuthorizationCode = () => authorization;
  service.exchangeAuthorizationCode = async () => {
    service.tokens = {
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 60000
    };
  };
  service.refreshNow = async () => service.getPublicState();

  const connecting = service.connect();
  await new Promise((resolve) => setImmediate(resolve));
  service.stop();
  resolveAuthorization('authorization-code');
  await connecting;

  assert.equal(service.active, false);
  assert.equal(monitorStarts, 0);
});

test('artwork requests are deduplicated and the memory cache is bounded', async () => {
  let fetchCount = 0;
  const service = createService({
    fetchImpl: async () => {
      fetchCount += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return {
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => Buffer.from('artwork')
      };
    }
  });
  const track = {
    id: 'track-1',
    title: 'Track',
    artist: 'Artist',
    durationMs: 1000,
    artworkUrl: 'https://example.test/shared.jpg'
  };

  const [first, second] = await Promise.all([
    service.withArtwork(track),
    service.withArtwork({ ...track, id: 'track-2' })
  ]);

  assert.equal(fetchCount, 1);
  assert.match(first.artworkDataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(first.artworkDataUrl, second.artworkDataUrl);

  for (let index = 0; index < 30; index += 1) {
    service.setArtworkCache(`https://example.test/${index}.jpg`, `data:image/jpeg;base64,${index}`);
  }

  assert.ok(service.artworkCache.size <= 11);

  service.current = { ...track, artworkUrl: 'https://example.test/29.jpg' };
  service.previous = [];
  service.upcoming = [];
  service.pruneArtworkCache();
  assert.deepEqual([...service.artworkCache.keys()], ['https://example.test/29.jpg']);
});

test('active Spotify requests are aborted when the service stops', async () => {
  const service = createService({
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true });
    })
  });
  service.savePlaybackCache = async () => {};
  const request = service.fetchWithTimeout('https://example.test/hanging', {}, 60000);
  await new Promise((resolve) => setImmediate(resolve));

  service.stop();

  await assert.rejects(request, /Spotify operation was cancelled/);
  assert.equal(service.activeRequests.size, 0);
});
