'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const STATE_DATABASE = 'st_bme_vnext';
const VECTOR_DATABASE = 'st_bme_vnext_vectors';
const MAX_SQL_STATEMENTS = 100;
const SQL_PARAMETER_BUDGET = 900;
const STATE_OPERATIONS = new Set([
  'commit',
  'createTurnRecords',
  'reconcileHistory',
  'settleVectorJobs',
]);
const GRAPH_COLLECTIONS = ['nodes', 'edges', 'graphState'];
const DOMAIN_ERROR_CODES = {
  RevisionConflictError: 'revision_conflict',
  HistoryBasisConflictError: 'history_basis_conflict',
  ChangeConflictError: 'change_conflict',
  GraphRevisionConflictError: 'graph_revision_conflict',
  RecallConflictError: 'recall_conflict',
  PlannerConflictError: 'planner_conflict',
  RangeError: 'range_error',
  TypeError: 'validation_error',
};

const STATE_MIGRATIONS = [{
  id: '001_state_store',
  statement: `
    CREATE TABLE conversation_heads (
      chat_key TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      graph_revision INTEGER NOT NULL,
      processed_through INTEGER NOT NULL,
      vector_model_scope TEXT NOT NULL,
      history_json TEXT NOT NULL,
      updated_at REAL NOT NULL,
      store_version INTEGER NOT NULL
    );
    CREATE TABLE graph_records (
      chat_key TEXT NOT NULL,
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (chat_key, collection, record_id),
      FOREIGN KEY (chat_key) REFERENCES conversation_heads(chat_key) ON DELETE CASCADE
    );
    CREATE TABLE turn_transactions (
      chat_key TEXT NOT NULL,
      committed_revision INTEGER NOT NULL,
      transaction_id TEXT NOT NULL UNIQUE,
      value_json TEXT NOT NULL,
      PRIMARY KEY (chat_key, committed_revision),
      FOREIGN KEY (chat_key) REFERENCES conversation_heads(chat_key) ON DELETE CASCADE
    );
    CREATE TABLE recall_records (
      turn_key TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      FOREIGN KEY (chat_key) REFERENCES conversation_heads(chat_key) ON DELETE CASCADE
    );
    CREATE INDEX recall_records_chat ON recall_records(chat_key);
    CREATE TABLE planner_records (
      turn_key TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      FOREIGN KEY (chat_key) REFERENCES conversation_heads(chat_key) ON DELETE CASCADE
    );
    CREATE INDEX planner_records_chat ON planner_records(chat_key);
    CREATE TABLE vector_jobs (
      job_id TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at REAL NOT NULL,
      value_json TEXT NOT NULL,
      FOREIGN KEY (chat_key) REFERENCES conversation_heads(chat_key) ON DELETE CASCADE
    );
    CREATE INDEX vector_jobs_chat_status ON vector_jobs(chat_key, status, created_at, job_id);
    CREATE TABLE command_results (
      command_key TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at REAL NOT NULL
    );
    CREATE INDEX command_results_chat ON command_results(chat_key);
    CREATE TABLE write_guards (
      chat_key TEXT PRIMARY KEY,
      expected_version INTEGER NOT NULL,
      command_key TEXT NOT NULL,
      created_at REAL NOT NULL
    );
    CREATE TRIGGER validate_write_guard_insert
    BEFORE INSERT ON write_guards
    WHEN COALESCE((SELECT store_version FROM conversation_heads WHERE chat_key = NEW.chat_key), 0) <> NEW.expected_version
    BEGIN
      SELECT RAISE(ABORT, 'bme_store_conflict');
    END;
    CREATE TRIGGER validate_write_guard_update
    BEFORE UPDATE ON write_guards
    WHEN COALESCE((SELECT store_version FROM conversation_heads WHERE chat_key = NEW.chat_key), 0) <> NEW.expected_version
    BEGIN
      SELECT RAISE(ABORT, 'bme_store_conflict');
    END;
  `,
}];

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function requireString(value, label, maximum = 4096) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(label + ' is required');
  if (text.length > maximum) throw new TypeError(label + ' is too long');
  return text;
}

function normalizeRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result && result.rows)) return result.rows;
  if (Array.isArray(result && result.data)) return result.data;
  return [];
}

function transactionRows(response, index) {
  return normalizeRows(response && response.results && response.results[index]);
}

function parseStored(value, label) {
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error('BME Primary is corrupt: invalid ' + label + ' JSON');
  }
}

function storedInteger(value, label, minimum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error('BME Primary is corrupt: invalid ' + label);
  }
  return number;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(function (key) {
    return JSON.stringify(key) + ':' + stableJson(value[key]);
  }).join(',') + '}';
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function recordsEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function domainFailure(error) {
  const name = String(error && error.name || 'TypeError');
  const code = DOMAIN_ERROR_CODES[name] || 'validation_error';
  const details = Object.assign({}, error && error.details || {});
  for (const key of [
    'chatKey',
    'expectedRevision',
    'actualRevision',
    'historyLength',
    'historyHash',
    'expectedGraphRevision',
    'actualGraphRevision',
    'turnKey',
  ]) {
    if (error && error[key] !== undefined) details[key] = error[key];
  }
  return {
    ok: false,
    error: {
      code,
      name,
      message: String(error && error.message || error || 'StateStore command failed'),
      details,
    },
  };
}

function idempotencyFailure(message) {
  return {
    ok: false,
    error: { code: 'idempotency_conflict', name: 'TypeError', message, details: {} },
  };
}

async function ensureStateSchema(txCtx) {
  if (!txCtx || !txCtx.sql || typeof txCtx.sql.migrate !== 'function') {
    throw new Error('BME state transactions require sql.private');
  }
  await txCtx.sql.migrate(STATE_DATABASE, STATE_MIGRATIONS, 'bme_vnext_migrations');
}

function assertStoredRecord(record, chatKey, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('BME Primary is corrupt: invalid ' + label);
  }
  if (String(record.chatKey || '') !== chatKey) {
    throw new Error('BME Primary is corrupt: cross-chat ' + label);
  }
  return record;
}

