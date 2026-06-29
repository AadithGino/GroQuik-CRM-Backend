import crypto from 'crypto';

export function verifyMetaWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return true;
  if (!signatureHeader || !rawBody) return false;

  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signatureHeader);

  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}
