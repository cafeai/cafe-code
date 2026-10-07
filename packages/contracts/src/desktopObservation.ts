import * as Schema from "effect/Schema";
import { IsoDateTime } from "./baseSchemas.ts";

export const DesktopObservationId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
);

export const DesktopObservationRetention = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const DEFAULT_DESKTOP_OBSERVATION_RETENTION = 50;
export const DESKTOP_OBSERVATION_MAX_BYTES = 8 * 1024 * 1024;
export const DESKTOP_OBSERVATION_PATH = "/api/desktop-observations";

/** Only this bounded reference belongs in provider events; PNG bytes are private artifacts. */
export const DesktopObservationReference = Schema.Struct({
  id: DesktopObservationId,
  capturedAt: IsoDateTime.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    Schema.makeFilter((value) => {
      if (value.length !== 24) return false;
      const time = Date.parse(value);
      return Number.isFinite(time) && new Date(time).toISOString() === value;
    }),
  ),
  width: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 8192 })),
  height: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 8192 })),
  frame: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  humanControl: Schema.Boolean,
  storage: Schema.Literals(["saved", "disabled", "failed"]),
});
export type DesktopObservationReference = typeof DesktopObservationReference.Type;