async function loadConversation(txCtx, core, chatKey, commandKey) {
  const statements = [
    { mode: 'query', statement: 'SELECT revision, graph_revision, processed_through, vector_model_scope, history_json, updated_at, store_version FROM conversation_heads WHERE chat_key = ?', params: [chatKey] },
    { mode: 'query', statement: 'SELECT collection, record_id, value_json FROM graph_records WHERE chat_key = ? ORDER BY collection, record_id', params: [chatKey] },
    { mode: 'query', statement: 'SELECT committed_revision, value_json FROM turn_transactions WHERE chat_key = ? ORDER BY committed_revision', params: [chatKey] },
    { mode: 'query', statement: 'SELECT turn_key, value_json FROM recall_records WHERE chat_key = ? ORDER BY turn_key', params: [chatKey] },
    { mode: 'query', statement: 'SELECT turn_key, value_json FROM planner_records WHERE chat_key = ? ORDER BY turn_key', params: [chatKey] },
    { mode: 'query', statement: 'SELECT job_id, value_json FROM vector_jobs WHERE chat_key = ? ORDER BY created_at, job_id', params: [chatKey] },
  ];
  if (commandKey) {
    statements.push({
      mode: 'query',
      statement: 'SELECT fingerprint, result_json FROM command_results WHERE command_key = ? LIMIT 1',
      params: [commandKey],
    });
  }
  const response = await txCtx.sql.transaction(STATE_DATABASE, statements);
  const state = core.createConversationState(chatKey);
  const headRow = transactionRows(response, 0)[0];
  let storeVersion = 0;
  if (headRow) {
    const history = parseStored(headRow.history_json, 'history');
    if (!Array.isArray(history)) throw new Error('BME Primary is corrupt: invalid history');
    state.head = {
      chatKey,
      revision: storedInteger(headRow.revision, 'revision', 0),
      graphRevision: storedInteger(headRow.graph_revision, 'graph_revision', 0),
      processedThrough: storedInteger(headRow.processed_through, 'processed_through', -1),
      vectorModelScope: String(headRow.vector_model_scope || ''),
      history,
      updatedAt: Number(headRow.updated_at),
    };
    if (!Number.isFinite(state.head.updatedAt)) throw new Error('BME Primary is corrupt: invalid updated_at');
    storeVersion = storedInteger(headRow.store_version, 'store_version', 0);
  }

  for (const row of transactionRows(response, 1)) {
    const collection = String(row.collection || '');
    const recordId = String(row.record_id || '');
    if (!GRAPH_COLLECTIONS.includes(collection) || !recordId) {
      throw new Error('BME Primary is corrupt: invalid graph record key');
    }
    const value = parseStored(row.value_json, 'graph record');
    if (value && Object.prototype.hasOwnProperty.call(value, 'id') && String(value.id) !== recordId) {
      throw new Error('BME Primary is corrupt: graph record id mismatch');
    }
    state.collections[collection].set(recordId, value);
  }
  state.transactions = transactionRows(response, 2).map(function (row) {
    const transaction = assertStoredRecord(parseStored(row.value_json, 'transaction'), chatKey, 'transaction');
    if (transaction.committedRevision !== row.committed_revision) {
      throw new Error('BME Primary is corrupt: transaction revision mismatch');
    }
    return transaction;
  });
  for (const row of transactionRows(response, 3)) {
    const record = assertStoredRecord(parseStored(row.value_json, 'recall record'), chatKey, 'recall record');
    if (record.turnKey !== row.turn_key) throw new Error('BME Primary is corrupt: recall key mismatch');
    state.recallRecords.set(record.turnKey, record);
  }
  for (const row of transactionRows(response, 4)) {
    const record = assertStoredRecord(parseStored(row.value_json, 'planner record'), chatKey, 'planner record');
    if (record.turnKey !== row.turn_key) throw new Error('BME Primary is corrupt: planner key mismatch');
    state.plannerRecords.set(record.turnKey, record);
  }
  for (const row of transactionRows(response, 5)) {
    const job = assertStoredRecord(parseStored(row.value_json, 'vector job'), chatKey, 'vector job');
    if (job.id !== row.job_id) throw new Error('BME Primary is corrupt: vector job key mismatch');
    state.vectorJobs.set(job.id, job);
  }
  const replayRow = commandKey ? transactionRows(response, 6)[0] : null;
  return {
    state,
    storeVersion,
    replay: replayRow ? {
      fingerprint: String(replayRow.fingerprint || ''),
      result: parseStored(replayRow.result_json, 'command result'),
    } : null,
  };
}

function wireState(state) {
  const collections = {};
  for (const name of GRAPH_COLLECTIONS) collections[name] = Array.from(state.collections[name]);
  return {
    head: state.head,
    collections,
    transactions: state.transactions,
    recallRecords: Array.from(state.recallRecords),
    plannerRecords: Array.from(state.plannerRecords),
    vectorJobs: Array.from(state.vectorJobs),
  };
}

function mapDiff(before, after) {
  const puts = [];
  const deletes = [];
  for (const [key, value] of after) {
    if (!before.has(key) || !recordsEqual(before.get(key), value)) puts.push([key, value]);
  }
  for (const key of before.keys()) if (!after.has(key)) deletes.push(key);
  return { puts, deletes };
}

function chunkRows(rows, columnCount) {
  const size = Math.max(1, Math.floor(SQL_PARAMETER_BUDGET / columnCount));
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) chunks.push(rows.slice(index, index + size));
  return chunks;
}

function insertStatements(table, columns, rows, suffix) {
  return chunkRows(rows, columns.length).map(function (chunk) {
    const values = chunk.map(function () { return '(' + columns.map(function () { return '?'; }).join(',') + ')'; }).join(',');
    return {
      statement: 'INSERT INTO ' + table + ' (' + columns.join(',') + ') VALUES ' + values + (suffix || ''),
      params: chunk.flat(),
    };
  });
}

