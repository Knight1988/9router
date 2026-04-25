import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";
import {
  getClientIp,
  checkRateLimit,
  recordFailedAttempt,
  resetAttempts,
} from "@/lib/rateLimiter";

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, ...safeSettings } = settings;
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // If updating password, hash it
    if (body.newPassword) {
      const ip = getClientIp(request);
      const rateCheck = checkRateLimit(ip);
      if (rateCheck.limited) {
        const retryAfterSec = Math.ceil(rateCheck.retryAfterMs / 1000);
        return NextResponse.json(
          {
            error: "Too many failed attempts. Please try again later.",
            retryAfter: retryAfterSec,
            remaining: 0,
          },
          {
            status: 429,
            headers: { "Retry-After": String(retryAfterSec) },
          }
        );
      }

      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          const result = recordFailedAttempt(ip);
          if (result.locked) {
            const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
            return NextResponse.json(
              {
                error: "Too many failed attempts. Please try again later.",
                retryAfter: retryAfterSec,
                remaining: 0,
              },
              {
                status: 429,
                headers: { "Retry-After": String(retryAfterSec) },
              }
            );
          }
          return NextResponse.json(
            { error: "Invalid current password", remaining: result.remaining },
            { status: 401 }
          );
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
          const result = recordFailedAttempt(ip);
          if (result.locked) {
            const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
            return NextResponse.json(
              {
                error: "Too many failed attempts. Please try again later.",
                retryAfter: retryAfterSec,
                remaining: 0,
              },
              {
                status: 429,
                headers: { "Retry-After": String(retryAfterSec) },
              }
            );
          }
          return NextResponse.json(
            { error: "Invalid current password", remaining: result.remaining },
            { status: 401 }
          );
        }
      }

      resetAttempts(ip);
      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    // Clamp numeric auto-compact settings to valid ranges
    if (Object.prototype.hasOwnProperty.call(body, "autoCompactTokenThreshold")) {
      const v = parseInt(body.autoCompactTokenThreshold, 10);
      if (!isNaN(v)) body.autoCompactTokenThreshold = Math.min(2_000_000, Math.max(1000, v));
    }
    if (Object.prototype.hasOwnProperty.call(body, "autoCompactTailTurns")) {
      const v = parseInt(body.autoCompactTailTurns, 10);
      if (!isNaN(v)) body.autoCompactTailTurns = Math.min(20, Math.max(0, v));
    }
    if (Object.prototype.hasOwnProperty.call(body, "autoCompactSummarizerModel")) {
      const raw = body.autoCompactSummarizerModel;
      if (Array.isArray(raw)) {
        // Validate: keep non-empty string entries
        body.autoCompactSummarizerModel = raw.map((m) => String(m).trim()).filter(Boolean);
      } else {
        // Backward-compat: string input -> single-element array (or empty)
        const v = String(raw || "").trim();
        body.autoCompactSummarizerModel = v ? [v] : [];
      }
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    const { password, ...safeSettings } = settings;
    return NextResponse.json(safeSettings);
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
