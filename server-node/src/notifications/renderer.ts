import { extractOtpCandidates } from '../crypto/otp-extraction.js';
import type {
  NotificationContentMode,
  NotificationDelivery,
} from '../repositories/notification-repository.js';

export interface RenderableDelivery extends NotificationDelivery {
  payload?: Record<string, unknown>;
}

export function renderFeishuNotification(
  delivery: RenderableDelivery,
): string | null {
  if (delivery.kind === 'TEST') {
    return [
      'CAConnection 飞书推送测试',
      `内容模式：${delivery.contentMode === 'REDACTED' ? '脱敏' : '明文'}`,
      `时间：${formatTime(delivery.createdAt)}`,
      '结果：飞书 Webhook 配置工作正常',
    ].join('\n');
  }
  if (delivery.kind === 'DEVICE_ALERT') {
    const payload = delivery.alertPayload;
    if (!payload) throw new Error('notification event is unavailable');
    const alertType = stringValue(payload.alertType);
    const deviceId = stringValue(payload.deviceId) || '未知';
    const detectedAt = numberValue(payload.detectedAt) || delivery.createdAt;
    const lastSeenAt = numberValue(payload.lastSeenAt);
    const outageDurationMs = numberValue(payload.outageDurationMs);
    if (alertType === 'RECOVERED') {
      return [
        'CAConnection 网关已恢复',
        `设备：${deviceId}`,
        `恢复时间：${formatTime(detectedAt)}`,
        `离线时长：${formatDuration(outageDurationMs)}`,
      ].join('\n');
    }
    return [
      alertType === 'CRITICAL' ? 'CAConnection 网关严重失联' : 'CAConnection 网关失联',
      `设备：${deviceId}`,
      `最后在线：${lastSeenAt > 0 ? formatTime(lastSeenAt) : '未知'}`,
      `已失联：${formatDuration(outageDurationMs)}`,
      '服务端仍在运行，请检查手机网络、应用进程或 HyperOS 后台限制。',
    ].join('\n');
  }

  const payload = delivery.payload;
  if (!payload || !delivery.deviceId || !delivery.eventType || delivery.receivedAt === null) {
    throw new Error('notification event is unavailable');
  }

  if (delivery.eventType === 'INCOMING_SMS') {
    return renderSms(delivery, payload);
  }
  if (delivery.eventType === 'NOTIFICATION') {
    return renderCapturedNotification(delivery, payload);
  }
  if (delivery.eventType === 'CALL_STATE') {
    return renderIncomingCall(delivery, payload);
  }
  return null;
}

function renderSms(
  delivery: RenderableDelivery,
  payload: Record<string, unknown>,
): string {
  const sender = typeof payload.originatingAddress === 'string'
    ? payload.originatingAddress
    : null;
  const body = typeof payload.body === 'string' ? payload.body : '';
  const otpCandidates = extractOtpCandidates(body);
  const lines = [
    'CAConnection 收到新短信',
    `设备：${delivery.deviceId}`,
    `线路：${simLabel(delivery.slotIndex)}`,
    `发送方：${delivery.contentMode === 'REDACTED' ? maskIdentifier(sender) : (sender ?? '未知')}`,
    `时间：${formatTime(delivery.receivedAt!)}`,
  ];
  if (delivery.contentMode === 'REDACTED') {
    lines.push(`正文：已脱敏（${body.length} 个字符）`);
    if (otpCandidates.length > 0) lines.push('提示：可能包含验证码');
  } else {
    lines.push(`正文：${body.slice(0, 4_000) || '（空）'}`);
    if (otpCandidates.length > 0) {
      lines.push(`验证码候选：${otpCandidates.slice(0, 5).join('、')}`);
    }
  }
  return lines.join('\n');
}

function renderIncomingCall(
  delivery: RenderableDelivery,
  payload: Record<string, unknown>,
): string {
  const caller = typeof payload.callerAddress === 'string'
    ? payload.callerAddress
    : null;
  const displayName = typeof payload.callerDisplayName === 'string'
    ? payload.callerDisplayName
    : null;
  const lines = [
    'CAConnection 来电提醒',
    `设备：${delivery.deviceId}`,
    `线路：${simLabel(delivery.slotIndex)}`,
    `时间：${formatTime(delivery.receivedAt!)}`,
    `来电号码：${delivery.contentMode === 'REDACTED' ? maskIdentifier(caller) : (caller ?? '未知')}`,
  ];
  if (displayName) {
    lines.push(`联系人：${delivery.contentMode === 'REDACTED' ? maskIdentifier(displayName) : displayName}`);
  }
  return lines.join('\n');
}

function renderCapturedNotification(
  delivery: RenderableDelivery,
  payload: Record<string, unknown>,
): string | null {
  if (payload.eventType === 'REMOVED') return null;
  const source = typeof payload.sourcePackage === 'string' ? payload.sourcePackage : '未知';
  const title = typeof payload.title === 'string' ? payload.title : '';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const lines = [
    'CAConnection 收到应用通知',
    `设备：${delivery.deviceId}`,
    `来源应用：${source}`,
    `时间：${formatTime(delivery.receivedAt!)}`,
  ];
  if (delivery.contentMode === 'REDACTED') {
    lines.push(`标题：已脱敏（${title.length} 个字符）`);
    lines.push(`正文：已脱敏（${body.length} 个字符）`);
  } else {
    lines.push(`标题：${title.slice(0, 1_000) || '（空）'}`);
    lines.push(`正文：${body.slice(0, 4_000) || '（空）'}`);
  }
  return lines.join('\n');
}

function simLabel(slotIndex: number | null): string {
  return slotIndex === null ? 'SIM 未识别' : `SIM${slotIndex + 1}`;
}

function maskIdentifier(value: string | null): string {
  if (!value) return '未知';
  if (value.length <= 4) return '*'.repeat(value.length);
  if (value.length <= 8) {
    return `${value.slice(0, 1)}${'*'.repeat(value.length - 2)}${value.slice(-1)}`;
  }
  return `${value.slice(0, 3)}${'*'.repeat(value.length - 7)}${value.slice(-4)}`;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatDuration(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

const FEISHU_TIME_ZONE_OFFSET_MS = 8 * 3_600_000;

function formatTime(timestampMs: number): string {
  const shifted = new Date(timestampMs + FEISHU_TIME_ZONE_OFFSET_MS);
  const date = [
    shifted.getUTCFullYear(),
    padded(shifted.getUTCMonth() + 1),
    padded(shifted.getUTCDate()),
  ].join('-');
  const time = [
    padded(shifted.getUTCHours()),
    padded(shifted.getUTCMinutes()),
    padded(shifted.getUTCSeconds()),
  ].join(':');
  return `${date} ${time}`;
}

function padded(value: number): string {
  return String(value).padStart(2, '0');
}

export function isNotificationContentMode(value: string): value is NotificationContentMode {
  return value === 'REDACTED' || value === 'FULL';
}