function deleteInStatements(table, keyColumn, chatKey, values) {
  return chunkRows(values.map(function (value) { return [value]; }), 1).map(function (chunk) {
    return {
      statement: 'DELETE FROM ' + table + ' WHERE chat_key = ? AND ' + keyColumn + ' IN (' + chunk.map(function () { return '?'; }).join(',') + ')',
      params: [chatKey].concat(chunk.flat()),
    };
  });
}

function buildWriteStatements(before, after, chatKey, storeVersion, commandKey, commandFingerprint, result) {
  const statements = [{
    statement: 'INSERT INTO write_guards (chat_key, expected_version, command_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(chat_key) DO UPDATE SET expected_version = excluded.expected_version, command_key = excluded.command_key, created_at = excluded.created_at',
    params: [chatKey, storeVersion, commandKey, Date.now()],
  }];
  const head = after.head;
  statements.push({
    statement: 'INSERT INTO conversation_heads (chat_key, revision, graph_revision, processed_through, vector_model_scope, history_json, updated_at, store_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_key) DO UPDATE SET revision = excluded.revision, graph_revision = excluded.graph_revision, processed_through = excluded.processed_through, vector_model_scope = excluded.vector_model_scope, history_json = excluded.history_json, updated_at = excluded.updated_at, store_version = excluded.store_version',
    params: [chatKey, head.revision, head.graphRevision, head.processedThrough, head.vectorModelScope || '', JSON.stringify(head.history), head.updatedAt, storeVersion + 1],
  });
  const graphPuts = [];
  const graphDeletes = [];
  for (const collection of GRAPH_COLLECTIONS) {
    const diff = mapDiff(before.collections[collection], after.collections[collection]);
    for (const [recordId, value] of diff.puts) {
      graphPuts.push([chatKey, collection, recordId, JSON.stringify(value)]);
    }
    for (const recordId of diff.deletes) graphDeletes.push([collection, recordId]);
  }
  statements.push(...insertStatements(
    'graph_records',
    ['chat_key', 'collection', 'record_id', 'value_json'],
    graphPuts,
    ' ON CONFLICT(chat_key, collection, record_id) DO UPDATE SET value_json = excluded.value_json',
  ));
  for (const chunk of chunkRows(graphDeletes, 2)) {
    statements.push({
      statement: 'DELETE FROM graph_records WHERE chat_key = ? AND (collection, record_id) IN (' + chunk.map(function () { return '(?,?)'; }).join(',') + ')',
      params: [chatKey].concat(chunk.flat()),
    });
  }

  const beforeTransactions = new Map(before.transactions.map(function (item) { return [item.committedRevision, item]; }));
  const afterTransactions = new Map(after.transactions.map(function (item) { return [item.committedRevision, item]; }));
  const transactionDiff = mapDiff(beforeTransactions, afterTransactions);
  statements.push(...deleteInStatements('turn_transactions', 'committed_revision', chatKey, transactionDiff.deletes));
  statements.push(...insertStatements(
    'turn_transactions',
    ['chat_key', 'committed_revision', 'transaction_id', 'value_json'],
    transactionDiff.puts.map(function (entry) {
      return [chatKey, entry[0], entry[1].id, JSON.stringify(entry[1])];
    }),
  ));

  for (const descriptor of [
    ['recall_records', 'turn_key', before.recallRecords, after.recallRecords],
    ['planner_records', 'turn_key', before.plannerRecords, after.plannerRecords],
  ]) {
    const diff = mapDiff(descriptor[2], descriptor[3]);
    statements.push(...deleteInStatements(descriptor[0], descriptor[1], chatKey, diff.deletes));
    statements.push(...insertStatements(
      descriptor[0],
      [descriptor[1], 'chat_key', 'value_json'],
      diff.puts.map(function (entry) { return [entry[0], chatKey, JSON.stringify(entry[1])]; }),
    ));
  }

  const vectorDiff = mapDiff(before.vectorJobs, after.vectorJobs);
  statements.push(...deleteInStatements('vector_jobs', 'job_id', chatKey, vectorDiff.deletes));
  statements.push(...insertStatements(
    'vector_jobs',
    ['job_id', 'chat_key', 'status', 'created_at', 'value_json'],
    vectorDiff.puts.map(function (entry) {
      return [entry[0], chatKey, entry[1].status, entry[1].createdAt, JSON.stringify(entry[1])];
    }),
    ' ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, created_at = excluded.created_at, value_json = excluded.value_json',
  ));

  statements.push({
    statement: 'INSERT INTO command_results (command_key, chat_key, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
    params: [commandKey, chatKey, commandFingerprint, JSON.stringify(result), Date.now()],
  });
  if (statements.length > MAX_SQL_STATEMENTS) {
    throw new RangeError('StateStore mutation exceeds the Authority SQL statement limit');
  }
  return statements;
}

