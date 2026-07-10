// ClickMatch PayPal Integration
// Uses PayPal REST API v2 to create orders and capture payments.
// Full PayPal API reference: https://developer.paypal.com/api/rest/

import { Env } from './types';

interface PayPalToken {
  access_token: string;
  expires_in: number;
}

interface PayPalOrder {
  id: string;
  status: string;
}

let cachedToken: PayPalToken | null = null;
let tokenExpiresAt = 0;

/**
 * Get a fresh PayPal oauth2 access token (client_credentials grant).
 * Tokens are cached and auto-refreshed when within 60s of expiry.
 */
async function getAccessToken(env: Env): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken.access_token;
  }

  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  const apiUrl = env.PAYPAL_API_URL || 'https://api-m.sandbox.paypal.com';

  if (!clientId || !clientSecret) {
    throw new Error('PayPal credentials not configured');
  }

  const auth = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch(`${apiUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new Error(`PayPal auth failed: ${response.status}`);
  }

  cachedToken = await response.json() as PayPalToken;
  tokenExpiresAt = Date.now() + cachedToken.expires_in * 1000;
  return cachedToken.access_token;
}

/**
 * Create a PayPal order.
 * amountCents: 100 = $1.00
 * Returns the PayPal order object with id for client-side approval.
 */
export async function createOrder(
  env: Env,
  amountCents: number,
): Promise<PayPalOrder> {
  const token = await getAccessToken(env);
  const apiUrl = env.PAYPAL_API_URL || 'https://api-m.sandbox.paypal.com';

  const amount = (amountCents / 100).toFixed(2);

  const response = await fetch(`${apiUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'USD',
            value: amount,
          },
          description: `ClickMatch — ${amountCents} clicks`,
        },
      ],
      application_context: {
        brand_name: 'ClickMatch',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
      },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`PayPal create order failed: ${response.status} ${errBody}`);
  }

  return response.json() as Promise<PayPalOrder>;
}

/**
 * Capture (complete) a previously created PayPal order.
 * This is called after the buyer approves the payment in PayPal popup.
 * Returns the order object with status (should be "COMPLETED").
 */
export async function captureOrder(
  env: Env,
  orderId: string,
): Promise<PayPalOrder> {
  const token = await getAccessToken(env);
  const apiUrl = env.PAYPAL_API_URL || 'https://api-m.sandbox.paypal.com';

  const response = await fetch(
    `${apiUrl}/v2/checkout/orders/${orderId}/capture`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    },
  );

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`PayPal capture failed: ${response.status} ${errBody}`);
  }

  return response.json() as Promise<PayPalOrder>;
}
