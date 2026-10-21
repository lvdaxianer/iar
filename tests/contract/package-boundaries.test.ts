import assert from 'node:assert/strict';
import test from 'node:test';

import { checkAbiCompatibility, validateControlPlaneRequest } from '@iar/contracts';
import { PluginHost } from '@iar/plugins';
import { PersistenceProviderLoader, PersistenceProviderRegistry, sqlitePersistenceProviderModule, SqlitePersistenceProvider } from '@iar/storage';
import { RemotePluginDistributor, signArtifact } from '@iar/control-plane';
import { ObservabilityRecorder, createSystemLoggingPlugin } from '@iar/runtime';

test('consolidated package entries expose former public boundaries', () => {
  assert.equal(typeof checkAbiCompatibility, 'function');
  assert.equal(typeof validateControlPlaneRequest, 'function');
  assert.equal(typeof PluginHost, 'function');
  assert.equal(typeof PersistenceProviderLoader, 'function');
  assert.equal(typeof PersistenceProviderRegistry, 'function');
  assert.equal(typeof sqlitePersistenceProviderModule, 'object');
  assert.equal(typeof SqlitePersistenceProvider, 'function');
  assert.equal(typeof RemotePluginDistributor, 'function');
  assert.equal(typeof signArtifact, 'function');
  assert.equal(typeof ObservabilityRecorder, 'function');
  assert.equal(typeof createSystemLoggingPlugin, 'function');
});