async function handleStateRead(txCtx, input, core) {
  input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const kind = requireString(input.kind, 'kind', 32);
  const chatKey = requireString(input.chatKey, 'chatKey', 1024);
  await ensureStateSchema(txCtx);
  if (kind === 'conversation') {
    const loaded = await loadConversation(txCtx, core, chatKey, '');
    return { ok: true, value: wireState(loaded.state) };
  }
  if (kind === 'recall' || kind === 'planner') {
    const turnKey = requireString(input.turnKey, 'turnKey', 256);
    const table = kind === 'recall' ? 'recall_records' : 'planner_records';
    const rows = normalizeRows(await txCtx.sql.query(
      STATE_DATABASE,
      'SELECT value_json FROM ' + table + ' WHERE chat_key = ? AND turn_key = ? LIMIT 1',
      [chatKey, turnKey],
    ));
    if (!rows[0]) return { ok: true, value: null };
    const record = assertStoredRecord(parseStored(rows[0].value_json, kind + ' record'), chatKey, kind + ' record');
    if (record.turnKey !== turnKey) throw new Error('BME Primary is corrupt: ' + kind + ' key mismatch');
    return { ok: true, value: record };
  }
  if (kind === 'vectorJobs') {
    const status = String(input.status || '').trim();
    const rows = normalizeRows(await txCtx.sql.query(
      STATE_DATABASE,
      'SELECT value_json FROM vector_jobs WHERE chat_key = ?' + (status ? ' AND status = ?' : '') + ' ORDER BY created_at, job_id',
      status ? [chatKey, status] : [chatKey],
    ));
    return {
      ok: true,
      value: rows.map(function (row) {
        return assertStoredRecord(parseStored(row.value_json, 'vector job'), chatKey, 'vector job');
      }),
    };
  }
  throw new TypeError('unknown StateStore read kind ' + kind);
}

async function handleStateCommand(txCtx, input, request, core) {
  if (!txCtx || !txCtx.locks || typeof txCtx.locks.withLock !== 'function') {
    throw new Error('BME state.command requires locks');
  }
  input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const operation = requireString(input.operation, 'operation', 64);
  if (!STATE_OPERATIONS.has(operation)) throw new TypeError('unknown StateStore operation ' + operation);
  const command = input.command && typeof input.command === 'object' && !Array.isArray(input.command)
    ? input.command
    : {};
  const chatKey = requireString(command.chatKey, 'chatKey', 1024);
  const commandKey = requireString(request && request.idempotencyKey, 'idempotencyKey', 1024);
  const commandFingerprint = fingerprint({ operation, command });
  await ensureStateSchema(txCtx);

  return await txCtx.locks.withLock('state:' + chatKey, { timeoutMs: 30000 }, async function () {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const loaded = await loadConversation(txCtx, core, chatKey, commandKey);
      if (loaded.replay) {
        return loaded.replay.fingerprint === commandFingerprint
          ? { ok: true, value: loaded.replay.result }
          : idempotencyFailure('idempotency key was already used for another StateStore command');
      }

      let reduced;
      try {
        reduced = await core.reduceConversationState(loaded.state, operation, command, {
          now: Date.now,
          id: crypto.randomUUID,
        });
      } catch (error) {
        return domainFailure(error);
      }
      if (!reduced.changed) return { ok: true, value: reduced.result };

      let statements;
      try {
        statements = buildWriteStatements(
          loaded.state,
          reduced.state,
          chatKey,
          loaded.storeVersion,
          commandKey,
          commandFingerprint,
          reduced.result,
        );
      } catch (error) {
        return domainFailure(error);
      }
      try {
        await txCtx.sql.transaction(STATE_DATABASE, statements);
        return { ok: true, value: reduced.result };
      } catch (error) {
        if (!String(error && error.message || error).includes('bme_store_conflict')) throw error;
      }
    }
    return idempotencyFailure('StateStore command could not acquire a stable SQL revision');
  });
}

