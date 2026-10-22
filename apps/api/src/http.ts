import { z } from "zod";
import { zonedToUtcIso } from "@homerelay/shared";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export const parse = <T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> => {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, "INVALID_REQUEST", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
};

/** Local wall-clock "YYYY-MM-DDTHH:mm" (what a datetime-local input produces) in the app time zone. */
export const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "use YYYY-MM-DDTHH:mm");

export function toUtc(local: string | undefined, tz: string): string | undefined {
  if (!local) return undefined;
  const [d, t] = local.split("T"); const [y, mo, da] = d.split("-").map(Number); const [h, mi] = t.split(":").map(Number);
  const cal = new Date(Date.UTC(y, mo - 1, da));
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== da || h > 23 || mi > 59) throw new HttpError(400, "INVALID_REQUEST", `${local} is not a valid date and time`);
  const iso = zonedToUtcIso(y, mo, da, h, mi, tz);
  const back = new Date(iso); if (Number.isNaN(back.getTime())) throw new HttpError(400, "INVALID_REQUEST", `${local} is not a valid date and time`);
  return iso;
}
