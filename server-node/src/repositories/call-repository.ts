import type { DatabaseSync } from 'node:sqlite';
import { CALL_IDENTITY_CORRELATION_WINDOW_MS } from '../config/constants.js';
import { decryptPayload } from '../crypto/payload-crypto.js';
import { queryAll } from '../database/helpers.js';

interface CallEventRow {
  id: number;
  device_id: string;
  event_type: 'CALL_STATE' | 'CALL_IDENTITY';
  created_at: number;
  received_at: number;
  subscription_id: number | null;
  slot_index: number | null;
  envelope_json: string;
}

export interface CallStateEntry {
  state: 'RINGING' | 'OFFHOOK' | 'IDLE';
  observedAt: number;
  initialSnapshot: boolean;
}

export interface CallRecord {
  id: number;
  deviceId: string;
  sessionId: string | null;
  createdAt: number;
  receivedAt: number;
  startedAt: number;
  endedAt: number | null;
  durationMillis: number | null;
  subscriptionId: number | null;
  slotIndex: number | null;
  direction: 'INCOMING' | 'UNKNOWN';
  state: 'RINGING' | 'OFFHOOK' | 'IDLE' | null;
  answered: boolean;
  states: CallStateEntry[];
  callerAddress: string | null;
  callerDisplayName: string | null;
  resolutionMethod: string | null;
  resolutionConfidence: string | null;
  verificationStatus: number | null;
  decision: string | null;
}

interface MutableCallRecord extends CallRecord {
  identityObservedAt: number | null;
}

