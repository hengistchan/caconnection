import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createFeishuSignature,
  FeishuWebhookClient,
  NotificationTransportError,
} from '../../src/notifications/feishu-client.js';

const webhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefghijklmnop';

describe('Feishu webhook client', () => {
  it('builds the documented HMAC signature', () => {
    const expected = createHmac('sha256', '1700000000\nsecret')
      .update('')
      .digest('base64');
    expect(createFeishuSignature('secret', 1_700_000_000)).toBe(expected);
  });

  it('posts a text message with signing and refuses redirects', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ code: 0, msg: 'success' }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    ));
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const client = new FeishuWebhookClient(
      { webhookUrl, signingSecret: 'secret' },
      fetchMock as typeof fetch,
    );

    await client.sendText('hello');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(webhookUrl);
    expect(options.redirect).toBe('error');
    expect(JSON.parse(options.body as string)).toEqual({
      msg_type: 'text',
      content: { text: 'hello' },
      timestamp: '1700000000',
      sign: createFeishuSignature('secret', 1_700_000_000),
    });
    now.mockRestore();
  });

  it('treats non-zero Feishu responses as delivery failures', async () => {
    const client = new FeishuWebhookClient(
      { webhookUrl, signingSecret: null },
      (async () => new Response(
        JSON.stringify({ StatusCode: 19001, StatusMessage: 'bad request' }),
        { status: 200 },
      )) as typeof fetch,
    );
    await expect(client.sendText('hello')).rejects.toThrow(
      'Feishu webhook rejected the message',
    );
    await expect(client.sendText('hello')).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('retries rate limits but not permanent HTTP rejections', async () => {
    const clientFor = (status: number) => new FeishuWebhookClient(
      { webhookUrl, signingSecret: null },
      (async () => new Response('rejected', { status })) as typeof fetch,
    );

    await expect(clientFor(429).sendText('hello')).rejects.toEqual(
      expect.objectContaining<Partial<NotificationTransportError>>({
        retryable: true,
      }),
    );
    await expect(clientFor(403).sendText('hello')).rejects.toEqual(
      expect.objectContaining<Partial<NotificationTransportError>>({
        retryable: false,
      }),
    );
  });
});
