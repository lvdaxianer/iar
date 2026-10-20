import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_RECENT_MESSAGE_QUERY_LIMIT,
  DEFAULT_SESSION_LIST_LIMIT,
  MAX_SESSION_LIST_LIMIT,
  PERSISTENCE_API_VERSION,
  PersistenceValidationError,
  validateRecentMessageQuery,
  validateSessionListQuery,
  validatePersistenceProviderManifest,
  validateSessionIdentity,
  type PersistenceProviderManifest,
  type SessionIdentity
} from '@iar/storage';

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

test('validates bounded recent-message query options', () => {
  assert.deepEqual(validateRecentMessageQuery({ limit: 0 }), { limit: 0 });
  assert.deepEqual(validateRecentMessageQuery({ limit: MAX_RECENT_MESSAGE_QUERY_LIMIT }), { limit: MAX_RECENT_MESSAGE_QUERY_LIMIT });
  assert.throws(
    () => validateRecentMessageQuery({ limit: MAX_RECENT_MESSAGE_QUERY_LIMIT + 1 }),
    (error: unknown) => error instanceof PersistenceValidationError && error.code === 'recent_message_query_invalid'
  );
  assert.throws(
    () => validateRecentMessageQuery({ limit: 1.5 }),
    (error: unknown) => error instanceof PersistenceValidationError && error.code === 'recent_message_query_invalid'
  );
});

test('validates bounded session-summary pagination options', () => {
  assert.deepEqual(validateSessionListQuery(undefined), { limit: DEFAULT_SESSION_LIST_LIMIT });
  assert.deepEqual(validateSessionListQuery({ limit: MAX_SESSION_LIST_LIMIT, cursor: 'opaque-cursor' }), { limit: MAX_SESSION_LIST_LIMIT, cursor: 'opaque-cursor' });
  assert.throws(
    () => validateSessionListQuery({ limit: 0 }),
    (error: unknown) => error instanceof PersistenceValidationError && error.code === 'session_list_query_invalid'
  );
  assert.throws(
    () => validateSessionListQuery({ limit: MAX_SESSION_LIST_LIMIT + 1 }),
    (error: unknown) => error instanceof PersistenceValidationError && error.code === 'session_list_query_invalid'
  );
  assert.throws(
    () => validateSessionListQuery({ limit: 1, cursor: '' }),
    (error: unknown) => error instanceof PersistenceValidationError && error.code === 'session_list_query_invalid'
  );
});