export class CallRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(
    secrets: Map<string, Buffer>,
    limit: number,
    options: {
      afterId?: number;
      beforeId?: number;
      slotIndex?: number;
      deviceId?: string;
      deviceIds?: Set<string>;
    } = {},
  ): CallRecord[] {
    const clauses = ["event_type IN ('CALL_STATE', 'CALL_IDENTITY')"];
    const params: (string | number)[] = [];

    if (options.afterId !== undefined) { clauses.push('id > ?'); params.push(options.afterId); }
    if (options.beforeId !== undefined) { clauses.push('id < ?'); params.push(options.beforeId); }
    if (options.slotIndex !== undefined) { clauses.push('slot_index = ?'); params.push(options.slotIndex); }
    if (options.deviceId !== undefined) { clauses.push('device_id = ?'); params.push(options.deviceId); }
    if (options.deviceIds !== undefined) {
      if (options.deviceIds.size === 0) return [];
      const ids = [...options.deviceIds].sort();
      clauses.push(`device_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }

    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    params.push(Math.min(boundedLimit * 8, 800));
    const rows = queryAll<CallEventRow>(this.db, `
      SELECT id, device_id, event_type, created_at, received_at,
             subscription_id, slot_index, envelope_json
      FROM events
      WHERE ${clauses.join(' AND ')}
      ORDER BY id DESC
      LIMIT ?
    `, ...params);

    const calls = new Map<string, MutableCallRecord>();
    const identities: Array<{
      row: CallEventRow;
      payload: Record<string, unknown>;
    }> = [];

    for (const row of rows) {
      const secret = secrets.get(row.device_id);
      if (!secret) continue;
      const envelope = decryptPayload(
        JSON.parse(row.envelope_json),
        row.device_id,
        secret,
      );
      const payload = envelope.payload as Record<string, unknown>;
      if (row.event_type === 'CALL_IDENTITY') {
        identities.push({ row, payload });
        continue;
      }

      const sessionId = stringValue(payload.sessionId);
      const state = callState(payload.state);
      const observedAt = integerValue(payload.observedAt);
      if (!sessionId || !state || observedAt === null) continue;
      const key = `${row.device_id}:${sessionId}`;
      const existing = calls.get(key) ?? emptyCall(row, sessionId, observedAt);
      existing.id = Math.max(existing.id, row.id);
      existing.createdAt = Math.min(existing.createdAt, row.created_at);
      existing.receivedAt = Math.max(existing.receivedAt, row.received_at);
      existing.startedAt = Math.min(existing.startedAt, observedAt);
      existing.subscriptionId = row.subscription_id ?? existing.subscriptionId;
      existing.slotIndex = row.slot_index ?? existing.slotIndex;
      existing.states.push({
        state,
        observedAt,
        initialSnapshot: payload.initialSnapshot === true,
      });
      calls.set(key, existing);
    }

    for (const call of calls.values()) finalizeStates(call);

    for (const identity of identities) {
      const observedAt = integerValue(identity.payload.observedAt)
        ?? identity.row.created_at;
      const matching = nearestCall(calls, identity.row, observedAt);
      const call = matching ?? emptyCall(
        identity.row,
        null,
        observedAt,
      );
      call.id = Math.max(call.id, identity.row.id);
      call.createdAt = Math.min(call.createdAt, identity.row.created_at);
      call.receivedAt = Math.max(call.receivedAt, identity.row.received_at);
      call.startedAt = Math.min(call.startedAt, observedAt);
      call.direction = 'INCOMING';
      call.subscriptionId = identity.row.subscription_id ?? call.subscriptionId;
      call.slotIndex = identity.row.slot_index ?? call.slotIndex;
      call.callerAddress = stringValue(identity.payload.callerAddress);
      call.callerDisplayName = stringValue(identity.payload.callerDisplayName);
      call.resolutionMethod = stringValue(identity.payload.resolutionMethod);
      call.resolutionConfidence = stringValue(identity.payload.resolutionConfidence);
      call.verificationStatus = integerValue(identity.payload.verificationStatus);
      call.decision = stringValue(identity.payload.decision);
      call.identityObservedAt = observedAt;
      if (!matching) {
        calls.set(`${identity.row.device_id}:identity:${identity.row.id}`, call);
      }
    }

    return [...calls.values()]
      .sort((left, right) => right.id - left.id)
      .slice(0, boundedLimit)
      .map(({ identityObservedAt: _identityObservedAt, ...call }) => call);
  }
}

function emptyCall(
  row: CallEventRow,
  sessionId: string | null,
  observedAt: number,
): MutableCallRecord {
  return {
    id: row.id,
    deviceId: row.device_id,
    sessionId,
    createdAt: row.created_at,
    receivedAt: row.received_at,
    startedAt: observedAt,
    endedAt: null,
    durationMillis: null,
    subscriptionId: row.subscription_id,
    slotIndex: row.slot_index,
    direction: 'UNKNOWN',
    state: null,
    answered: false,
    states: [],
    callerAddress: null,
    callerDisplayName: null,
    resolutionMethod: null,
    resolutionConfidence: null,
    verificationStatus: null,
    decision: null,
    identityObservedAt: null,
  };
}

function finalizeStates(call: MutableCallRecord): void {
  call.states.sort((left, right) => left.observedAt - right.observedAt);
  call.state = call.states.at(-1)?.state ?? null;
  call.direction = call.states.some(entry => entry.state === 'RINGING')
    ? 'INCOMING'
    : call.direction;
  call.answered = call.states.some(entry => entry.state === 'OFFHOOK');
  const offhookAt = call.states.find(entry => entry.state === 'OFFHOOK')?.observedAt;
  const endedAt = [...call.states]
    .reverse()
    .find(entry => entry.state === 'IDLE' && (
      offhookAt === undefined || entry.observedAt >= offhookAt
    ))?.observedAt;
  call.endedAt = endedAt ?? null;
  call.durationMillis = offhookAt !== undefined && endedAt !== undefined
    ? Math.max(0, endedAt - offhookAt)
    : null;
}

function nearestCall(
  calls: Map<string, MutableCallRecord>,
  identityRow: CallEventRow,
  observedAt: number,
): MutableCallRecord | null {
  const candidates = [...calls.values()]
    .filter(call =>
      call.deviceId === identityRow.device_id
      && (
        identityRow.slot_index === null
        || call.slotIndex === null
        || call.slotIndex === identityRow.slot_index
      )
      && Math.abs(call.startedAt - observedAt) <= CALL_IDENTITY_CORRELATION_WINDOW_MS,
    )
    .sort((left, right) =>
      Math.abs(left.startedAt - observedAt)
      - Math.abs(right.startedAt - observedAt),
    );
  return candidates[0] ?? null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function integerValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function callState(value: unknown): CallStateEntry['state'] | null {
  return value === 'RINGING' || value === 'OFFHOOK' || value === 'IDLE'
    ? value
    : null;
}
