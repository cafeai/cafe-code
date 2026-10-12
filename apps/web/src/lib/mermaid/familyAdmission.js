// Loaded as local script text only inside the opaque Mermaid frame. These
// contracts are deliberately tied to the pinned Mermaid 12.0.0 databases;
// changed accessors are not evidence that an unfamiliar graph is empty.
(() => {
  const LIMIT = 250;
  const fail = () => {
    throw new Error();
  };
  const text = (value) => {
    if (typeof value !== "string") fail();
    return value;
  };
  const record = (value) => {
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
      fail();
    return value;
  };
  const finite = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) fail();
    return value;
  };
  const integer = (value, min = 0, max = LIMIT) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail();
    return value;
  };
  const array = (value, min = 0) => {
    if (!Array.isArray(value) || value.length < min || value.length > LIMIT) fail();
    // Array holes must not bypass per-entry checks. All following loops use
    // for-of, which observes a sparse slot as undefined rather than skipping it.
    return value;
  };
  const map = (value) => {
    if (!(value instanceof Map) || value.size > LIMIT) fail();
    return value;
  };
  const strings = (value) => {
    for (const item of array(value)) text(item);
    return value;
  };
  const budget = (nodes, edges) => {
    integer(nodes, 1);
    integer(edges);
    return [nodes, edges];
  };
  const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
  const identity = (value) => {
    if (!text(value) || reserved.has(value)) fail();
    return value;
  };
  const safeStyles = (value) => {
    for (const item of strings(value)) {
      // Source CSS cannot request resources or conceal them with comments or
      // escapes, even though CSP and final image sanitization remain separate
      // defenses. Ordinary fill/stroke/color declarations stay supported.
      if (/[\\@]|\/\*|url\s*\(|(?:expression|image|image-set)\s*\(/i.test(item)) fail();
    }
  };
  const classes = (value) => {
    for (const [name, item] of map(value)) {
      identity(name);
      record(item);
      for (const field of ["styles", "textStyles"])
        if (item[field] !== undefined) safeStyles(item[field]);
    }
  };

  globalThis.cafeMermaidFamilyPreflight = (source) => {
    text(source);
    const family =
      /^(?:\s|%%[^\r\n]*(?:\r?\n|$))*(block(?:-beta)?|packet(?:-beta)?|journey|timeline)\b/.exec(
        source,
      )?.[1];
    if (!family) return;
    const lines = source
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trimStart().startsWith("%%"));
    // Journey/timeline getTasks is a resolving accessor, with a bounded but
    // repeated compile loop. Bound raw declarations before its first call.
    if (family === "journey" || family === "timeline") {
      if (lines.length > LIMIT) fail();
      return;
    }
    if (family.startsWith("block")) {
      // setHierarchy expands space:N into N real objects DURING parsing. A
      // parsed-size check alone is too late for a gigantic spacer allocation.
      // Widths are grammar numbers, not CSS/style values or label contents.
      let spacers = 0;
      for (const match of source.matchAll(
        /\bspace(?:\s*:\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?))?\b/g,
      )) {
        spacers += integer(match[1] === undefined ? 1 : Number(match[1]), 1);
        integer(spacers, 0);
      }
      let metadata = 0;
      for (const match of source.matchAll(/(?:^|[;\r\n])\s*columns\s+([^\s;]+)/g)) {
        integer(Number(match[1]), 1);
        integer(++metadata, 0);
      }
      // Node/composite column spans do not allocate spacers but they drive
      // nested layout loops and coordinate multiplication. Refuse huge spans.
      for (const match of source.matchAll(/(?:\]|\)|\}|\bblock\s+[\w-]+)\s*:\s*(\d+)/g)) {
        integer(Number(match[1]), 1);
        integer(++metadata, 0);
      }
      return;
    }
    // Packet population subdivides a huge bit field into up to 10,000 native
    // rows. Admit at most 250 default 32-bit rows before this allocation. The
    // final parsed budget additionally counts every row and every fragment.
    let next = 0;
    let fragments = 0;
    // The pinned Packet grammar requires EOL after each field, but NOT after
    // its packet/packet-beta header. The first field can therefore share that
    // header line. Remove only the header token in this local admission view;
    // skipping the whole first line would permit a giant field to reach the
    // native allocating population pass before any row/fragment bound.
    for (const [index, rawLine] of lines.entries()) {
      const line = index === 0 ? rawLine.replace(/^\s*packet(?:-beta)?\b/, "") : rawLine;
      const field = /^\s*(?:(\d+)\s*-\s*(\d+)|(\d+)|\+\s*(\d+))\s*:\s*/.exec(line);
      if (!field) continue; // Native grammar, not a source rewrite, decides validity.
      const previous = next;
      if (field[4] !== undefined) next += integer(Number(field[4]), 1, 8000);
      else {
        const start = integer(Number(field[1] ?? field[3]), 0, 7999);
        const end = integer(Number(field[2] ?? field[3]), start, 7999);
        if (start !== next) fail();
        next = end + 1;
      }
      integer(next, 1, 8000);
      // Mirror the fixed native 32-bit subdivision without allocating rows.
      // Contiguous start/end witnesses above make this arithmetic exact even
      // for a field crossing several row boundaries. Source declarations that
      // already exceed the final fragment budget must never reach population.
      fragments += Math.floor((next - 1) / 32) - Math.floor(previous / 32) + 1;
      budget(Math.ceil(next / 32) + fragments, fragments);
    }
  };

  const journey = (db) => {
    const tasks = array(db.getTasks(), 1);
    const sections = strings(db.getSections());
    const actors = strings(db.getActors());
    const names = new Set(actors);
    if (names.size !== actors.length) fail();
    for (const actor of actors) identity(actor);
    let placements = 0;
    for (const task of tasks) {
      record(task);
      text(task.task);
      text(task.section);
      if (task.type !== task.section || (task.section && !sections.includes(task.section))) fail();
      // The native renderer places a score marker on a fixed 0..5 rail.
      if (finite(task.score) < 0 || task.score > 5) fail();
      for (const actor of strings(task.people)) if (!names.has(actor)) fail();
      placements += task.people.length;
      if (placements > LIMIT) fail();
    }
    return budget(tasks.length + sections.length + actors.length, placements);
  };

  const quadrant = (db) => {
    // This accessor performs only fixed-size coordinate arithmetic plus one
    // pass over parsed points; it does not invoke DOM measurement or a solver.
    const data = record(db.getQuadrantData());
    const points = array(data.points);
    const quadrants = array(data.quadrants, 4);
    if (quadrants.length !== 4) fail();
    const labels = array(data.axisLabels);
    const borders = array(data.borderLines);
    const label = (item) => {
      record(item);
      text(item.text);
      for (const field of ["x", "y", "fontSize", "rotation"]) finite(item[field]);
      if (item.fontSize <= 0 || item.fontSize > 250) fail();
    };
    for (const item of points) {
      record(item);
      for (const field of ["x", "y", "radius"]) finite(item[field]);
      if (item.radius <= 0 || item.radius > 250) fail();
      // Raw quadrant coordinates are native unit values. Bind their projected
      // positions to the fixed code-owned 500x500 chart rather than accepting
      // an unfamiliar database returning arbitrary finite outside-image data.
      if (item.x < 0 || item.x > 500 || item.y < 0 || item.y > 500) fail();
      label(item.text);
    }
    for (const item of quadrants) {
      record(item);
      for (const field of ["x", "y", "width", "height"]) finite(item[field]);
      if (item.width <= 0 || item.height <= 0) fail();
      label(item.text);
    }
    for (const item of labels) label(item);
    for (const item of borders) {
      record(item);
      for (const field of ["x1", "y1", "x2", "y2", "strokeWidth"]) finite(item[field]);
    }
    if (data.title) label(data.title);
    return budget(
      points.length + quadrants.length + labels.length + (data.title ? 1 : 0),
      borders.length,
    );
  };

  const requirement = (db) => {
    const requirements = map(db.getRequirements());
    const elements = map(db.getElements());
    const relationships = array(db.getRelationships());
    const names = new Set();
    for (const collection of [requirements, elements]) {
      for (const [name, item] of collection) {
        identity(name);
        record(item);
        if (item.name !== name || names.has(name)) fail();
        names.add(name);
        text(item.type);
        safeStyles(item.cssStyles);
        strings(item.classes);
      }
    }
    const types = new Set([
      "Requirement",
      "Functional Requirement",
      "Interface Requirement",
      "Performance Requirement",
      "Physical Requirement",
      "Design Constraint",
    ]);
    for (const item of requirements.values()) {
      if (
        !types.has(item.type) ||
        !["", "Low", "Medium", "High"].includes(item.risk) ||
        !["", "Analysis", "Demonstration", "Inspection", "Test"].includes(item.verifyMethod)
      )
        fail();
      text(item.requirementId);
      text(item.text);
    }
    for (const item of elements.values()) text(item.docRef);
    const relationTypes = new Set([
      "contains",
      "copies",
      "derives",
      "satisfies",
      "verifies",
      "refines",
      "traces",
    ]);
    for (const relation of relationships) {
      record(relation);
      if (!names.has(relation.src) || !names.has(relation.dst) || !relationTypes.has(relation.type))
        fail();
    }
    classes(db.getClasses());
    return budget(names.size, relationships.length);
  };

  const git = (db) => {
    const commits = map(db.getCommits());
    const branches = map(db.getBranches());
    if (!["LR", "TB", "BT"].includes(db.getDirection())) fail();
    const options = record(db.getOptions());
    if (Object.keys(options).length) fail(); // Source options are configuration, not inert labels.
    let tags = 0;
    let parents = 0;
    const sequences = new Set();
    for (const [id, commit] of commits) {
      identity(id);
      record(commit);
      if (commit.id !== id || !branches.has(commit.branch)) fail();
      integer(commit.seq, 0);
      if (sequences.has(commit.seq)) fail();
      sequences.add(commit.seq);
      integer(commit.type, 0, 4);
      text(commit.message);
      tags += strings(commit.tags).length;
      for (const parent of strings(commit.parents)) {
        const previous = commits.get(parent);
        if (!previous || previous.seq >= commit.seq) fail();
        parents++;
      }
      if (tags > LIMIT || parents > LIMIT) fail();
    }
    for (const [name, head] of branches) {
      identity(name);
      if (head !== null && !commits.has(head)) fail();
    }
    return budget(commits.size + branches.size + tags, parents);
  };

  const timeline = (db) => {
    const tasks = array(db.getTasks(), 1);
    const sections = strings(db.getSections());
    const ids = new Set();
    let events = 0;
    for (const task of tasks) {
      record(task);
      integer(task.id);
      if (ids.has(task.id)) fail();
      ids.add(task.id);
      text(task.task);
      text(task.section);
      if (task.type !== task.section || (task.section && !sections.includes(task.section))) fail();
      if (finite(task.score) !== 0) fail();
      events += strings(task.events).length;
      if (events > LIMIT) fail();
    }
    return budget(tasks.length + sections.length + events, events);
  };

  const sankey = (db) => {
    // Native d3-sankey traverses source/target links repeatedly to resolve
    // depths and heights. Prove an acyclic, positive finite network first.
    const nodes = array(db.getNodes(), 1);
    const links = array(db.getLinks(), 1);
    const names = new Map();
    const adjacency = new Map();
    const indegree = new Map();
    const sums = new Map();
    for (const node of nodes) {
      // SankeyNode/SankeyLink are pinned class instances, not plain records.
      if (!node || typeof node !== "object") fail();
      identity(node.ID);
      if (names.has(node.ID)) fail();
      names.set(node.ID, node);
      adjacency.set(node.ID, []);
      indegree.set(node.ID, 0);
      sums.set(node.ID, { incoming: 0, outgoing: 0 });
    }
    for (const link of links) {
      if (
        !link ||
        typeof link !== "object" ||
        names.get(link.source?.ID) !== link.source ||
        names.get(link.target?.ID) !== link.target ||
        link.source === link.target
      )
        fail();
      const value = finite(link.value);
      if (value <= 0 || !Number.isFinite(400 / value) || 400 / value <= 0) fail();
      adjacency.get(link.source.ID).push(link.target.ID);
      indegree.set(link.target.ID, indegree.get(link.target.ID) + 1);
      sums.get(link.source.ID).outgoing = finite(sums.get(link.source.ID).outgoing + value);
      sums.get(link.target.ID).incoming = finite(sums.get(link.target.ID).incoming + value);
    }
    for (const { incoming, outgoing } of sums.values()) {
      const total = Math.max(incoming, outgoing);
      // Native relaxation also multiplies each weight by its layer distance
      // and 400px coordinates before summing. Bound those intermediates, not
      // just the reciprocal scale; all 250 layers/links fit this margin.
      if (
        total <= 0 ||
        !Number.isFinite(400 / total) ||
        400 / total <= 0 ||
        !Number.isFinite(1000000 * total)
      )
        fail();
    }
    const ready = [...indegree].filter(([, degree]) => degree === 0).map(([name]) => name);
    let visited = 0;
    while (ready.length) {
      const name = ready.pop();
      visited++;
      for (const next of adjacency.get(name)) {
        const degree = indegree.get(next) - 1;
        indegree.set(next, degree);
        if (degree === 0) ready.push(next);
      }
    }
    if (visited !== names.size) fail();
    return budget(nodes.length, links.length);
  };

  const block = (db) => {
    const blocks = array(db.getBlocksFlat(), 1);
    const edges = array(db.getEdges());
    const names = new Map();
    for (const item of blocks) {
      record(item);
      const id = identity(item.id);
      if (names.has(id) || db.getBlock(id) !== item) fail();
      names.set(id, item);
      text(item.type);
      if (item.label !== undefined) text(item.label);
      for (const field of ["columns", "widthInColumns", "width"]) {
        // The pinned composite root uses -1 for ordinary automatic columns.
        // Its child count is independently bounded below, not an unbounded
        // source-controlled width. Other widths are strictly positive.
        if (item[field] !== undefined && !(field === "columns" && item[field] === -1))
          integer(item[field], 1);
      }
      if (item.styles !== undefined) safeStyles(item.styles);
      if (item.classes !== undefined) strings(item.classes);
      if (item.img != null || item.icon != null || item.type === "image") fail();
    }
    // getBlocksFlat retains the original spacer as well as every expanded
    // spacer child. Count ALL of them, but walk rendered roots by exact object
    // identity to exclude cyclic/dangling hierarchy data before native recursion.
    const stack = [...array(db.getBlocks())].map((node) => ({ node, depth: 0 }));
    const seen = new Set();
    while (stack.length) {
      const { node, depth } = stack.pop();
      if (!node || names.get(node.id) !== node || seen.has(node) || depth > LIMIT) fail();
      seen.add(node);
      if (node.children !== undefined)
        for (const child of array(node.children)) stack.push({ node: child, depth: depth + 1 });
    }
    for (const edge of edges) {
      record(edge);
      if (!names.has(edge.start) || !names.has(edge.end) || edge.type !== "edge") fail();
      text(edge.label);
    }
    classes(db.getClasses());
    return budget(blocks.length, edges.length);
  };

  const packet = (db) => {
    const rows = array(db.getPacket(), 1);
    let next = 0;
    let fragments = 0;
    for (const row of rows) {
      for (const field of array(row, 1)) {
        record(field);
        const start = integer(field.start, 0, 7999);
        const end = integer(field.end, start, 7999);
        const bits = integer(field.bits, 1, 32);
        if (
          start !== next ||
          end - start + 1 !== bits ||
          Math.floor(start / 32) !== Math.floor(end / 32)
        )
          fail();
        text(field.label);
        next = end + 1;
        fragments++;
        if (fragments > LIMIT) fail();
      }
    }
    return budget(rows.length + fragments, fragments);
  };

  const kanban = (db) => {
    const graph = record(db.getData());
    const nodes = array(graph.nodes, 1);
    const edges = array(graph.edges);
    if (edges.length) fail();
    const sections = array(db.getSections(), 1);
    const names = new Map();
    for (const node of nodes) {
      record(node);
      identity(node.id);
      if (names.has(node.id)) fail();
      names.set(node.id, node);
      text(node.label);
      if (node.shape !== (node.isGroup ? "kanbanSection" : "kanbanItem")) fail();
      if (node.img != null || node.icon != null || node.link != null || node.ticket != null) fail();
      if (node.cssStyles !== undefined) safeStyles(node.cssStyles);
      for (const field of ["assigned", "priority"])
        if (node[field] !== undefined) text(node[field]);
    }
    for (const node of nodes) {
      if (node.isGroup) {
        if (node.parentId !== undefined) fail();
        integer(node.level, 1);
      } else {
        // Native Kanban levels retain authored indentation columns, not a
        // normalized 1/2 depth. Preserve ordinary four/eight-space sources
        // while still proving a two-layer exact-parent card hierarchy.
        const parent = names.get(node.parentId);
        if (!parent?.isGroup) fail();
        integer(node.level, parent.level + 1);
      }
    }
    const seen = new Set();
    for (const section of sections) {
      record(section);
      if (!names.get(section.id)?.isGroup || seen.has(section.id)) fail();
      seen.add(section.id);
    }
    if (seen.size !== nodes.filter((node) => node.isGroup).length) fail();
    return budget(nodes.length, 0);
  };

  const radar = (db) => {
    const axes = array(db.getAxes(), 3);
    const curves = array(db.getCurves(), 1);
    const options = record(db.getOptions());
    const names = new Set();
    for (const axis of axes) {
      record(axis);
      identity(axis.name);
      text(axis.label);
      if (names.has(axis.name)) fail();
      names.add(axis.name);
    }
    const curveNames = new Set();
    let entries = 0;
    let maximum = -Infinity;
    for (const curve of curves) {
      record(curve);
      identity(curve.name);
      text(curve.label);
      if (curveNames.has(curve.name)) fail();
      curveNames.add(curve.name);
      const values = array(curve.entries, 1);
      if (values.length !== axes.length) fail();
      entries += values.length;
      if (entries > LIMIT) fail();
      for (const value of values) maximum = Math.max(maximum, finite(value));
    }
    const min = finite(options.min);
    const max = options.max == null ? maximum : finite(options.max);
    // Native scale divides by max-min. Equal, overflowed or subnormal domains
    // would create invalid path coordinates despite every input being finite.
    const span = finite(max - min);
    // relativeRadius multiplies radius*(clipped-min) BEFORE dividing by the
    // span. A finite reciprocal alone would admit overflowing large domains.
    if (
      span <= 0 ||
      !Number.isFinite(300 / span) ||
      300 / span <= 0 ||
      !Number.isFinite(300 * span)
    )
      fail();
    const ticks = integer(options.ticks, 1);
    if (
      !["circle", "polygon"].includes(options.graticule) ||
      typeof options.showLegend !== "boolean"
    )
      fail();
    return budget(axes.length + curves.length + ticks, entries);
  };

  const treemap = (db) => {
    const flat = array(db.getNodes(), 1);
    const root = record(db.getRoot());
    const known = new Set(flat);
    if (known.size !== flat.length) fail();
    // Native getRoot() synthesizes one invisible common parent that is not in
    // getNodes(). Its hierarchy allocation and child links still consume the
    // same budget; a retained empty-name node must not impersonate that wrapper.
    const synthetic = root.name === "" && !known.has(root);
    const roots = synthetic ? array(root.children, 1) : [root];
    const stack = [...roots];
    const seen = new Set();
    let total = 0;
    let minimum = Infinity;
    while (stack.length) {
      const node = record(stack.pop());
      if (!known.has(node) || seen.has(node)) fail();
      seen.add(node);
      text(node.name);
      if (node.children !== undefined) {
        if (node.value !== undefined) fail();
        for (const child of array(node.children, 1)) stack.push(child);
      } else {
        const value = finite(node.value);
        // D3 squarify computes sumValue*sumValue before applying alpha. Both
        // extreme overflow and subnormal squares must be refused pre-layout.
        if (
          value <= 0 ||
          !Number.isFinite(1000000 / value) ||
          1000000 / value <= 0 ||
          !Number.isFinite(value * value) ||
          value * value <= 0
        )
          fail();
        minimum = Math.min(minimum, value);
        total = finite(total + value);
      }
    }
    if (
      seen.size !== flat.length ||
      total <= 0 ||
      !Number.isFinite(1000000 / total) ||
      1000000 / total <= 0 ||
      !Number.isFinite(total * total) ||
      // Native alpha's denominator is parent.value*goldenRatio. Using2 is a
      // conservative witness for every positive subtree's smallest beta term;
      // vastly mismatched leaf scales must not underflow that term to zero.
      (minimum * minimum) / (total * 2) <= 0
    )
      fail();
    classes(db.getClasses());
    return budget(
      flat.length + (synthetic ? 1 : 0),
      flat.length - roots.length + (synthetic ? roots.length : 0),
    );
  };

  globalThis.cafeMermaidFamilySize = (type, db) => {
    switch (type) {
      case "journey":
        return journey(db);
      case "quadrantChart":
        return quadrant(db);
      case "requirement":
        return requirement(db);
      case "gitGraph":
        return git(db);
      case "timeline":
        return timeline(db);
      case "sankey":
        return sankey(db);
      case "block":
        return block(db);
      case "packet":
        return packet(db);
      case "kanban":
        return kanban(db);
      case "radar":
        return radar(db);
      case "treemap":
        return treemap(db);
      default:
        return undefined;
    }
  };
})();
