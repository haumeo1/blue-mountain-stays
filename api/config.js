import { demoModeEnabled } from "../server/config.js";
import { sendJson } from "../server/http.js";
import { databaseConfigured, publicSupabaseConfig } from "../server/integrations/supabase.js";

export default function handler(request, response) {
  const publicConfig = publicSupabaseConfig();
  sendJson(response, 200, {
    demoMode: demoModeEnabled(),
    databaseConnected: databaseConfigured(),
    supabaseUrl: publicConfig.url,
    supabasePublishableKey: publicConfig.publishableKey,
    stripeEnabled: process.env.STRIPE_ENABLED === "true",
    calendarFeedConfigured: Boolean(process.env.CALENDAR_FEED_TOKEN)
  });
}