function vectorNamespace(input) {
  const scope = String(input && (input.collectionId || input.chatId || input.namespace) || 'default').trim();
  return 'bme-vnext:' + (scope || 'default');
}

function normalizeVector(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(label + ' must be a non-empty array');
  return value.map(function (item, index) {
    const number = Number(item);
    if (!Number.isFinite(number)) throw new TypeError(label + '[' + index + '] must be finite');
    return number;
  });
}

function vectorItems(input) {
  const items = toArray(input && input.items);
  if (!items.length) throw new TypeError('vector.apply requires at least one item');
  let dimension = 0;
  const namespace = vectorNamespace(input);
  const mapped = items.map(function (item, index) {
    const externalId = requireString(item && (item.externalId || item.nodeId || item.id), 'items[' + index + '].externalId');
    const vector = normalizeVector(item && (item.vector || item.embedding), 'items[' + index + '].vector');
    if (!dimension) dimension = vector.length;
    if (vector.length !== dimension) throw new TypeError('vector.apply item dimensions must match');
    return {
      externalId,
      namespace,
      vector,
      payload: {
        externalId,
        nodeId: externalId,
        text: String(item && item.text || item && item.payload && item.payload.text || ''),
        contentHash: String(item && item.hash || item && item.payload && item.payload.contentHash || ''),
        index: Number(item && item.index || item && item.payload && item.payload.index || 0) || 0,
        collectionId: String(input && input.collectionId || ''),
        chatId: String(input && input.chatId || ''),
        modelScope: String(input && input.modelScope || ''),
        graphRevision: Math.max(0, Math.trunc(Number(input && input.graphRevision) || 0)),
        vectorSpaceId: String(input && input.vectorSpaceId || ''),
      },
    };
  });
  const observedDim = Math.max(0, Math.trunc(Number(input && input.observedDim) || 0));
  if (observedDim && observedDim !== dimension) throw new TypeError('vector.apply observedDim does not match item vectors');
  return { items: mapped, dimension, namespace };
}

function vectorLinks(input, namespace) {
  return toArray(input && input.links).map(function (link, index) {
    const source = requireString(link && (link.fromId || link.src || link.sourceId), 'links[' + index + '].source');
    const target = requireString(link && (link.toId || link.dst || link.targetId), 'links[' + index + '].target');
    return {
      src: { externalId: source, namespace },
      dst: { externalId: target, namespace },
      label: String(link && (link.relation || link.label) || 'related'),
      weight: Number(link && (link.weight ?? link.strength ?? 1)) || 1,
    };
  });
}

