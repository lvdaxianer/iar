import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERSISTENCE_API_VERSION,
  PersistenceValidationError,
  validatePersistenceProviderManifest,
  validateSessionIdentity,
  type PersistenceProviderManifest,
  type SessionIdentity
} from '../../packages/persistence-spi/src/index.js';

const identity: SessionIdentity = {
  sessionId: 'session-001',
  runId: 'run-001',
  traceId: 'trace-001',
  messageId: 'message-001'
};

const manifest: PersistenceProviderManifest = {
  providerId: 'test.memory',
  apiVersion: PERSISTENCE_API_VERSION,
  capabilities: ['messages', 'events', 'snapshots']
};

test('validates a canonical session identity for every persistence operation', () => {
  assert.deepEqual(validateSessionIdentity(identity), identity);
});

test('rejects an empty or oversized session identity field', () => {
  assert.throws(
    () => validateSessionIdentity({ ...identity, sessionId: ' ' }),
    (error: unknown) => error instanceof PersistenceValidationError && error.code === 'session_identity_invalid'
  );
  assert.throws(
    () => validateSessionIdentity({ ...identity, sessionId: 'x'.repeat(257) }),
    (error: unknown) => error instanceof PersistenceValidationError && error.code === 'session_identity_invalid'
  );
});

test('accepts only the declared persistence API version and capabilities', () => {
  assert.deepEqual(validatePersistenceProviderManifest(manifest), manifest);
  assert.throws(
    () => validatePersistenceProviderManifest({ ...manifest, apiVersion: 'iar.persistence/v0' }),
    (error: unknown) => error instanceof PersistenceValidationError && error.code === 'provider_manifest_invalid'
  );
  assert.throws(
    () => validatePersistenceProviderManifest({ ...manifest, capabilities: [] }),
    (error: unknown) => error instanceof PersistenceValidationError && error.code === 'provider_manifest_invalid'
  );
});
