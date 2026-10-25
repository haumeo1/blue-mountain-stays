import { sendJson } from "./_lib/http.js";
import { databaseConfigured, publicSupabaseConfig } from "./_lib/supabase.js";

export default function handler(request, response) {
  const publicConfig = publicSupabaseConfig();
  sendJson(response, 200, {
    databaseConnected: databaseConfigured(),
    supabaseUrl: publicConfig.url,
    supabasePublishableKey: publicConfig.publishableKey,
    stripeEnabled: process.env.STRIPE_ENABLED === "true",
    calendarFeedConfigured: Boolean(process.env.CALENDAR_FEED_TOKEN)
  });
}
