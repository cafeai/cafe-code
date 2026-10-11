// This file is loaded as inert source text, not imported into Cafe's JS realm.
// Keep it self-contained: the only authority is a one-use MessagePort from the
// parent that created this opaque-origin frame with subresource traffic denied.
(() => {
  window.addEventListener("message", async function receive(event) {
    if (event.source !== parent || event.data !== "cafe-mermaid-render" || event.ports.length !== 1)
      return;
    window.removeEventListener("message", receive);
    const port = event.ports[0];
    port.onmessage = async ({ data }) => {
      port.onmessage = null;
      try {
        if (
          !data ||
          typeof data.id !== "string" ||
          data.id.length > 64 ||
          typeof data.source !== "string" ||
          data.source.length > 32768 ||
          new TextEncoder().encode(data.source).length > 32768 ||
          (data.theme !== "dark" && data.theme !== "light") ||
          /%%\s*\{/.test(data.source) ||
          data.source.trimStart().startsWith("---") ||
          /(?:^|[;\r\n])\s*click\s/i.test(data.source) ||
          // Match the parent scan's bounded brace segment. Canonical image
          // nodes are separately rejected after parsing below.
          /@\s*\{[^{}]*["']?\bimg\b["']?\s*:/i.test(data.source) ||
          "desktopBridge" in window
        )
          throw new Error();

        // Pinned12's Gantt getTasks() is not a passive accessor: it resolves dates
        // and can walk thousands of excluded calendar days per task. Recover
        // the bounded native raw-task keys before parsing, then bind those keys
        // to findTaskById below, before allowing that resolving accessor to run.
        // This is conservative admission, never a source repair or substitute
        // renderer. Unqualified grammar remains available as literal source.
        const prepareGantt = (source) => {
          const model = {
            tasks: [],
            sections: [],
            format: "",
            axis: "",
            tick: undefined,
            marker: "",
            weekday: "sunday",
            inclusive: false,
          };
          const names = new Set();
          const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
          const safeName = (name) => typeof name === "string" && !reserved.has(name);
          const tags = ["active", "done", "crit", "milestone", "vert"];
          let section = "";
          let generated = 0;
          let header = false;
          let description = false;
          let taskOrder = 0;
          let dependencies = 0;
          const directives = new Set();
          for (const original of source.split(/\r?\n/)) {
            const line = original.trim();
            if (description) {
              if (line === "}") description = false;
              else if (line.includes("}")) throw new Error();
              continue;
            }
            if (!line || line.startsWith("%%")) continue;
            if (!header) {
              if (line !== "gantt") throw new Error();
              header = true;
              continue;
            }
            if (/^accDescr\s*\{\s*$/i.test(line)) {
              description = true;
              continue;
            }
            if (/^(?:title\s+|accTitle\s*:|accDescr\s*:|accDescription\s+)/i.test(line)) continue;
            const directive =
              /^(dateFormat|axisFormat|tickInterval|todayMarker|weekday)\s+(.+)$/i.exec(line);
            if (directive) {
              // Repeated declarations or metadata after tasks can retroactively
              // change native date interpretation. Refuse that ambiguity.
              const kind = directive[1].toLowerCase();
              if (directives.has(kind) || model.tasks.length) throw new Error();
              directives.add(kind);
              const value = directive[2].trim();
              if (kind === "dateformat") {
                if (value !== "YYYY-MM-DD") throw new Error();
                model.format = value;
              } else if (kind === "axisformat") {
                if (value.length > 128 || /[#;\u0000-\u001f]/.test(value)) throw new Error();
                model.axis = value;
              } else if (kind === "tickinterval") {
                if (!/^[1-9]\d*(?:millisecond|second|minute|hour|day|week|month)$/.test(value))
                  throw new Error();
                // Week .every(n) has no field shortcut: its filtered interval
                // walks native weeks until a count multiple is found. Bound n
                // itself as well as the eventual tick count before that walk.
                if (
                  !Number.isSafeInteger(Number.parseInt(value, 10)) ||
                  Number.parseInt(value, 10) > 250
                )
                  throw new Error();
                model.tick = value;
              } else if (kind === "todaymarker") {
                // A nonempty native marker value is injected as layout CSS.
                // Only its documented off switch is inert, not "default".
                if (value !== "off") throw new Error();
                model.marker = value;
              } else {
                if (!/^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.test(value))
                  throw new Error();
                model.weekday = value;
              }
              continue;
            }
            if (line === "inclusiveEndDates") {
              if (model.inclusive || model.tasks.length) throw new Error();
              model.inclusive = true;
              continue;
            }
            const sectionLine = /^section\s+(.+)$/i.exec(line);
            if (sectionLine) {
              section = sectionLine[1].trim();
              // Numeric object keys are reordered by native Object.keys() when
              // it places section headings, independently of task insertion.
              // Do not display a misleading reordered heading/task association.
              if (!safeName(section) || /^\d+$/.test(section) || model.sections.includes(section))
                throw new Error();
              model.sections.push(section);
              if (model.sections.length > 250) throw new Error();
              continue;
            }
            // Exclusions/includes enter native day-by-day correction loops.
            // topAxis is not implemented by the pinned grammar's database call;
            // milestones require output CSS transforms intentionally forbidden
            // by Cafe's independent SVG policy. Preserve source for these.
            if (/^(?:excludes|includes|topAxis|weekend)\b/i.test(line)) throw new Error();
            const colon = line.indexOf(":");
            if (colon <= 0 || /[#;\r\n]/.test(line) || line.includes("%%")) throw new Error();
            const label = line.slice(0, colon).trim();
            const fields = line
              .slice(colon + 1)
              .split(",")
              .map((value) => value.trim());
            const flags = new Set();
            while (tags.includes(fields[0])) {
              if (flags.has(fields[0]) || flags.size >= tags.length) throw new Error();
              flags.add(fields.shift());
            }
            if (flags.has("milestone")) throw new Error();
            if (fields.length < 1 || fields.length > 3 || fields.some((value) => !value))
              throw new Error();
            const explicitId = fields.length === 3;
            const id = explicitId ? fields[0] : `task${++generated}`;
            if (!/^[\w-]+$/.test(id) || !safeName(id) || names.has(id)) throw new Error();
            const previous = model.tasks.at(-1)?.id;
            const start = fields.length === 1 ? undefined : fields.at(-2);
            const end = fields.at(-1);
            const refs = (value, keyword) => {
              if (!value?.startsWith(`${keyword} `)) return [];
              if (!new RegExp(`^${keyword} [\\w-]+(?: [\\w-]+)*$`).test(value)) throw new Error();
              const keys = value.slice(keyword.length + 1).split(" ");
              if (new Set(keys).size !== keys.length) throw new Error();
              for (const key of keys) if (!safeName(key) || !names.has(key)) throw new Error();
              return keys;
            };
            const after = refs(start, "after");
            const until = refs(end, "until");
            // Tiny can replace a missing or forward predecessor with today's
            // date and mark it processed. Never guess/reorder/rewrite that data.
            if (!start && !previous) throw new Error();
            dependencies += after.length + until.length + (start ? 0 : 1);
            if (dependencies > 250) throw new Error();
            names.add(id);
            model.tasks.push({
              id,
              label,
              section,
              flags,
              previous,
              start,
              end,
              after,
              until,
              data: line.slice(colon),
              order: flags.has("vert") ? -1 : taskOrder++,
            });
            if (model.tasks.length + model.sections.length > 250) throw new Error();
          }
          if (!header || description || !model.tasks.length) throw new Error();
          return model;
        };
        const ganttSource = /^(?:\s|%%[^\r\n]*(?:\r?\n|$))*gantt\b/.test(data.source)
          ? prepareGantt(data.source)
          : null;
        // Some native grammars expand packet bit offsets or block spacers
        // while parsing. Refuse those numeric expansions before obtaining a
        // parsed database; a post-parse graph budget would already be too late.
        globalThis.cafeMermaidFamilyPreflight(data.source);

        // Reject source configuration entirely; strict is not sufficient if a
        // diagram can replace security/layout/theme settings via frontmatter.
        const mermaid = globalThis.mermaid;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          logLevel: "fatal",
          maxTextSize: 32768,
          maxEdges: 250,
          theme: data.theme === "dark" ? "dark" : "default",
          // Pinned12's derived quadrant point fill contains a NaN lightness
          // in both native themes. Use the corresponding native text contrast
          // as a code-owned finite fill; never permit source theme overrides
          // or silently pass an invalid paint through image admission.
          themeVariables: {
            quadrantPointFill: data.theme === "dark" ? "#cccccc" : "#333333",
          },
          fontFamily: "Arial, sans-serif",
          htmlLabels: false,
          flowchart: { htmlLabels: false, defaultRenderer: "dagre-wrapper" },
          class: { htmlLabels: false },
          // Native journey defaults to foreignObject text, which is excluded
          // from inert image admission. Select its existing SVG text renderer
          // rather than silently dropping labels or permitting active HTML.
          journey: { textPlacement: "svg" },
          // Full12 includes gradient links by default. The inert SVG contract
          // intentionally excludes paint servers; source-node colors retain
          // the actual Sankey geometry without widening that security policy.
          sankey: { linkColor: "source" },
          // Native default treemap cells truncate even the supplied short
          // "Charts" category to "Ch...". Give its existing bounded layout
          // modestly more room, retaining source/data and native clipping for
          // labels that still cannot fit; never invent or rewrite chart text.
          treemap: { nodeWidth: 160, nodeHeight: 60 },
          look: "classic",
          layout: "dagre",
          deterministicIds: true,
          deterministicIDSeed: "cafe",
        });

        const diagram = await mermaid.mermaidAPI.getDiagramFromText(data.source);
        const db = diagram.db;
        // The pinned flowchart/swimlane/agentflow grammars have no standalone
        // link/links directive; LINK is a node ID, unlike sequence/class links.
        // Bind this exception to the actual parsed type; preserve the existing
        // case-insensitive ban otherwise, before any layout or callback.
        if (
          diagram.type !== "flowchart" &&
          diagram.type !== "flowchart-v2" &&
          diagram.type !== "swimlane" &&
          diagram.type !== "agentflow" &&
          /(?:^|[;\r\n])\s*links?\s/i.test(data.source)
        ) {
          throw new Error();
        }
        const record = (value) => {
          if (
            !value ||
            typeof value !== "object" ||
            Object.getPrototypeOf(value) !== Object.prototype
          ) {
            throw new Error();
          }
          return value;
        };
        const finite = (value) => {
          if (typeof value !== "number" || !Number.isFinite(value)) throw new Error();
          return value;
        };
        const list = (value) => {
          if (!Array.isArray(value) || value.length === 0 || value.length > 250) throw new Error();
          return value;
        };
        // Mirror only the pinned d3-array 3.2.4 default ten-tick calculation,
        // without allocating its array. Finite endpoints alone are insufficient:
        // overflowing spans or subnormal reciprocal steps yield empty/infinite
        // ticks and unsafe axis padding in Tiny. Requalify this with engine pins.
        const axisTicks = (axis) => {
          record(axis);
          if (axis.type !== "linear" || typeof axis.title !== "string") throw new Error();
          let start = finite(axis.min);
          let stop = finite(axis.max);
          if (start === stop) return 1;
          if (stop < start) [start, stop] = [stop, start];
          const step = finite((stop - start) / 10);
          if (step <= 0) throw new Error();
          const power = Math.floor(Math.log10(step));
          const magnitude = finite(10 ** power);
          if (magnitude <= 0) throw new Error();
          const error = finite(step / magnitude);
          const factor =
            error >= Math.sqrt(50)
              ? 10
              : error >= Math.sqrt(10)
                ? 5
                : error >= Math.sqrt(2)
                  ? 2
                  : 1;
          const reciprocal = power < 0;
          const increment = finite(reciprocal ? 10 ** -power / factor : magnitude * factor);
          if (increment <= 0) throw new Error();
          let first = Math.round(finite(reciprocal ? start * increment : start / increment));
          let last = Math.round(finite(reciprocal ? stop * increment : stop / increment));
          if ((reciprocal ? first / increment : first * increment) < start) first++;
          if ((reciprocal ? last / increment : last * increment) > stop) last--;
          const count = finite(last - first + 1);
          if (!Number.isInteger(count) || count < 1 || count > 250) throw new Error();
          // Also prove every eventual tick coordinate is finite without retaining
          // attacker-sized intermediate arrays. The loop has an admitted bound.
          for (let index = first; index <= last; index++) {
            finite(reciprocal ? index / increment : index * increment);
            // Large endpoints can round index + 1 back to index. Do not hang.
            if (index + 1 === index && index < last) throw new Error();
            if (index === last) break;
          }
          return count;
        };
        const within = (value, axis) =>
          value >= Math.min(axis.min, axis.max) && value <= Math.max(axis.min, axis.max);
        const xySize = () => {
          const chart = record(db.getXYChartData());
          const xAxis = record(chart.xAxis);
          const yTicks = axisTicks(chart.yAxis);
          const plots = list(chart.plots);
          let categories;
          let xTicks;
          if (xAxis.type === "band") {
            if (typeof xAxis.title !== "string") throw new Error();
            const labels = list(xAxis.categories);
            // for-of also checks sparse holes; Array.some would skip them.
            for (const label of labels) if (typeof label !== "string") throw new Error();
            categories = new Set(labels);
            xTicks = labels.length;
          } else {
            xTicks = axisTicks(xAxis);
          }
          let points = 0;
          let pointLabels = 0;
          for (const plot of plots) {
            record(plot);
            if ((plot.type !== "bar" && plot.type !== "line") || typeof plot.title !== "string")
              throw new Error();
            const values = list(plot.data);
            points += values.length;
            if (points > 250) throw new Error();
            // Tiny retains original point labels even when band data truncates.
            // Bound those separately rather than relying on visible point count.
            if (plot.pointLabels !== undefined) {
              if (!Array.isArray(plot.pointLabels)) throw new Error();
              pointLabels += plot.pointLabels.length;
              if (pointLabels > 250) throw new Error();
              for (const label of plot.pointLabels)
                if (typeof label !== "string") throw new Error();
            }
            for (const pair of values) {
              if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string")
                throw new Error();
              const value = finite(pair[1]);
              if (!within(value, chart.yAxis)) throw new Error();
              if (categories) {
                if (!categories.has(pair[0])) throw new Error();
              } else {
                // The pinned database stringifies numeric X positions. Empty
                // strings are not numeric positions, despite Number("") === 0.
                if (pair[0].trim() === "" || !within(finite(Number(pair[0])), xAxis))
                  throw new Error();
              }
            }
          }
          return [xTicks + yTicks + plots.length, points];
        };
        const pieSize = () => {
          const sections = db.getSections();
          if (
            !(sections instanceof Map) ||
            sections.size === 0 ||
            sections.size > 250 ||
            typeof db.getShowData() !== "boolean"
          )
            throw new Error();
          let total = 0;
          for (const [label, value] of sections) {
            if (typeof label !== "string" || finite(value) < 0) throw new Error();
            total = finite(total + value);
          }
          if (total <= 0) throw new Error();
          // Tiny omits slices below1% from geometry but retains their legends.
          // Validate the actual visible angular denominator, not just total.
          let visibleTotal = 0;
          for (const value of sections.values()) {
            if ((value / total) * 100 >= 1) visibleTotal = finite(visibleTotal + value);
          }
          if (visibleTotal <= 0 || finite((2 * Math.PI) / visibleTotal) <= 0) throw new Error();
          return [sections.size, sections.size];
        };
        const ganttSize = () => {
          if (!ganttSource) throw new Error();
          const model = ganttSource;
          const sections = db.getSections();
          const links = db.getLinks();
          if (!Array.isArray(sections) || sections.length !== model.sections.length)
            throw new Error();
          for (const [index, value] of sections.entries())
            if (typeof value !== "string" || value.trim() !== model.sections[index])
              throw new Error();
          if (
            !(links instanceof Map) ||
            links.size !== 0 ||
            db.getDateFormat().trim() !== model.format ||
            db.getAxisFormat().trim() !== model.axis ||
            db.getTickInterval() !== model.tick ||
            db.getTodayMarker() !== model.marker ||
            db.getWeekday() !== model.weekday ||
            db.endDatesAreInclusive() !== model.inclusive ||
            db.topAxisEnabled() !== false ||
            db.getDisplayMode() !== "" ||
            !Array.isArray(db.getExcludes()) ||
            db.getExcludes().length !== 0 ||
            !Array.isArray(db.getIncludes()) ||
            db.getIncludes().length !== 0
          )
            throw new Error();
          const DAY = 86400000;
          const MAX_SPAN = 3660 * DAY;
          const date = (value) => {
            if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value))
              throw new Error();
            const [year, month, day] = value.split("-").map(Number);
            const utc = new Date(Date.UTC(year, month - 1, day));
            if (
              utc.getUTCFullYear() !== year ||
              utc.getUTCMonth() !== month - 1 ||
              utc.getUTCDate() !== day
            )
              throw new Error();
            // An absent format uses Tiny's native ISO-to-Date fallback (UTC).
            // Explicit YYYY-MM-DD instead uses its strict local Dayjs parser.
            const result = model.format ? new Date(year, month - 1, day) : utc;
            finite(result.getTime());
            if (
              model.format &&
              (result.getFullYear() !== year ||
                result.getMonth() !== month - 1 ||
                result.getDate() !== day)
            )
              throw new Error();
            return result;
          };
          const addDays = (value, days) => {
            const result = new Date(value);
            result.setDate(result.getDate() + days);
            finite(result.getTime());
            return result;
          };
          const expected = new Map();
          const identities = new Map();
          let first = Infinity;
          let last = -Infinity;
          for (const task of model.tasks) {
            const native = record(db.findTaskById(task.id));
            const raw = record(native.raw);
            const startData = record(raw.startTime);
            const endData = record(raw.endTime);
            if (
              native.id !== task.id ||
              native.task.trim() !== task.label ||
              native.section.trim() !== task.section ||
              native.type !== native.section ||
              native.prevTaskId !== task.previous ||
              native.order !== task.order ||
              native.processed !== false ||
              native.manualEndTime !== false ||
              native.renderEndTime !== null ||
              !Array.isArray(native.classes) ||
              native.classes.length !== 0 ||
              typeof raw.data !== "string" ||
              raw.data.trim() !== task.data ||
              endData.data !== task.end ||
              (task.start
                ? startData.type !== "getStartDate" || startData.startData !== task.start
                : startData.type !== "prevTaskEnd" || startData.id !== task.previous)
            )
              throw new Error();
            for (const flag of ["active", "done", "crit", "milestone", "vert"])
              if (native[flag] !== (task.flags.has(flag) ? true : undefined)) throw new Error();
            let start;
            if (!task.start) start = new Date(expected.get(task.previous).end);
            else if (task.after.length)
              start = new Date(Math.max(...task.after.map((id) => expected.get(id).end)));
            else start = date(task.start);
            let end;
            let manual = false;
            if (task.until.length)
              end = new Date(Math.min(...task.until.map((id) => expected.get(id).start)));
            else if (/^[1-9]\d{3}-\d{2}-\d{2}$/.test(task.end)) {
              // Without a dateFormat the pinned end-date parser silently keeps
              // the start. Refuse that ambiguous shape rather than fabricating
              // an explicit-date duration on the user's behalf.
              if (!model.format) throw new Error();
              end = date(task.end);
              if (model.inclusive) end = addDays(end, 1);
              manual = true;
            } else {
              const duration = /^(\d+)(ms|[wdhms])$/.exec(task.end);
              if (!duration) throw new Error();
              const quantity = Number(duration[1]);
              if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error();
              const unit = duration[2];
              const amount =
                quantity * { w: 7 * DAY, d: DAY, h: 3600000, m: 60000, s: 1000, ms: 1 }[unit];
              if (!Number.isFinite(amount) || amount > MAX_SPAN) throw new Error();
              // Dayjs day/week adds use local calendar arithmetic, while shorter
              // units add elapsed milliseconds. Preserve DST semantics exactly.
              end =
                unit === "d" || unit === "w"
                  ? addDays(start, quantity * (unit === "w" ? 7 : 1))
                  : new Date(start.getTime() + amount);
            }
            const startTime = finite(start.getTime());
            const endTime = finite(end.getTime());
            if (endTime <= startTime || endTime - startTime > MAX_SPAN) throw new Error();
            first = Math.min(first, startTime);
            last = Math.max(last, endTime);
            if (last - first > MAX_SPAN) throw new Error();
            expected.set(task.id, { start: startTime, end: endTime, manual });
            identities.set(task.id, { native, task, raw, startData, endData });
          }
          // Mirror only the pinned d3-time 3.1.0 adaptive ten-tick selection and
          // its local calendar floor/filter/offset contract, without retaining
          // any tick array. Count actual default ticks with a bounded monotonic
          // iterator; a library upgrade must requalify this source contract.
          const defaultTicks = () => {
            const YEAR = 365 * DAY;
            const intervals = [
              ["second", 1, 1000],
              ["second", 5, 5000],
              ["second", 15, 15000],
              ["second", 30, 30000],
              ["minute", 1, 60000],
              ["minute", 5, 300000],
              ["minute", 15, 900000],
              ["minute", 30, 1800000],
              ["hour", 1, 3600000],
              ["hour", 3, 10800000],
              ["hour", 6, 21600000],
              ["hour", 12, 43200000],
              ["day", 1, DAY],
              ["day", 2, 2 * DAY],
              ["week", 1, 7 * DAY],
              ["month", 1, 30 * DAY],
              ["month", 3, 90 * DAY],
              ["year", 1, YEAR],
            ];
            const tickStep = (start, stop) => {
              const step = finite((stop - start) / 10);
              if (step <= 0) throw new Error();
              const power = Math.floor(Math.log10(step));
              const magnitude = finite(10 ** power);
              const error = finite(step / magnitude);
              return finite(
                magnitude *
                  (error >= Math.sqrt(50)
                    ? 10
                    : error >= Math.sqrt(10)
                      ? 5
                      : error >= Math.sqrt(2)
                        ? 2
                        : 1),
              );
            };
            const target = (last - first) / 10;
            let position = 0;
            while (position < intervals.length && intervals[position][2] <= target) position++;
            let unit;
            let every;
            if (position === 0) [unit, every] = ["millisecond", Math.max(tickStep(first, last), 1)];
            else if (position === intervals.length)
              [unit, every] = ["year", tickStep(first / YEAR, last / YEAR)];
            else
              [unit, every] =
                intervals[
                  target / intervals[position - 1][2] < intervals[position][2] / target
                    ? position - 1
                    : position
                ];
            if (
              !Number.isSafeInteger(every) ||
              every < 1 ||
              (every > 250 && unit !== "millisecond")
            )
              throw new Error();
            let cursor = new Date(first - 1);
            const floor = () => {
              const before = finite(cursor.getTime());
              if (unit === "millisecond") cursor.setTime(Math.floor(before / every) * every);
              else if (unit === "second") cursor.setTime(before - cursor.getMilliseconds());
              else if (unit === "minute")
                cursor.setTime(before - cursor.getMilliseconds() - cursor.getSeconds() * 1000);
              else if (unit === "hour")
                cursor.setTime(
                  before -
                    cursor.getMilliseconds() -
                    cursor.getSeconds() * 1000 -
                    cursor.getMinutes() * 60000,
                );
              else {
                if (unit === "week") cursor.setDate(cursor.getDate() - cursor.getDay());
                if (unit === "month") cursor.setDate(1);
                if (unit === "year") {
                  cursor.setFullYear(Math.floor(cursor.getFullYear() / every) * every);
                  cursor.setMonth(0, 1);
                }
                cursor.setHours(0, 0, 0, 0);
              }
              finite(cursor.getTime());
            };
            const matches = () => {
              const field =
                unit === "second"
                  ? cursor.getUTCSeconds()
                  : unit === "minute"
                    ? cursor.getMinutes()
                    : unit === "hour"
                      ? cursor.getHours()
                      : unit === "day"
                        ? cursor.getDate() - 1
                        : unit === "month"
                          ? cursor.getMonth()
                          : 0;
              return field % every === 0;
            };
            const offset = () => {
              const previous = cursor.getTime();
              if (unit === "millisecond") cursor.setTime(previous + every);
              else if (unit === "second") cursor.setTime(previous + 1000);
              else if (unit === "minute") cursor.setTime(previous + 60000);
              else if (unit === "hour") cursor.setTime(previous + 3600000);
              else if (unit === "day") cursor.setDate(cursor.getDate() + 1);
              else if (unit === "week") cursor.setDate(cursor.getDate() + 7);
              else if (unit === "month") cursor.setMonth(cursor.getMonth() + 1);
              else cursor.setFullYear(cursor.getFullYear() + every);
              if (!Number.isFinite(cursor.getTime()) || cursor.getTime() <= previous)
                throw new Error();
            };
            // Native filtered floor walks back to an eligible calendar field;
            // these pinned default fields have at most31 candidates per cycle.
            const filteredFloor = () => {
              for (let attempt = 0; attempt < 64; attempt++) {
                floor();
                if (matches()) return;
                cursor.setTime(cursor.getTime() - 1);
              }
              throw new Error();
            };
            filteredFloor();
            const advance = () => {
              const previous = cursor.getTime();
              for (let attempt = 0; attempt < 64; attempt++) {
                offset();
                if (matches()) {
                  filteredFloor();
                  if (cursor.getTime() <= previous) throw new Error();
                  return;
                }
              }
              throw new Error();
            };
            advance();
            let count = 0;
            while (cursor.getTime() <= last) {
              if (++count > 250) throw new Error();
              advance();
            }
            if (count === 0) throw new Error();
            return count;
          };
          // Custom calendar .every(n) filters fields that reset each month/year;
          // dividing duration by n would undercount (365day still emits day1).
          // Conservatively count the BASE calendar interval, ignoring n, with a
          // bounded monotonic iterator before any native tick array allocation.
          let ticks = model.tick ? 0 : defaultTicks();
          if (model.tick) {
            const unit = /[a-z]+$/.exec(model.tick)[0];
            const every = Number.parseInt(model.tick, 10);
            if (unit === "day" || unit === "week" || unit === "month") {
              let cursor = new Date(first);
              cursor.setHours(0, 0, 0, 0);
              if (unit === "month") cursor.setDate(1);
              // Account for both enclosing boundary ticks without assuming the
              // weekday or calendar field filter. Each iteration must advance.
              ticks = 2;
              while (cursor.getTime() <= last) {
                if (++ticks > 250) throw new Error();
                const previous = cursor.getTime();
                if (unit === "month") cursor.setMonth(cursor.getMonth() + 1);
                else cursor.setDate(cursor.getDate() + (unit === "week" ? 7 : 1));
                if (!Number.isFinite(cursor.getTime()) || cursor.getTime() <= previous)
                  throw new Error();
              }
            } else {
              const step = { millisecond: every, second: 1000, minute: 60000, hour: 3600000 }[unit];
              ticks = Math.ceil((last - first) / step) + 2;
              if (!Number.isSafeInteger(ticks) || ticks > 250) throw new Error();
            }
          }
          if (model.tasks.length + model.sections.length + ticks > 250) throw new Error();
          // Only now may Tiny resolve native dates. Bind the resulting list to
          // the exact raw objects and independently predicted calendar values;
          // unfamiliar/sparse/duplicate/replaced contracts cannot bypass limits.
          const tasks = db.getTasks();
          if (!Array.isArray(tasks) || tasks.length !== model.tasks.length) throw new Error();
          const seen = new Set();
          for (const task of tasks) {
            record(task);
            const prediction = expected.get(task.id);
            const witness = identities.get(task.id);
            if (
              !prediction ||
              !witness ||
              seen.has(task.id) ||
              task !== witness.native ||
              task.task.trim() !== witness.task.label ||
              task.section.trim() !== witness.task.section ||
              task.type !== task.section ||
              task.prevTaskId !== witness.task.previous ||
              task.order !== witness.task.order ||
              task.raw !== witness.raw ||
              task.raw.startTime !== witness.startData ||
              task.raw.endTime !== witness.endData ||
              task.raw.data.trim() !== witness.task.data ||
              task.raw.endTime.data !== witness.task.end ||
              (witness.task.start
                ? task.raw.startTime.type !== "getStartDate" ||
                  task.raw.startTime.startData !== witness.task.start
                : task.raw.startTime.type !== "prevTaskEnd" ||
                  task.raw.startTime.id !== witness.task.previous) ||
              task.processed !== true ||
              task.manualEndTime !== prediction.manual ||
              !(task.startTime instanceof Date) ||
              !(task.endTime instanceof Date) ||
              finite(task.startTime.getTime()) !== prediction.start ||
              finite(task.endTime.getTime()) !== prediction.end ||
              task.renderEndTime !== null ||
              !Array.isArray(task.classes) ||
              task.classes.length !== 0
            )
              throw new Error();
            for (const flag of ["active", "done", "crit", "milestone", "vert"])
              if (task[flag] !== (witness.task.flags.has(flag) ? true : undefined))
                throw new Error();
            seen.add(task.id);
          }
          return [tasks.length + sections.length + ticks, 0];
        };
        const size = (items) => {
          if (items instanceof Map || items instanceof Set) return items.size;
          if (Array.isArray(items)) return items.length;
          if (items && typeof items === "object") {
            const prototype = Object.getPrototypeOf(items);
            if (prototype === Object.prototype || prototype === null) {
              return Object.keys(items).length;
            }
          }
          // A renderer upgrade changing its database API is not evidence of
          // an empty graph. Reject unfamiliar shapes rather than bypass limits.
          throw new Error();
        };
        const layoutSize = () => {
          const graph = db.getData();
          if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
            throw new Error();
          }
          // Source spellings can encode YAML/JSON property names. Bind the
          // image prohibition to the parsed graph as well: Mermaid 12.0.0
          // turns an img-bearing flowchart vertex into imageSquare and starts
          // loading its image during layout, before our output sanitizer runs.
          if (
            graph.nodes.some(
              (node) =>
                !node ||
                typeof node !== "object" ||
                node.img != null ||
                node.shape === "image" ||
                node.shape === "imageSquare",
            )
          )
            throw new Error();
          return [graph.nodes.length, graph.edges.length];
        };
        let nodes;
        let edges;
        switch (diagram.type) {
          case "flowchart":
          case "flowchart-v2":
            // The pinned database synthesizes layout nodes for subgraphs.
            // Counting only getVertices() would omit those containers.
            [nodes, edges] = layoutSize();
            break;
          case "sequence":
            // Participant boxes are rendered containers, not actor entries.
            nodes = size(db.getActors()) + size(db.getBoxes());
            edges = size(db.getMessages());
            break;
          case "class":
          case "classDiagram":
            // getData() includes every nested namespace, lollipop-interface
            // node, and note-attachment edge as well as ordinary classes and
            // relations. These are all work for the layout engine, including
            // containers with only a few actual class declarations.
            [nodes, edges] = layoutSize();
            break;
          case "er":
            nodes = size(db.getEntities());
            edges = size(db.getRelationships());
            break;
          case "state":
          case "stateDiagram":
            // State diagrams expose the flattened graph after parsing. This
            // includes nested groups and synthesized start/end nodes.
            [nodes, edges] = layoutSize();
            break;
          case "xychart":
            [nodes, edges] = xySize();
            break;
          case "pie":
            [nodes, edges] = pieSize();
            break;
          case "gantt":
            [nodes, edges] = ganttSize();
            break;
          default: {
            const familySize =
              globalThis.cafeMermaidFamilySize(diagram.type, db, data.source) ??
              globalThis.cafeMermaidExtendedFamilySize(diagram.type, db, data.source);
            if (!familySize) throw new Error();
            [nodes, edges] = familySize;
          }
        }
        if (nodes > 250 || edges > 250) throw new Error();
        const { svg: renderedSvg } = await mermaid.render("cafe-diagram", data.source);
        if (
          typeof renderedSvg !== "string" ||
          renderedSvg.length > 2097152 ||
          new TextEncoder().encode(renderedSvg).length > 2097152
        )
          throw new Error();
        // Pinned event modeling has no SVG-label option. Its exact native
        // b/BR/code label structure is converted to bounded text/tspans solely
        // in this opaque frame. Arbitrary HTML/attributes/geometry are refused;
        // no foreignObject, styles or resource authority reach the app realm.
        // This does not loosen the independent parent SVG sanitizer.
        const imageSvg =
          diagram.type === "eventmodeling"
            ? globalThis.cafeMermaidEventModelingSvgLabels(renderedSvg)
            : renderedSvg;
        // The pinned native info renderer omits viewBox despite declaring a
        // fixed 400x100 viewport. Qualify only its exact native version output;
        // all other diagrams still require their own native viewBox unchanged.
        const svg =
          diagram.type === "info" ? globalThis.cafeMermaidInfoSvgViewport(imageSvg) : imageSvg;
        // No bindFunctions: callbacks and interactive links are not part of
        // Cafe's diagram contract. The parent validates and sanitizes again.
        port.postMessage({ id: data.id, svg });
      } catch {
        // Never send parser errors: they can contain a private source excerpt.
        port.postMessage({ id: data?.id, failed: true });
      } finally {
        port.close();
      }
    };
    port.start();
  });
})();