async function handleVectorApply(txCtx, input, request) {
  input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const normalized = vectorItems(input);
  const links = vectorLinks(input, normalized.namespace);
  const key = requireString(request && request.idempotencyKey, 'idempotencyKey', 1024);
  const requestFingerprint = fingerprint(input);
  return await txCtx.locks.withLock('vector:' + normalized.namespace, { timeoutMs: 30000 }, async function () {
    return await txCtx.idempotency.run(key, requestFingerprint, async function () {
      const upsert = await txCtx.trivium.bulkUpsert({
        database: VECTOR_DATABASE,
        dim: normalized.dimension,
        items: normalized.items,
      });
      const linked = links.length
        ? await txCtx.trivium.bulkLink({ database: VECTOR_DATABASE, items: links })
        : { totalCount: 0, successCount: 0, failureCount: 0, failures: [] };
      const result = {
        ok: Number(upsert.failureCount || 0) === 0 && Number(linked.failureCount || 0) === 0,
        database: VECTOR_DATABASE,
        namespace: normalized.namespace,
        observedDim: normalized.dimension,
        manifest: {
          database: VECTOR_DATABASE,
          namespace: normalized.namespace,
          observedDim: normalized.dimension,
          collectionId: String(input.collectionId || ''),
          chatId: String(input.chatId || ''),
          modelScope: String(input.modelScope || ''),
          graphRevision: Math.max(0, Math.trunc(Number(input.graphRevision) || 0)),
          vectorSpaceId: String(input.vectorSpaceId || ''),
        },
        upsert,
        links: linked,
        skippedLinkCount: 0,
        appliedAt: new Date().toISOString(),
      };
      if (!result.ok) throw new Error('vector.apply completed with partial failures');
      return result;
    });
  });
}

function sanitizeCandidate(hit, source) {
  if (!hit || typeof hit !== 'object') return null;
  const externalId = String(hit.externalId || hit.nodeId || hit.id || '').trim();
  if (!externalId) return null;
  const value = {
    externalId,
    score: Math.max(0, Number(hit.score != null ? hit.score : hit.similarity) || 0),
    source,
  };
  const internalId = Number(hit.id != null ? hit.id : hit.internalId);
  if (Number.isFinite(internalId) && internalId > 0) value.internalId = internalId;
  const namespace = String(hit.namespace || '').trim();
  if (namespace) value.namespace = namespace;
  return value;
}

async function handleRecallCandidates(txCtx, input, logger) {
  input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const texts = toArray(input.queryTexts).map(String).filter(function (value) { return value.trim(); });
  const vectors = toArray(input.queryVectors).map(function (value, index) {
    return normalizeVector(value, 'queryVectors[' + index + ']');
  });
  if (!texts.length && !vectors.length) throw new TypeError('recall.candidates requires a query');
  const observedDim = Math.max(0, Math.trunc(Number(input.observedDim) || 0));
  if (observedDim && vectors.some(function (vector) { return vector.length !== observedDim; })) {
    throw new TypeError('recall.candidates query vector dimension mismatch');
  }
  const topK = Math.min(200, Math.max(1, Math.trunc(Number(input.topK) || 10)));
  const expandDepth = Math.min(5, Math.max(0, Math.trunc(Number(input.expandDepth) || 0)));
  const expectedNamespace = vectorNamespace(input);
  const candidates = [];
  const seen = new Set();
  const count = Math.max(texts.length, vectors.length);
  for (let index = 0; index < count; index += 1) {
    const request = { database: VECTOR_DATABASE, topK, expandDepth: 0 };
    if (texts[index]) request.queryText = texts[index];
    if (vectors[index]) request.vector = vectors[index];
    if (Number.isFinite(Number(input.minScore))) request.minScore = Number(input.minScore);
    if (Number.isFinite(Number(input.hybridAlpha))) request.hybridAlpha = Number(input.hybridAlpha);
    if (input.payloadFilter && typeof input.payloadFilter === 'object' && !Array.isArray(input.payloadFilter)) {
      request.payloadFilter = input.payloadFilter;
    }
    const hits = toArray(await txCtx.trivium.searchHybrid(request));
    for (const hit of hits) {
      const candidate = sanitizeCandidate(hit, 'search');
      if (candidate && candidate.namespace === expectedNamespace && !seen.has(candidate.externalId)) {
        seen.add(candidate.externalId);
        candidates.push(candidate);
      }
    }
  }
  if (expandDepth && candidates.length) {
    try {
      const resolved = await txCtx.trivium.resolveMany({
        database: VECTOR_DATABASE,
        items: candidates.slice(0, topK).map(function (item) {
          return { externalId: item.externalId, namespace: item.namespace || vectorNamespace(input) };
        }),
      });
      for (const item of toArray(resolved && resolved.items)) {
        const internalId = Number(item && item.id);
        if (!Number.isFinite(internalId) || internalId <= 0) continue;
        const neighbors = await txCtx.trivium.neighbors({ database: VECTOR_DATABASE, id: internalId, depth: expandDepth });
        for (const node of toArray(neighbors && (neighbors.nodes || neighbors.neighbors))) {
          const candidate = sanitizeCandidate(node, 'expand');
          if (candidate && candidate.namespace === expectedNamespace && !seen.has(candidate.externalId)) {
            seen.add(candidate.externalId);
            candidates.push(candidate);
          }
        }
      }
    } catch (error) {
      if (logger && logger.warn) logger.warn('[st-bme] vector expansion failed: ' + String(error && error.message || error));
    }
  }
  return {
    ok: true,
    database: VECTOR_DATABASE,
    namespace: vectorNamespace(input),
    collectionId: String(input.collectionId || ''),
    chatId: String(input.chatId || ''),
    graphRevision: Math.max(0, Math.trunc(Number(input.graphRevision) || 0)),
    modelScope: String(input.modelScope || ''),
    vectorSpaceId: String(input.vectorSpaceId || ''),
    observedDim,
    candidates,
    queryCount: count,
    searchedAt: new Date().toISOString(),
  };
}

