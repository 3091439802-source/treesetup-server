const crypto = require("crypto");
const axios = require("axios");

/**
 * Tencent Cloud SMS Service
 * Uses TC3-HMAC-SHA256 signing (API v3) to call SendSms.
 *
 * Required env vars:
 *   SMS_SECRET_ID    - Tencent Cloud SecretId
 *   SMS_SECRET_KEY   - Tencent Cloud SecretKey
 *   SMS_SDK_APP_ID   - SMS application ID
 *   SMS_TEMPLATE_ID  - SMS template ID
 *   SMS_SIGN_NAME    - SMS signature name
 */

const ENDPOINT = "sms.tencentcloudapi.com";
const SERVICE = "sms";
const REGION = "ap-guangzhou";
const VERSION = "2021-01-11";
const ACTION = "SendSms";

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function hmacSha256Hex(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

/**
 * Build TC3-HMAC-SHA256 Authorization header
 */
function sign(secretId, secretKey, host, service, payload, timestamp) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  // 1. Canonical Request
  const canonicalHeaders = `content-type:application/json\nhost:${host}\n`;
  const signedHeaders = "content-type;host";
  const hashedPayload = sha256Hex(payload);
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;

  // 2. String to Sign
  const algorithm = "TC3-HMAC-SHA256";
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

  // 3. Signature
  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = hmacSha256Hex(secretSigning, stringToSign);

  // 4. Authorization
  return `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * Send SMS verification code via Tencent Cloud.
 * Falls back to console.log if credentials are not configured.
 */
async function sendSms(phone, code) {
  const secretId = process.env.SMS_SECRET_ID;
  const secretKey = process.env.SMS_SECRET_KEY;
  const sdkAppId = process.env.SMS_SDK_APP_ID;
  const templateId = process.env.SMS_TEMPLATE_ID;
  const signName = process.env.SMS_SIGN_NAME || "TreeSetup";

  // Fallback: no credentials configured
  if (!secretId || !secretKey || !sdkAppId || !templateId ||
      secretId.startsWith("YOUR_") || secretKey.startsWith("YOUR_")) {
    console.log(`[SMS-FALLBACK] Code for ${phone}: ${code}`);
    return false;
  }

  // Normalize phone to +86 format
  const phoneNumber = phone.startsWith("+") ? phone : `+86${phone}`;

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    PhoneNumberSet: [phoneNumber],
    SmsSdkAppId: sdkAppId,
    TemplateId: templateId,
    SignName: signName,
    TemplateParamSet: [code]
  });

  const authorization = sign(secretId, secretKey, ENDPOINT, SERVICE, payload, timestamp);

  const response = await axios.post(`https://${ENDPOINT}`, payload, {
    headers: {
      "Content-Type": "application/json",
      "Host": ENDPOINT,
      "X-TC-Action": ACTION,
      "X-TC-Version": VERSION,
      "X-TC-Timestamp": timestamp.toString(),
      "X-TC-Region": REGION,
      "Authorization": authorization
    },
    timeout: 10000
  });

  const result = response.data;
  if (result.Response && result.Response.Error) {
    throw new Error(`SMS send failed: ${result.Response.Error.Code} - ${result.Response.Error.Message}`);
  }

  console.log(`[SMS] Sent to ${phone}: status=${result.Response?.SendStatusSet?.[0]?.Code || "unknown"}`);
  return true;
}

module.exports = { sendSms };
