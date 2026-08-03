import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

import { handleBackupRequest } from "../_shared/backup-export.ts";

const url = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

export default {
  fetch(request: Request) {
    if (!url || !serviceRoleKey) {
      return Response.json({ error: "Unavailable" }, { status: 503 });
    }
    const admin = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    return handleBackupRequest(request, {
      admin,
      secrets: {
        evidence: Deno.env.get("BACKUP_EVIDENCE_SECRET"),
        ordinary: Deno.env.get("BACKUP_ORDINARY_SECRET"),
      },
    });
  },
};