module.exports.activate = async function activate(ctx) {
  if (!ctx || typeof ctx.registerTransaction !== 'function') {
    throw new Error('BME companion module requires registerTransaction');
  }
  const coreUrl = pathToFileURL(path.resolve(ctx.moduleDir, '..', 'src', 'core', 'state-reducer.js')).href;
  const core = await import(coreUrl);

  ctx.registerTransaction('state.read', {
    handler: async function (txCtx, input) {
      try {
        return { result: await handleStateRead(txCtx, input, core) };
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
          return { result: domainFailure(error) };
        }
        throw error;
      }
    },
  });
  ctx.registerTransaction('state.command', {
    handler: async function (txCtx, input, request) {
      try {
        return { result: await handleStateCommand(txCtx, input, request, core) };
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
          return { result: domainFailure(error) };
        }
        throw error;
      }
    },
  });
  ctx.registerTransaction('vector.manifest', {
    handler: async function (txCtx, input) {
      const stat = await txCtx.trivium.stat({
        database: VECTOR_DATABASE,
        includeMappingIntegrity: Boolean(input && input.includeMappingIntegrity),
      });
      return {
        result: {
          ok: true,
          database: VECTOR_DATABASE,
          manifest: {
            ...stat,
            database: VECTOR_DATABASE,
            collectionId: String(input && input.collectionId || ''),
            chatId: String(input && input.chatId || ''),
            modelScope: String(input && input.modelScope || ''),
            graphRevision: Math.max(0, Math.trunc(Number(input && input.graphRevision) || 0)),
            vectorSpaceId: String(input && input.vectorSpaceId || ''),
            observedDim: Math.max(0, Math.trunc(Number(input && input.observedDim) || 0)),
          },
        },
      };
    },
  });
  ctx.registerTransaction('vector.apply', {
    handler: async function (txCtx, input, request) {
      return { result: await handleVectorApply(txCtx, input, request) };
    },
  });
  ctx.registerTransaction('recall.candidates', {
    handler: async function (txCtx, input) {
      return { result: await handleRecallCandidates(txCtx, input, ctx.logger) };
    },
  });
  if (ctx.logger && ctx.logger.info) ctx.logger.info('[st-bme] vNext companion module activated');
};

module.exports.STATE_DATABASE = STATE_DATABASE;
module.exports.VECTOR_DATABASE = VECTOR_DATABASE;
module.exports.STATE_MIGRATIONS = STATE_MIGRATIONS;
module.exports._buildWriteStatements = buildWriteStatements;
module.exports._domainFailure = domainFailure;
